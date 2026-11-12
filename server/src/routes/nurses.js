// Staff actions on nurse records. Every query is limited to the user's district (scope / loadVisibleNurse).
import { Router } from 'express';
import { q, one, tx, nextNurseId } from '../db/pool.js';
import { config } from '../config.js';
import { httpError } from '../lib/errors.js';
import { csvCell } from '../lib/csv.js';
import {
  STATUSES, DOC_TYPES, TRANSITIONS, canTransition, normalizeDistrict, normalizeMobile, requiredDocTypes,
} from '../domain/workflow.js';
import { logEvent } from '../services/events.js';
import { queueMessage, inviteChannel, manualSmsBody } from '../services/messaging.js';
import { transition, missingRequiredDocs, ensureWaCode, CALL_OUTCOMES } from '../services/nurses.js';
import { scope, isSuper, needSuper, canSee, loadVisibleNurse } from '../middleware/auth.js';

export const nursesRouter = Router();
const str = v => (Array.isArray(v) ? String(v[0] ?? '') : v == null ? '' : String(v));
const channels = c => (c ? [c] : []);

function nurseFilter(user, qs) {
  const { w, v } = scope(user);
  if (isSuper(user) && str(qs.district)) { w.push('n.district = ?'); v.push(str(qs.district)); }
  if (str(qs.status)) {
    const ss = str(qs.status).split(',').filter(s => STATUSES[s]);
    if (ss.length) { w.push(`n.status IN (${ss.map(() => '?').join(',')})`); v.push(...ss); }
  }
  if (str(qs.dnc) === '1') w.push('n.dnc');
  if (str(qs.dnc) === '0') w.push('NOT n.dnc');
  const s = str(qs.q).trim();
  if (s) {
    if (/^\+?[\d\s-]{4,}$/.test(s)) { w.push('n.mobile LIKE ?'); v.push('%' + s.replace(/\D/g, '').slice(-10) + '%'); }
    else { w.push('(n.name ILIKE ? OR n.id ILIKE ? OR n.council_reg_no ILIKE ?)'); v.push(`%${s}%`, `%${s}%`, `%${s}%`); }
  }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', vals: v };
}
const SORTS = { id: 'n.id', name: 'n.name', district: 'n.district, n.id', status: 'n.status, n.id', updated: 'n.updated_at DESC' };

