// CSV import. District Admins import into their own district (a District column is optional
// for them); the Super Admin imports for any district. dry_run validates without writing.
import { Router } from 'express';
import { q, tx, insertMany, formatNurseId } from '../db/pool.js';
import { httpError } from '../lib/errors.js';
import { parseCsv } from '../lib/csv.js';
import { normalizeDistrict, normalizeMobile } from '../domain/workflow.js';
import { isSuper } from '../middleware/auth.js';

export const importRouter = Router();

const HEADER_ALIASES = {
  nurse_id: ['nurse id', 'nurse_id', 'id', 'uyir id'], name: ['name', 'nurse name', 'full name'],
  mobile: ['mobile', 'mobile number', 'phone', 'phone number', 'contact'], district: ['district'], source: ['source'],
  whatsapp: ['whatsapp consent', 'whatsapp opt-in', 'whatsapp optin', 'whatsapp'],
};
const YES = new Set(['yes', 'y', 'true', '1', 'agreed']);
const MAX_ROWS = 100_000;

importRouter.post('/', async (req, res) => {
  const { user } = req, body = req.body || {};
  const rows = parseCsv(String(body.csv || '').replace(/^﻿/, ''));
  if (rows.length < 2) throw httpError(400, 'CSV needs a header row and at least one record');
  if (rows.length > MAX_ROWS + 1) throw httpError(413, `Import at most ${MAX_ROWS.toLocaleString('en-IN')} rows at a time`);
  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(HEADER_ALIASES).map(([k, al]) => [k, header.findIndex(h => al.includes(h))]));
  for (const r of ['name', 'mobile', ...(isSuper(user) ? ['district'] : [])]) if (col[r] < 0) throw httpError(400, `Missing required column: ${r}`);

  const mobiles = rows.slice(1).map(r => normalizeMobile(col.mobile >= 0 ? r[col.mobile] : '')).filter(Boolean);
  const ids = rows.slice(1).map(r => String(col.nurse_id >= 0 ? r[col.nurse_id] ?? '' : '').trim().toUpperCase()).filter(Boolean);
  const existingMobiles = new Set((await q(`SELECT mobile FROM nurses WHERE mobile = ANY(?)`, mobiles)).map(r => r.mobile));
  const existingIds = new Set((await q(`SELECT id FROM nurses WHERE id = ANY(?)`, ids)).map(r => r.id));
  const errors = []; const ok = [];
  const defaultSource = String(body.default_source || '').trim().slice(0, 200);
  rows.slice(1).forEach((r, i) => {
    const line = i + 2, get = k => (col[k] >= 0 ? String(r[col[k]] ?? '').trim() : '');
    const name = get('name'), mobile = normalizeMobile(get('mobile'));
    // A blank district means "my district" for a District Admin; the Super Admin must always give one.
    const district = get('district') ? normalizeDistrict(get('district')) : (isSuper(user) ? null : user.district);
    const id = get('nurse_id').toUpperCase();
    if (!name) return errors.push({ line, reason: 'Missing name' });
    if (!mobile) return errors.push({ line, reason: `Invalid mobile "${get('mobile')}"` });
    if (!district) return errors.push({ line, reason: `Unknown district "${get('district')}"` });
    if (!isSuper(user) && district !== user.district) return errors.push({ line, reason: `District ${district} is outside your district (${user.district})` });
    if (existingMobiles.has(mobile)) return errors.push({ line, reason: `Duplicate mobile ${mobile}` });
    if (id && !/^UYIR-NUR-\d{6}$/.test(id)) return errors.push({ line, reason: `Bad nurse ID "${id}"` });
    if (id && existingIds.has(id)) return errors.push({ line, reason: `Duplicate nurse ID ${id}` });
    existingMobiles.add(mobile); if (id) existingIds.add(id);
    ok.push({ id, name: name.slice(0, 200), mobile, district, source: get('source').slice(0, 200) || defaultSource || 'Import', consent_whatsapp: YES.has(get('whatsapp').toLowerCase()) });
  });

  if (body.dry_run) return res.json({ valid: ok.length, errors: errors.slice(0, 200), errorCount: errors.length });

  await tx(async () => {
    // Move the sequence past any explicit IDs in the file, then reserve IDs for the rest in one round trip.
    const maxExplicit = Math.max(0, ...ok.filter(o => o.id).map(o => parseInt(o.id.slice(9), 10)));
    if (maxExplicit) await q(`SELECT setval('nurse_no_seq', GREATEST((SELECT last_value FROM nurse_no_seq), ?))`, maxExplicit);
    const blanks = ok.filter(o => !o.id);
    if (blanks.length) {
      const nums = await q(`SELECT nextval('nurse_no_seq') n FROM generate_series(1, ?)`, blanks.length);
      blanks.forEach((o, i) => { o.id = formatNurseId(nums[i].n); });
    }
    await insertMany('nurses', ['id', 'name', 'mobile', 'district', 'source', 'consent_whatsapp'], ok);
    await insertMany('events', ['nurse_id', 'type', 'note', 'user_id', 'actor'], ok.map(o => ({
      nurse_id: o.id, type: 'import', user_id: user.id, actor: user.username, note: `Imported from ${o.source}${o.consent_whatsapp ? '; WhatsApp opt-in: yes' : ''}`,
    })));
  });
  req.log.info({ inserted: ok.length, skipped: errors.length }, 'nurses imported');
  res.json({ inserted: ok.length, errors: errors.slice(0, 200), errorCount: errors.length });
});
