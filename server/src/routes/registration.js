// Nurse-facing registration portal API (public; the personal link token identifies the nurse):
// OTP on WhatsApp → details & consent → documents (multipart upload → S3) → staff review →
// bank details once verified. After OTP the browser sends X-Reg-Session (2-hour session).
import { Router } from 'express';
import multer from 'multer';
import { createHash, randomInt } from 'node:crypto';
import { q, one, tx } from '../db/pool.js';
import { config } from '../config.js';
import { httpError } from '../lib/errors.js';
import { token, sha256, encryptField } from '../lib/crypto.js';
import { STATUSES, DOC_TYPES, DISTRICTS, PAYOUT_STATUSES, IFSC_RE, requiredDocTypes } from '../domain/workflow.js';
import { logEvent } from '../services/events.js';
import { queueMessage } from '../services/messaging.js';
import { transition, missingRequiredDocs } from '../services/nurses.js';
import { storage, documentKey } from '../services/storage.js';
import { otpLimiter, registrationLimiter } from '../middleware/security.js';

export const registrationRouter = Router();
registrationRouter.use(registrationLimiter);

const MAX_FILE = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE, files: 1, fields: 10, fieldSize: 10_000 } });

async function regNurse(t) {
  const n = t && await one(`SELECT * FROM nurses WHERE reg_token = ?`, String(t));
  if (!n || n.status === 'NEW') throw httpError(404, 'This registration link is invalid or has expired');
  return n;
}
function requireRegSession(req, n) {
  const s = req.get('x-reg-session');
  if (!s || !n.reg_session || sha256(s) !== n.reg_session || !(new Date(n.reg_session_expires) > new Date())) throw httpError(401, 'Please verify your mobile number again');
}
/** Load the nurse for :t and check the session; puts the nurse on req.nurse. */
const withSession = async (req, res, next) => {
  req.nurse = await regNurse(req.params.t);
  requireRegSession(req, req.nurse);
  next();
};
const mask = m => m.slice(0, 2) + '******' + m.slice(-2);
const EDITABLE = ['INVITED', 'REGISTERED', 'CORRECTION_REQUIRED'];
const DOCS_OPEN = ['REGISTERED', 'CORRECTION_REQUIRED'];

registrationRouter.get('/:t', async (req, res) => {
  const n = await regNurse(req.params.t);
  res.json({ first_name: n.name.split(/\s+/)[0], masked_mobile: mask(n.mobile), docTypes: DOC_TYPES, districts: DISTRICTS });
});

registrationRouter.post('/:t/otp', otpLimiter, async (req, res) => {
  const n = await regNurse(req.params.t);
  if (n.otp_expires && new Date(n.otp_expires).getTime() - 9 * 60e3 > Date.now()) throw httpError(429, 'Please wait a minute before requesting another code');
  const otp = String(randomInt(100000, 1000000));
  await q(`UPDATE nurses SET otp_hash = ?, otp_expires = now() + interval '10 minutes', otp_attempts = 0 WHERE id = ?`, sha256(n.id + otp), n.id);
  let via;
  try { via = await queueMessage(n, 'OTP', { force: true, code: otp }); }   // requested by the nurse; sent at once
  catch (e) { await q(`UPDATE nurses SET otp_hash = NULL, otp_expires = NULL WHERE id = ?`, n.id); throw e; }   // let them retry now
  if (config.isDev) req.log.info({ nurseId: n.id, otp }, '[dev] OTP');
  res.json({ ok: true, masked_mobile: mask(n.mobile), via, ...(config.isDev ? { dev_otp: otp } : {}) });
});