nursesRouter.get('/', async (req, res) => {
  const { where, vals } = nurseFilter(req.user, req.query);
  const size = Math.min(Math.max(Number(str(req.query.size)) || 50, 1), 200);
  const page = Math.max(Number(str(req.query.page)) || 1, 1);
  const order = SORTS[str(req.query.sort)] || 'n.id';
  const [{ c: total }, rows] = await Promise.all([
    one(`SELECT COUNT(*) c FROM nurses n ${where}`, ...vals),
    q(`SELECT n.id, n.name, n.mobile, n.district, n.status, n.dnc, n.qualification, n.registered_at, n.updated_at, n.whatsapp_connected_at
        FROM nurses n ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...vals, size, (page - 1) * size),
  ]);
  res.json({ rows, total, page, size });
});

// Everything collected about each nurse, except the bank account number (only its last 4 digits).
const EXPORT_COLS = ['id', 'name', 'mobile', 'district', 'status', 'email', 'address', 'taluk', 'block', 'qualification', 'council_reg_no',
  'current_employment', 'experience_years', 'work_preference', 'preferred_locations', 'service_interests', 'registered_at',
  'payout_account_holder', 'payout_account_last4', 'payout_ifsc', 'payout_upi', 'dnc', 'source', 'updated_at'];

nursesRouter.get('/export.csv', async (req, res) => {
  const { where, vals } = nurseFilter(req.user, req.query);
  const tag = isSuper(req.user) ? (str(req.query.district) || 'all-districts') : req.user.district;
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="uyir-nurses-${tag.replace(/[^\w-]/g, '_')}-${new Date().toISOString().slice(0, 10)}.csv"`,
    'Cache-Control': 'private, no-store',
  });
  res.write('﻿' + EXPORT_COLS.join(','));
  // Page through by primary key so a statewide export never holds every row in memory at once.
  let after = '';
  for (;;) {
    const rows = await q(`SELECT ${EXPORT_COLS.map(c => 'n.' + c).join(', ')} FROM nurses n
        ${where ? where + ' AND' : 'WHERE'} n.id > ? ORDER BY n.id LIMIT 2000`, ...vals, after);
    if (!rows.length) break;
    res.write('\r\n' + rows.map(r => EXPORT_COLS.map(c => csvCell(c === 'status' ? STATUSES[r[c]]?.label : r[c])).join(',')).join('\r\n'));
    after = rows.at(-1).id;
  }
  res.end();
});

nursesRouter.post('/', async (req, res) => {
  const { user } = req, body = req.body || {};
  const name = str(body.name).trim();
  const mobile = normalizeMobile(body.mobile);
  const district = isSuper(user) ? normalizeDistrict(body.district) : user.district;
  if (!name) throw httpError(400, 'Name is required');
  if (!mobile) throw httpError(400, 'Enter a valid 10-digit Indian mobile number');
  if (!district) throw httpError(400, 'Choose a district');
  if (await one(`SELECT 1 FROM nurses WHERE mobile = ?`, mobile)) throw httpError(409, 'A nurse with this mobile already exists');
  const out = await tx(async () => {
    const id = await nextNurseId();
    await q(`INSERT INTO nurses (id, name, mobile, district, source, consent_whatsapp) VALUES (?,?,?,?,?,?)`,
      id, name.slice(0, 200), mobile, district, str(body.source).trim().slice(0, 200) || 'Added by staff', !!body.consent_whatsapp);
    await logEvent(id, 'import', { note: `Added by staff${body.consent_whatsapp ? '; nurse agreed to WhatsApp messages' : ''}`, user });
    let notified = null;
    if (body.invite) notified = channels(inviteChannel(await transition(id, 'INVITED', { role: user.role, user, from: 'NEW' }, 'Invite sent when added')));
    return { id, notified };
  });
  res.status(200).json(out);
});

// Bulk invite: send registration links to the selected nurses who haven't been invited yet.
nursesRouter.post('/bulk', async (req, res) => {
  const { user } = req, body = req.body || {};
  if (body.action !== 'invite') throw httpError(400, 'Unknown action');
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, 5000).map(String) : [];
  if (!ids.length) throw httpError(400, 'No nurses selected');
  const visible = (await q(`SELECT * FROM nurses WHERE id = ANY(?)`, ids)).filter(n => canSee(user, n));
  let done = 0; const skipped = [];
  for (const n of visible) {
    if (n.dnc) { skipped.push({ id: n.id, reason: 'Do Not Contact' }); continue; }
    if (n.status !== 'NEW') { skipped.push({ id: n.id, reason: `Already ${STATUSES[n.status].label}` }); continue; }
    if (!inviteChannel(n)) { skipped.push({ id: n.id, reason: 'No SMS consent' }); continue; }
    try { await transition(n.id, 'INVITED', { role: user.role, user, from: 'NEW' }, 'Bulk invite'); done++; }
    catch (e) { skipped.push({ id: n.id, reason: e.message }); }
  }
  res.json({ done, skipped: skipped.slice(0, 100), skippedCount: skipped.length });
});

nursesRouter.get('/:id', async (req, res) => {
  const { user } = req;
  const n = await loadVisibleNurse(user, req.params.id);
  const [events, documents, messages, missingDocs] = await Promise.all([
    q(`SELECT * FROM events WHERE nurse_id = ? ORDER BY id DESC`, n.id),
    q(`SELECT d.id, d.type, d.filename, d.mime, d.size, d.status, d.note, d.uploaded_at, d.reviewed_at, u.name reviewer
        FROM documents d LEFT JOIN users u ON u.id = d.reviewed_by WHERE d.nurse_id = ? ORDER BY d.id DESC`, n.id),
    q(`SELECT * FROM messages WHERE nurse_id = ? ORDER BY id DESC LIMIT 50`, n.id),
    n.stage_reached >= 2 ? missingRequiredDocs(n.id, n) : [],
  ]);
  const allowed = (TRANSITIONS[n.status] || []).filter(to => canTransition(n.status, to, user.role).ok);
  // Call / SMS from the admin's own phone. The SMS carries the WhatsApp chat link with this nurse's code.
  const phone = '+91' + n.mobile;
  if (!n.dnc && n.consent_sms) n.wa_code = await ensureWaCode(n);
  const smsBody = !n.dnc && n.consent_sms ? manualSmsBody(n, n.wa_code) : null;
  const contact = {
    tel: n.dnc ? null : 'tel:' + phone,
    sms: smsBody ? `sms:${phone}?body=${encodeURIComponent(smsBody)}` : null,
    sms_body: smsBody,
    blocked: n.dnc ? 'Do Not Contact' : null,
    sms_blocked: n.dnc ? 'Do Not Contact' : !n.consent_sms ? 'No SMS consent' : null,
  };
  // Never send secrets to the browser: OTP / session hashes and the encrypted account number stay server-side.
  const { reg_session, reg_session_expires, otp_hash, otp_expires, otp_attempts, payout_account_enc, call_attempts, consent_call, assigned_to, ...safe } = n;
  res.json({
    nurse: { ...safe, registration_url: n.reg_token ? `${config.publicUrl}/register?t=${n.reg_token}` : null },
    events, documents, messages, allowed, missingDocs, contact, requiredDocs: requiredDocTypes(n),
  });
});

