// Nurse-facing registration portal API (public). The personal link token in the URL identifies
// the nurse; there is no OTP step. Staff send the link by SMS from their own phone after a call.
// Details & consent → documents (multipart upload → S3) → staff review → bank details once verified.
// The link is the nurse's only credential: it is long and random (reg_token), and the portal never
// shows the full bank account number back (last 4 digits only).
import { Router } from 'express';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { q, one, tx } from '../db/pool.js';
import { httpError } from '../lib/errors.js';
import { encryptField } from '../lib/crypto.js';
import { STATUSES, DOC_TYPES, DISTRICTS, PAYOUT_STATUSES, IFSC_RE, requiredDocTypes, normalizeDistrict, REG_FIELDS } from '../domain/workflow.js';
import { logEvent } from '../services/events.js';
import { transition, missingRequiredDocs } from '../services/nurses.js';
import { storage, documentKey } from '../services/storage.js';
import { registrationLimiter } from '../middleware/security.js';
import { TALUKS } from '../domain/taluks.js';
import { compressPdf } from '../services/compress.js';

export const registrationRouter = Router();
registrationRouter.use(registrationLimiter);

// Stored documents are at most 5 MB; photos are shrunk to KB size in the browser before upload.
// A larger PDF (up to 25 MB) is accepted and compressed here to fit.
const MAX_STORED = 5 * 1024 * 1024;
const MAX_UPLOAD = 25 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 1, fields: 10, fieldSize: 10_000 } });

async function regNurse(t) {
  const n = t && await one(`SELECT * FROM nurses WHERE reg_token = ?`, String(t));
  if (!n || n.status === 'NEW') throw httpError(404, 'This registration link is invalid or has expired');
  return n;
}
/** Load the nurse for the link token :t; puts the nurse on req.nurse. */
const withNurse = async (req, res, next) => {
  req.nurse = await regNurse(req.params.t);
  next();
};
const mask = m => m.slice(0, 2) + '******' + m.slice(-2);
const EDITABLE = ['INVITED', 'REGISTERED', 'CORRECTION_REQUIRED'];
const DOCS_OPEN = ['REGISTERED', 'CORRECTION_REQUIRED'];

registrationRouter.get('/:t', async (req, res) => {
  const n = await regNurse(req.params.t);
  res.json({ first_name: n.name.split(/\s+/)[0], masked_mobile: mask(n.mobile), docTypes: DOC_TYPES, districts: DISTRICTS });
});

// Nurses who started on WhatsApp have no district yet (and only their WhatsApp profile name):
// they give their name and district with their details.
const needsProfile = n => !n.district;

registrationRouter.get('/:t/form', withNurse, async (req, res) => {
  const n = req.nurse;
  const [docs, missing] = await Promise.all([
    q(`SELECT id, type, filename, status, note, uploaded_at FROM documents WHERE nurse_id = ? AND status <> 'SUPERSEDED' ORDER BY id DESC`, n.id),
    missingRequiredDocs(n.id, n),
  ]);
  res.json({
    nurse: {
      id: n.id, name: n.name, mobile: n.mobile, district: n.district, status: n.status, status_label: STATUSES[n.status].label, review_note: n.review_note,
      consent_given: !!n.consent_data_processing_at, consent_sms: n.consent_sms, consent_whatsapp: n.consent_whatsapp,
      needs_profile: needsProfile(n),
      ...Object.fromEntries(REG_FIELDS.map(f => [f, n[f]])),
    },
    districts: DISTRICTS, taluks: TALUKS,
    documents: docs, missing, required: requiredDocTypes(n),
    payout: {
      needed: PAYOUT_STATUSES.includes(n.status),
      on_file: !!n.payout_added_at,
      holder: n.payout_account_holder, last4: n.payout_account_last4, ifsc: n.payout_ifsc, upi: n.payout_upi,
    },
  });
});