registrationRouter.post('/:t/verify', async (req, res) => {
  const n = await regNurse(req.params.t);
  if (!n.otp_hash || !(new Date(n.otp_expires) > new Date())) throw httpError(400, 'Code expired. Request a new one.');
  if (n.otp_attempts >= 5) throw httpError(429, 'Too many attempts. Request a new code.');
  if (sha256(n.id + String(req.body?.otp || '').trim()) !== n.otp_hash) {
    await q(`UPDATE nurses SET otp_attempts = otp_attempts + 1 WHERE id = ?`, n.id);
    throw httpError(400, 'Incorrect code');
  }
  const s = token(24);
  await q(`UPDATE nurses SET otp_hash = NULL, otp_expires = NULL, reg_session = ?, reg_session_expires = now() + interval '2 hours',
      mobile_verified_at = COALESCE(mobile_verified_at, now()) WHERE id = ?`, sha256(s), n.id);
  if (!n.mobile_verified_at) await logEvent(n.id, 'registration', { note: 'Mobile verified by OTP', actor: 'nurse' });
  res.json({ session: s });
});

const REG_FIELDS = ['email', 'address', 'taluk', 'block', 'qualification', 'council_reg_no', 'current_employment', 'experience_years', 'work_preference', 'preferred_locations', 'service_interests'];

registrationRouter.get('/:t/form', withSession, async (req, res) => {
  const n = req.nurse;
  const [docs, missing] = await Promise.all([
    q(`SELECT id, type, filename, status, note, uploaded_at FROM documents WHERE nurse_id = ? AND status <> 'SUPERSEDED' ORDER BY id DESC`, n.id),
    missingRequiredDocs(n.id, n),
  ]);
  res.json({
    nurse: {
      id: n.id, name: n.name, mobile: n.mobile, district: n.district, status: n.status, status_label: STATUSES[n.status].label, review_note: n.review_note,
      consent_given: !!n.consent_data_processing_at, consent_sms: n.consent_sms, consent_whatsapp: n.consent_whatsapp,
      ...Object.fromEntries(REG_FIELDS.map(f => [f, n[f]])),
    },
    documents: docs, missing, required: requiredDocTypes(n),
    payout: {
      needed: PAYOUT_STATUSES.includes(n.status),
      on_file: !!n.payout_added_at,
      holder: n.payout_account_holder, last4: n.payout_account_last4, ifsc: n.payout_ifsc, upi: n.payout_upi,
    },
  });
});

registrationRouter.post('/:t/details', withSession, async (req, res) => {
  const n = req.nurse, body = req.body || {};
  if (!EDITABLE.includes(n.status)) throw httpError(409, 'Your details are locked while under review');
  if (!body.consent) throw httpError(400, 'Consent is required to register');
  const f = Object.fromEntries(REG_FIELDS.map(k => [k, body[k] == null ? null : String(body[k]).trim().slice(0, 1000) || null]));
  for (const k of ['address', 'taluk', 'qualification', 'council_reg_no', 'work_preference']) if (!f[k]) throw httpError(400, `Please fill in ${k.replace(/_/g, ' ')}`);
  if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) throw httpError(400, 'Invalid email address');
  f.experience_years = f.experience_years == null ? null : Math.max(0, Math.min(60, Number(f.experience_years) || 0));
  await tx(async () => {
    await q(`UPDATE nurses SET ${REG_FIELDS.map(k => `${k} = ?`).join(', ')}, consent_sms = ?, consent_whatsapp = ?,
        consent_data_processing_at = COALESCE(consent_data_processing_at, now()), updated_at = now() WHERE id = ?`,
      ...REG_FIELDS.map(k => f[k]), n.consent_sms, body.consent_whatsapp !== false, n.id);
    await logEvent(n.id, 'registration', { note: n.status === 'INVITED' ? 'Registration form completed (consent recorded)' : 'Registration details updated', actor: 'nurse' });
    if (n.status === 'INVITED') await transition(n.id, 'REGISTERED', { role: 'system', actor: 'nurse' }, 'Registration completed');
  });
  res.json({ ok: true });
});

// File signatures: the declared type must match the bytes, whatever the browser claims.
const MAGIC = { 'application/pdf': [0x25, 0x50, 0x44, 0x46], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47] };