nursesRouter.patch('/:id', async (req, res) => {
  const { user } = req, body = req.body || {};
  const n = await loadVisibleNurse(user, req.params.id);
  const up = {};
  if (body.name != null && str(body.name).trim() && str(body.name).trim() !== n.name) up.name = str(body.name).trim().slice(0, 200);
  if (body.mobile != null) {
    const m = normalizeMobile(body.mobile);
    if (!m) throw httpError(400, 'Invalid mobile number');
    if (m !== n.mobile) {
      if (await one(`SELECT 1 FROM nurses WHERE mobile = ? AND id <> ?`, m, n.id)) throw httpError(409, 'Mobile already belongs to another nurse');
      up.mobile = m;
    }
  }
  if (body.district != null && body.district !== n.district) {
    needSuper(user);   // moving a nurse between districts is a Super Admin action
    const d = normalizeDistrict(body.district);
    if (!d) throw httpError(400, 'Unknown district');
    up.district = d;
  }
  if (body.source != null && str(body.source) !== (n.source ?? '')) up.source = str(body.source).slice(0, 200);
  const keys = Object.keys(up);
  if (keys.length) {
    await tx(async () => {
      await q(`UPDATE nurses SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = now() WHERE id = ?`, ...keys.map(k => up[k]), n.id);
      await logEvent(n.id, 'note', { note: 'Edited ' + keys.map(k => `${k}: ${n[k] ?? '—'} → ${up[k]}`).join('; '), user });
    });
  }
  res.json({ ok: true });
});

// Staff actions: INVITED (send / resend link), VERIFIED, CORRECTION_REQUIRED, REJECTED.
nursesRouter.post('/:id/transition', async (req, res) => {
  const { user } = req, body = req.body || {};
  const n = await loadVisibleNurse(user, req.params.id);
  const to = str(body.to);
  const note = str(body.note).trim().slice(0, 1000) || null;
  const check = canTransition(n.status, to, user.role);
  if (!check.ok) throw httpError(409, check.reason);
  if (['CORRECTION_REQUIRED', 'REJECTED'].includes(to) && !note) throw httpError(400, 'A reason is required; it is sent to the nurse');
  if (to === 'VERIFIED') {
    const missing = await missingRequiredDocs(n.id, n);
    if (missing.length) throw httpError(409, `Missing required documents: ${missing.map(m => DOC_TYPES[m].label).join(', ')}`);
    const { c } = await one(`SELECT COUNT(*) c FROM documents WHERE nurse_id = ? AND status = 'SUBMITTED' AND type = ANY(?)`, n.id, requiredDocTypes(n));
    if (c) throw httpError(409, 'Review every required document before marking the nurse verified');
  }
  const updated = await transition(n.id, to, { role: user.role, user, from: n.status }, note);
  // Which channels the nurse was told on ([] = nobody could be messaged: share the link yourself).
  res.json({ ok: true, status: updated.status, notified: to === 'INVITED' ? channels(inviteChannel(updated)) : undefined });
});

nursesRouter.post('/:id/note', async (req, res) => {
  const n = await loadVisibleNurse(req.user, req.params.id);
  const note = str(req.body?.note).trim().slice(0, 2000);
  if (!note) throw httpError(400, 'Note is empty');
  await logEvent(n.id, 'note', { note, user: req.user });
  res.json({ ok: true });
});

// The admin tapped Call or SMS (their phone's dialer / SMS app opens with the nurse's number).
nursesRouter.post('/:id/contact', async (req, res) => {
  const { user } = req;
  const n = await loadVisibleNurse(user, req.params.id);
  if (n.dnc) throw httpError(409, 'Nurse is on Do Not Contact');
  const channel = req.body?.channel;
  if (channel === 'call') {
    await logEvent(n.id, 'call', { note: `Call started from admin's phone to ${n.mobile}`, user });
  } else if (channel === 'sms') {
    if (!n.consent_sms) throw httpError(409, 'The nurse has not consented to SMS');
    const code = await ensureWaCode(n);
    await logEvent(n.id, 'sms', { note: `SMS opened on admin's phone with the WhatsApp link (code ${code})`, user });
  } else throw httpError(400, 'channel must be call or sms');
  await q(`UPDATE nurses SET last_contacted_at = now(), updated_at = now() WHERE id = ?`, n.id);
  res.json({ ok: true });
});