registrationRouter.post('/:t/details', withNurse, async (req, res) => {
  const n = req.nurse, body = req.body || {};
  if (!EDITABLE.includes(n.status)) throw httpError(409, 'Your details are locked while under review');
  if (!body.consent) throw httpError(400, 'Consent is required to register');
  // Every field on the form is required. The portal does not ask for the block (staff may have
  // filled it in), so a field missing from the request keeps what is on file.
  const f = Object.fromEntries(REG_FIELDS.map(k => [k, k in body ? (body[k] == null ? null : String(body[k]).trim().slice(0, 1000) || null) : n[k] ?? null]));
  const name = String(body.name ?? '').trim().slice(0, 200);
  if (!name) throw httpError(400, 'Please fill in your name');
  if (!f.address) throw httpError(400, 'Please fill in your address');
  if (!f.email) throw httpError(400, 'Please fill in your email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) throw httpError(400, 'Invalid email address');
  // District: chosen here only by nurses who started on WhatsApp; otherwise staff set it (and move nurses between districts).
  const district = needsProfile(n) ? normalizeDistrict(body.district) : n.district;
  if (!district) throw httpError(400, 'Please choose your district');
  for (const [k, label] of [['taluk', 'your taluk'], ['preferred_locations', 'your preferred work location'], ['qualification', 'your qualification'],
    ['council_reg_no', 'your Nursing Council registration number'], ['current_employment', 'your current employment'],
    ['experience_years', 'your years of experience'], ['work_preference', 'your work preference'], ['service_interests', 'the services you are interested in']]) {
    if (f[k] == null) throw httpError(400, `Please fill in ${label}`);
  }
  f.experience_years = Math.max(0, Math.min(60, Number(f.experience_years) || 0));
  const profile = name !== n.name || district !== n.district ? { name, district } : null;
  await tx(async () => {
    if (profile) {
      await q(`UPDATE nurses SET name = ?, district = ? WHERE id = ?`, profile.name, profile.district, n.id);
      const note = needsProfile(n) ? `Name and district given by the nurse: ${profile.name}, ${profile.district}` : `Name changed by the nurse: ${n.name} → ${profile.name}`;
      await logEvent(n.id, 'registration', { note, actor: 'nurse' });
    }
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

// multipart/form-data: type=<DOC_TYPE>, file=<PDF|JPG|PNG>. Stored in S3 (≤ 5 MB), then recorded.
registrationRouter.post('/:t/documents', withNurse, upload.single('file'), async (req, res) => {
  const n = req.nurse, type = String(req.body?.type || ''), file = req.file;
  if (!DOCS_OPEN.includes(n.status)) throw httpError(409, 'Documents cannot be changed right now');
  if (!DOC_TYPES[type]) throw httpError(400, 'Unknown document type');
  if (!file?.buffer?.length) throw httpError(400, 'Choose a file to upload');
  const mime = Object.keys(MAGIC).find(m => MAGIC[m].every((b, i) => file.buffer[i] === b));
  if (!mime) throw httpError(400, 'Upload a PDF, JPG or PNG file');
  let body = file.buffer;
  if (body.length > MAX_STORED) {
    // Photos arrive already compressed by the portal; only PDFs are compressed here.
    if (mime !== 'application/pdf') throw httpError(413, 'Photo must be under 5 MB');
    body = await compressPdf(body);
    if (!body || body.length > MAX_STORED) throw httpError(413, 'This PDF is still over 5 MB after compressing. Scan it at a lower resolution or upload fewer pages.');
  }
  const key = documentKey(n.id, type, mime);
  const digest = createHash('sha256').update(body).digest('hex');
  const filename = String(file.originalname || 'document').slice(0, 200);
  // Write the object first, then the row: a failure leaves at most an unreferenced object
  // (cleaned up by S3 lifecycle rules), never a row that points at nothing.
  await storage.put({ key, body, contentType: mime, sha256: digest, metadata: { 'nurse-id': n.id, 'doc-type': type } });
  await tx(async () => {
    // Replacing a document of the same type supersedes earlier unverified uploads.
    await q(`UPDATE documents SET status = 'SUPERSEDED' WHERE nurse_id = ? AND type = ? AND status IN ('SUBMITTED','CORRECTION','REJECTED')`, n.id, type);
    await q(`INSERT INTO documents (nurse_id, type, filename, mime, stored_name, size, storage, sha256) VALUES (?,?,?,?,?,?,?,?)`,
      n.id, type, filename, mime, key, body.length, storage.name, digest);
    await logEvent(n.id, 'document', { note: `Uploaded ${DOC_TYPES[type].label}`, actor: 'nurse' });
  });
  res.json({ ok: true, missing: await missingRequiredDocs(n.id, n) });
});

registrationRouter.post('/:t/submit-docs', withNurse, async (req, res) => {
  const n = req.nurse;
  const missing = await missingRequiredDocs(n.id, n);
  if (missing.length) throw httpError(400, `Still missing: ${missing.map(m => DOC_TYPES[m].label).join(', ')}`);
  if (!DOCS_OPEN.includes(n.status)) throw httpError(409, 'Nothing to submit');
  await transition(n.id, 'SUBMITTED', { role: 'system', actor: 'nurse' }, n.status === 'CORRECTION_REQUIRED' ? 'Corrected documents submitted' : 'Documents submitted');
  res.json({ ok: true });
});

// Bank / payment details, collected once the nurse is verified. The account number is encrypted at rest.
registrationRouter.post('/:t/payout', withNurse, async (req, res) => {
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