// multipart/form-data: type=<DOC_TYPE>, file=<PDF|JPG|PNG ≤ 5 MB>. Stored in S3, then recorded.
registrationRouter.post('/:t/documents', withSession, upload.single('file'), async (req, res) => {
  const n = req.nurse, type = String(req.body?.type || ''), file = req.file;
  if (!DOCS_OPEN.includes(n.status)) throw httpError(409, 'Documents cannot be changed right now');
  if (!DOC_TYPES[type]) throw httpError(400, 'Unknown document type');
  if (!file?.buffer?.length) throw httpError(400, 'Choose a file to upload');
  const mime = Object.keys(MAGIC).find(m => MAGIC[m].every((b, i) => file.buffer[i] === b));
  if (!mime) throw httpError(400, 'Upload a PDF, JPG or PNG file');
  const key = documentKey(n.id, type, mime);
  const digest = createHash('sha256').update(file.buffer).digest('hex');
  const filename = String(file.originalname || 'document').slice(0, 200);
  // Write the object first, then the row: a failure leaves at most an unreferenced object
  // (cleaned up by S3 lifecycle rules), never a row that points at nothing.
  await storage.put({ key, body: file.buffer, contentType: mime, sha256: digest, metadata: { 'nurse-id': n.id, 'doc-type': type } });
  await tx(async () => {
    // Replacing a document of the same type supersedes earlier unverified uploads.
    await q(`UPDATE documents SET status = 'SUPERSEDED' WHERE nurse_id = ? AND type = ? AND status IN ('SUBMITTED','CORRECTION','REJECTED')`, n.id, type);
    await q(`INSERT INTO documents (nurse_id, type, filename, mime, stored_name, size, storage, sha256) VALUES (?,?,?,?,?,?,?,?)`,
      n.id, type, filename, mime, key, file.size, storage.name, digest);
    await logEvent(n.id, 'document', { note: `Uploaded ${DOC_TYPES[type].label}`, actor: 'nurse' });
  });
  res.json({ ok: true, missing: await missingRequiredDocs(n.id, n) });
});

registrationRouter.post('/:t/submit-docs', withSession, async (req, res) => {
  const n = req.nurse;
  const missing = await missingRequiredDocs(n.id, n);
  if (missing.length) throw httpError(400, `Still missing: ${missing.map(m => DOC_TYPES[m].label).join(', ')}`);
  if (!DOCS_OPEN.includes(n.status)) throw httpError(409, 'Nothing to submit');
  await transition(n.id, 'SUBMITTED', { role: 'system', actor: 'nurse' }, n.status === 'CORRECTION_REQUIRED' ? 'Corrected documents submitted' : 'Documents submitted');
  res.json({ ok: true });
});

// Bank / payment details, collected once the nurse is verified. The account number is encrypted at rest.
registrationRouter.post('/:t/payout', withSession, async (req, res) => {
  const n = req.nurse, body = req.body || {};
  if (!PAYOUT_STATUSES.includes(n.status)) throw httpError(409, 'Payment details are collected after your documents are verified');
  const holder = String(body.account_holder || '').trim().slice(0, 120);
  const acct = String(body.account_number || '').replace(/\s/g, '');
  const ifsc = String(body.ifsc || '').trim().toUpperCase();
  const upi = String(body.upi || '').trim().slice(0, 100) || null;
  if (!holder) throw httpError(400, 'Enter the account holder name');
  if (!/^\d{9,18}$/.test(acct)) throw httpError(400, 'Account number must be 9–18 digits');
  if (String(body.account_number_confirm || '').replace(/\s/g, '') !== acct) throw httpError(400, 'Account numbers do not match');
  if (!IFSC_RE.test(ifsc)) throw httpError(400, 'Enter a valid 11-character IFSC code');
  if (upi && !/^[\w.\-]{2,}@[a-z]{2,}$/i.test(upi)) throw httpError(400, 'Invalid UPI ID');
  await tx(async () => {
    await q(`UPDATE nurses SET payout_account_holder = ?, payout_account_enc = ?, payout_account_last4 = ?, payout_ifsc = ?, payout_upi = ?,
        payout_added_at = now(), updated_at = now() WHERE id = ?`, holder, encryptField(acct), acct.slice(-4), ifsc, upi, n.id);
    await logEvent(n.id, 'registration', { note: `${n.payout_added_at ? 'Updated' : 'Added'} payment details (a/c ••••${acct.slice(-4)}, ${ifsc})`, actor: 'nurse' });
  });
  res.json({ ok: true });
});