// Call status: what happened on a call the admin made from their own phone.
nursesRouter.post('/:id/call-log', async (req, res) => {
  const { user } = req;
  const n = await loadVisibleNurse(user, req.params.id);
  const label = CALL_OUTCOMES[req.body?.outcome];
  if (!label) throw httpError(400, 'Choose a call status');
  const note = str(req.body?.note).trim().slice(0, 1000);
  await tx(async () => {
    await q(`UPDATE nurses SET call_attempts = call_attempts + 1, last_contacted_at = now(), updated_at = now() WHERE id = ?`, n.id);
    await logEvent(n.id, 'call', { note: `Call status: ${label}${note ? ' — ' + note : ''}`, user });
  });
  res.json({ ok: true });
});

// Reminders for nurses who haven't finished. (Resending the invite is the INVITED action.)
const REMINDERS = { DOC_REMIND: ['REGISTERED'], CORRECTION: ['CORRECTION_REQUIRED'] };
nursesRouter.post('/:id/message', async (req, res) => {
  const n = await loadVisibleNurse(req.user, req.params.id);
  const template = str(req.body?.template);
  if (!REMINDERS[template]?.includes(n.status)) throw httpError(409, 'That reminder does not apply to the current status');
  const sent = await queueMessage(n, template);
  if (!sent.length) throw httpError(409, n.dnc ? 'Nurse is on Do Not Contact' : 'The nurse has not connected on WhatsApp yet (no opt-in), so reminders can’t be sent');
  res.json({ ok: true, sent });
});

nursesRouter.post('/:id/consent', async (req, res) => {
  const { user } = req, body = req.body || {};
  const n = await loadVisibleNurse(user, req.params.id);
  const reason = str(body.reason).trim().slice(0, 500);
  if (body.dnc === false && n.dnc && !reason) throw httpError(400, 'Record how fresh consent was obtained before lifting Do Not Contact');
  await tx(async () => {
    const notes = [];
    for (const [k, label] of Object.entries({ consent_sms: 'SMS', consent_whatsapp: 'WhatsApp' })) {
      if (body[k] == null) continue;
      const val = !!body[k];
      if (val !== n[k]) { await q(`UPDATE nurses SET ${k} = ? WHERE id = ?`, val, n.id); notes.push(`${label} consent ${val ? 'given' : 'withdrawn'}`); }
    }
    if (body.dnc === true && !n.dnc) {
      await q(`UPDATE nurses SET dnc = true, dnc_reason = ?, dnc_at = now() WHERE id = ?`, reason || 'Requested by nurse', n.id);
      notes.push(`Added to Do Not Contact${reason ? ': ' + reason : ''}`);
    }
    if (body.dnc === false && n.dnc) {
      await q(`UPDATE nurses SET dnc = false, dnc_reason = NULL, dnc_at = NULL WHERE id = ?`, n.id);
      notes.push(`Do Not Contact lifted: ${reason}`);
    }
    if (!notes.length) return;
    await q(`UPDATE nurses SET updated_at = now() WHERE id = ?`, n.id);
    await logEvent(n.id, 'consent', { note: notes.join('; '), user });
  });
  res.json({ ok: true });
});

nursesRouter.post('/:id/documents/:docId/review', async (req, res) => {
  const { user } = req, body = req.body || {};
  const n = await loadVisibleNurse(user, req.params.id);
  const d = /^\d+$/.test(req.params.docId) ? await one(`SELECT * FROM documents WHERE id = ? AND nurse_id = ?`, Number(req.params.docId), n.id) : null;
  if (!d) throw httpError(404, 'Document not found');
  const status = str(body.status);
  const note = str(body.note).trim().slice(0, 1000) || null;
  if (!['VERIFIED', 'CORRECTION', 'REJECTED'].includes(status)) throw httpError(400, 'Invalid review status');
  if (status !== 'VERIFIED' && !note) throw httpError(400, 'Add a note explaining the problem');
  await tx(async () => {
    await q(`UPDATE documents SET status = ?, note = ?, reviewed_by = ?, reviewed_at = now() WHERE id = ?`, status, note, user.id, d.id);
    await logEvent(n.id, 'document', { note: `${DOC_TYPES[d.type]?.label}: ${status.toLowerCase()}${note ? ' — ' + note : ''}`, user });
  });
  res.json({ ok: true });
});
