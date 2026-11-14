// End-to-end API tests against a throwaway database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { cleanAccountNumber, ACCOUNT_RE } from '../src/domain/workflow.js';

// Same format as src/lib/crypto.js hashPassword (not imported: config would load .env's database settings).
const hashPassword = pw => { const salt = randomBytes(16); return `${salt.toString('hex')}:${scryptSync(pw, salt, 32).toString('hex')}`; };

// Needs a disposable PostgreSQL database whose name contains "test"; it is wiped first.
//   TEST_DATABASE_URL=postgres://postgres@localhost:5432/uyir_test npm test
const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL || !/test/i.test(new URL(DATABASE_URL).pathname)) {
  throw new Error('Set TEST_DATABASE_URL to a disposable Postgres database whose name contains "test" (it gets wiped).');
}
const DATA_DIR = mkdtempSync(join(tmpdir(), 'uyir-test-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const B = `http://localhost:${PORT}`;
// Stand-in for the WhatsApp Cloud API: records what the app sends, fails one number permanently.
const waSent = [];
const WA_BAD = new Set(['919999900099', '919999900199']);   // numbers 'not on WhatsApp'
const waMock = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = JSON.parse(raw || '{}');
  waSent.push({ url: req.url, auth: req.headers.authorization, body });
  res.writeHead(WA_BAD.has(body.to) ? 400 : 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(WA_BAD.has(body.to)
    ? { error: { code: 131026, message: 'Message undeliverable' } }
    : { messages: [{ id: 'wamid.TEST' + waSent.length }] }));
});
await new Promise(r => waMock.listen(0, r));
const WA = { WHATSAPP_PROVIDER: 'meta', WHATSAPP_API_BASE: `http://localhost:${waMock.address().port}`, WHATSAPP_TOKEN: 'test-token',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_APP_SECRET: 'test-app-secret', WHATSAPP_VERIFY_TOKEN: 'test-verify', WHATSAPP_POLL_MS: '100' };
const BUSINESS = '919876500000';
const env = { ...process.env, ...WA, WHATSAPP_BUSINESS_NUMBER: BUSINESS, DATABASE_URL, STORAGE_DRIVER: 'local', DATA_DIR, PORT: String(PORT), DEMO_COUNT: '400', NODE_ENV: 'test', PUBLIC_URL: '' };
const node = [process.execPath, '--disable-warning=ExperimentalWarning'];
let srv;

before(async () => {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  execFileSync(node[0], [node[1], 'scripts/seed.js', '--demo'], { env });

  // Plant data the way the old CRM version left it, so the startup upgrade is exercised.
  const c2 = new pg.Client({ connectionString: DATABASE_URL });
  await c2.connect();
  await c2.query(`INSERT INTO users (username, name, role, district, password_hash) VALUES
      ('old.coord', 'Old Coordinator', 'district_coordinator', 'Madurai', $1),
      ('old.caller', 'Old Caller', 'caller', 'Madurai', $1),
      ('old.verifier', 'Old Verifier', 'verifier', NULL, $1)`, [hashPassword('Legacy@123')]);
  await c2.query(`INSERT INTO nurses (id, name, mobile, district, status, stage_reached) VALUES
      ('UYIR-NUR-900001', 'Legacy Linksent', '9000000001', 'Madurai', 'REG_LINK_SENT', 3),
      ('UYIR-NUR-900002', 'Legacy Active',   '9000000002', 'Madurai', 'ACTIVE', 8),
      ('UYIR-NUR-900003', 'Legacy Noanswer', '9000000003', 'Madurai', 'NO_ANSWER', 1)`);
  await c2.end();

  srv = spawn(node[0], [node[1], 'src/index.js'], { env, stdio: process.env.TEST_SERVER_LOG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/healthz'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
});
after(() => {
  srv?.kill();
  waMock.close();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
});

async function login(username, password, expect = 200) {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(r.status, expect, `login ${username}`);
  if (expect !== 200) return null;
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (path, body, method) => {
    const res = await fetch(B + path, { method: method || (body ? 'POST' : 'GET'), headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
}
const pub = async (path, body) => {
  // The form sends every field, the name included: by default keep the nurse's current name.
  if (body && path.endsWith('/details') && !('name' in body)) {
    const form = await pub(path.replace(/details$/, 'form'));
    body = { ...body, name: form.body.nurse?.name };
  }
  const res = await fetch(`${B}/api/public/reg/${path}`, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
// Documents are uploaded as multipart/form-data (type + file), the way the React portal sends them.
const uploadDoc = async (t, type, buf, filename = 'x.pdf', mime = 'application/pdf') => {
  const form = new FormData();
  form.append('type', type);
  form.append('file', new Blob([buf], { type: mime }), filename);
  const res = await fetch(`${B}/api/public/reg/${t}/documents`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
};
const tokenOf = async (staff, id) => new URL((await staff('/api/nurses/' + id)).body.nurse.registration_url).searchParams.get('t');
const DETAILS = { consent: true, address: 'x', pincode: '627811', email: 'nurse@example.com', taluk: 'y', preferred_locations: 'Tenkasi, Tenkasi (Tenkasi)', qualification: 'GNM Diploma',
  council_reg_no: 'TN1', current_employment: 'Not working', experience_years: 0, work_preference: 'Part-time', service_interests: 'Home nursing' };
const BANK = { account_holder: 'Test Nurse', account_number: '123456789', account_number_confirm: '123456789', ifsc: 'SBIN0001234' };

test('full flow: add & invite → nurse registers → documents → review → verified → bank details', async () => {
  const admin = await login('tenkasi.admin', 'Tenkasi@123');
  const created = await admin('/api/nurses', { name: 'Kavya Test', mobile: '+91 99999 00001', invite: true });
  assert.equal(created.status, 200);
  const id = created.body.id;
  let n = (await admin('/api/nurses/' + id)).body;
  assert.equal(n.nurse.district, 'Tenkasi', 'district admin creates in own district');
  assert.equal(n.nurse.status, 'INVITED');
  assert.equal((await admin(`/api/nurses/${id}/transition`, { to: 'INVITED' })).status, 200, 'resend invite');
  await sayHi('919999900001', `Hi Uyir Team, I want to register. My code: ${n.nurse.wa_code}`);   // nurse taps the link in the SMS

  const t = await tokenOf(admin, id);
  // No OTP: the personal link opens the form straight away.
  assert.equal((await pub(`${t}/otp`, {})).status, 404, 'OTP endpoint removed');
  assert.equal((await pub(`${t}/form`)).body.nurse.status, 'INVITED');
  assert.equal((await pub(`${t}/details`, { ...DETAILS, consent: false })).status, 400, 'consent required');
  for (const pincode of ['12345', '560001', '6278110', 'abcdef']) {
    assert.equal((await pub(`${t}/details`, { ...DETAILS, pincode })).status, 400, `pincode ${pincode} refused (Tamil Nadu, 6 digits)`);
  }
  for (const k of ['name', 'email', 'pincode', 'preferred_locations', 'current_employment', 'experience_years', 'service_interests']) {
    assert.equal((await pub(`${t}/details`, { ...DETAILS, [k]: '' })).status, 400, `${k} required`);
  }
  assert.equal((await pub(`${t}/details`, { ...DETAILS, preferred_locations: 'Melur, Melur (Madurai); Tenkasi, Tenkasi (Tenkasi)' })).status, 400, 'only one work location');
  assert.equal((await pub(`${t}/details`, DETAILS)).status, 200);
  assert.equal((await admin('/api/nurses/' + id)).body.nurse.status, 'REGISTERED');
  // District → Taluk → Village choices for the preferred work location.
  const form = (await pub(`${t}/form`)).body;
  assert.ok(form.taluks.Madurai.includes('Melur'));
  const vill = await pub(`${t}/villages?district=Madurai&taluk=Melur`);
  assert.equal(vill.status, 200);
  assert.ok(vill.body.villages.length > 50, 'Melur taluk has its revenue villages');
  assert.equal((await pub(`${t}/villages?district=Madurai&taluk=Nowhere`)).status, 404);
  assert.equal((await admin(`/api/nurses/${id}/transition`, { to: 'SUBMITTED' })).status, 409, 'staff cannot submit for the nurse');

  // Step 2: bank details, before the documents. Submitted once.
  assert.equal((await pub(`${t}/form`)).body.payout.needed, true, 'bank details asked right after the details');
  const bank = { account_holder: 'Kavya T', account_number: '123456789012', account_number_confirm: '123456789012', ifsc: 'sbin0001234' };
  assert.equal((await pub(`${t}/payout`, { ...bank, account_number_confirm: '1' })).status, 400, 'account numbers must match');
  assert.equal((await pub(`${t}/payout`, { ...bank, ifsc: 'BAD' })).status, 400, 'IFSC validated');
  // Every bank's format: short co-operative numbers, letters, spaces and hyphens.
  assert.equal((await pub(`${t}/payout`, { ...bank, account_number: '12345', account_number_confirm: '12345' })).status, 400, 'too short');
  for (const [raw, clean] of [['1234567', '1234567'], ['sb-0012 345a', 'SB0012345A'], ['1234 5678-9012', '123456789012']]) {
    assert.equal(cleanAccountNumber(raw), clean);
    assert.ok(ACCOUNT_RE.test(clean), `${raw} accepted`);
  }

  // Step 3: documents. They cannot be submitted before the bank details.
  const pdf = readFileSync(join(DATA_DIR, 'uploads', 'demo-sample.pdf'));
  assert.equal((await pub(`${t}/submit-docs`, {})).status, 400, 'cannot submit with missing docs');
  assert.equal((await uploadDoc(t, 'GOVT_ID', Buffer.from('not a pdf'))).status, 400, 'content sniffed');
  for (const type of ['QUALIFICATION', 'COUNCIL_REG', 'GOVT_ID']) assert.equal((await uploadDoc(t, type, pdf)).status, 200);
  const noBank = await pub(`${t}/submit-docs`, {});
  assert.equal(noBank.status, 409, 'bank details come before submitting documents');
  assert.match(noBank.body.error, /bank details first/);
  // Spaces and hyphens are ignored (saved as 123456789012).
  assert.equal((await pub(`${t}/payout`, { ...bank, account_number: '1234 5678-9012' })).status, 200);
  // Submitted once: no changes afterwards.
  const again = await pub(`${t}/payout`, { ...bank, account_number: '999999999', account_number_confirm: '999999999' });
  assert.equal(again.status, 409, 'bank details cannot be changed after submission');
  assert.match(again.body.error, /cannot be changed/);
  assert.equal((await pub(`${t}/social/confirm`, {})).status, 409, 'follow step comes after submitting documents');
  assert.equal((await pub(`${t}/submit-docs`, {})).status, 200);

  // "Follow us": every page must be opened before confirming; each opening is recorded once.
  let social = (await pub(`${t}/form`)).body.social;
  assert.equal(social.needed, true);
  assert.deepEqual(Object.keys(social.links), ['instagram', 'facebook', 'youtube']);
  assert.equal((await pub(`${t}/social/open`, { network: 'tiktok' })).status, 400);
  await pub(`${t}/social/open`, { network: 'instagram' });
  await pub(`${t}/social/open`, { network: 'instagram' });
  const notYet = await pub(`${t}/social/confirm`, {});
  assert.equal(notYet.status, 400);
  assert.match(notYet.body.error, /Facebook, YouTube/);
  for (const k of ['facebook', 'youtube']) await pub(`${t}/social/open`, { network: k });
  assert.equal((await pub(`${t}/social/confirm`, {})).status, 200);
  social = (await pub(`${t}/form`)).body.social;
  assert.equal(social.needed, false);
  assert.ok(social.followed_at);
  const ev = (await admin('/api/nurses/' + id)).body.events;
  assert.equal(ev.filter(e => /Opened Uyir's Instagram page/.test(e.note || '')).length, 1, 'opening recorded once');
  assert.ok(ev.some(e => /Confirmed following Uyir/.test(e.note || '')));

  assert.equal((await admin(`/api/nurses/${id}/transition`, { to: 'VERIFIED' })).status, 409, 'docs must be reviewed first');
  assert.equal((await admin(`/api/nurses/${id}/transition`, { to: 'REJECTED' })).status, 400, 'reason required');
  for (const d of (await admin('/api/nurses/' + id)).body.documents) await admin(`/api/nurses/${id}/documents/${d.id}/review`, { status: 'VERIFIED' });
  assert.equal((await admin(`/api/nurses/${id}/transition`, { to: 'VERIFIED' })).status, 200);

  n = (await admin('/api/nurses/' + id)).body;
  assert.equal(n.nurse.status, 'VERIFIED');
  assert.equal(n.nurse.stage_reached, 4);
  assert.equal(n.nurse.payout_account_enc, undefined, 'encrypted account number never leaves the server');
  assert.equal(n.nurse.payout_account_last4, '9012');
  assert.deepEqual(n.messages.map(m => `${m.channel}:${m.template}`).reverse(),
    ['sms:INVITE', 'sms:INVITE_AGAIN', 'whatsapp:REG_LINK', 'whatsapp:REG_DONE', 'whatsapp:VERIFIED']);

  const csv = await admin('/api/nurses/export.csv?q=' + id);
  assert.match(csv.body, /council_reg_no/);
  assert.match(csv.body, new RegExp(`${id},Kavya Test,9999900001,Tenkasi,Verified`));
  assert.ok(!csv.body.includes('123456789012'), 'full account number is never exported');
});

test('experience documents are optional (only if applicable), even with experience declared', async () => {
  const admin = await login('tenkasi.admin', 'Tenkasi@123');
  const { id } = (await admin('/api/nurses', { name: 'Exp Test', mobile: '9999900003', invite: true })).body;
  const t = await tokenOf(admin, id);
  await pub(`${t}/details`, { ...DETAILS, experience_years: 0 });
  assert.ok(!(await pub(`${t}/form`, undefined)).body.missing.includes('EXPERIENCE'));
  await pub(`${t}/details`, { ...DETAILS, experience_years: 4 });
  assert.ok(!(await pub(`${t}/form`, undefined)).body.missing.includes('EXPERIENCE'));
});

test('District Admins are confined to their own district', async () => {
  const tenkasi = await login('tenkasi.admin', 'Tenkasi@123');
  const sup = await login('admin', 'Admin@123');
  const chennaiNurse = (await sup('/api/nurses?district=Chennai&size=1')).body.rows[0];

  assert.deepEqual((await tenkasi('/api/dashboard')).body.districts.map(x => x.district), ['Tenkasi']);
  assert.ok((await tenkasi('/api/nurses?district=Chennai&size=200')).body.rows.every(r => r.district === 'Tenkasi'), 'district filter ignored');
  assert.equal((await tenkasi('/api/nurses/' + chennaiNurse.id)).status, 404);
  assert.equal((await tenkasi(`/api/nurses/${chennaiNurse.id}/transition`, { to: 'INVITED' })).status, 404);
  assert.equal((await tenkasi(`/api/nurses/${chennaiNurse.id}/note`, { note: 'x' })).status, 404);
  assert.equal((await tenkasi('/api/nurses/bulk', { action: 'invite', ids: [chennaiNurse.id] })).body.done, 0);
  assert.ok(!(await tenkasi('/api/nurses/export.csv')).body.includes(',Chennai,'), 'export is district-scoped');
  assert.equal((await tenkasi('/api/users')).status, 403, 'no staff management');

  const own = (await tenkasi('/api/nurses?size=1')).body.rows[0];
  assert.equal((await tenkasi(`/api/nurses/${own.id}`, { district: 'Chennai' }, 'PATCH')).status, 403, 'cannot move nurses out');
  const made = await tenkasi('/api/nurses', { name: 'Elsewhere', mobile: '9999900077', district: 'Chennai' });
  assert.equal((await tenkasi('/api/nurses/' + made.body.id)).body.nurse.district, 'Tenkasi', 'district in body is ignored');
});

test('Super Admin works across districts and manages staff', async () => {
  const sup = await login('admin', 'Admin@123');
  const d = (await sup('/api/dashboard')).body;
  assert.ok(d.districts.length > 5, 'sees all districts');

  // Move a nurse between districts: the old District Admin loses access, the new one gains it.
  const nurse = (await sup('/api/nurses?district=Tenkasi&status=NEW&size=1')).body.rows[0];
  const tenkasi = await login('tenkasi.admin', 'Tenkasi@123');
  const chennai = await login('chennai.admin', 'Chennai@123');
  assert.equal((await sup(`/api/nurses/${nurse.id}`, { district: 'Chennai' }, 'PATCH')).status, 200);
  assert.equal((await tenkasi('/api/nurses/' + nurse.id)).status, 404);
  assert.equal((await chennai('/api/nurses/' + nurse.id)).status, 200);

  // Staff accounts
  assert.equal((await sup('/api/users', { username: 'salem.admin', name: 'Salem', role: 'district_admin', password: 'Salem@1234' })).status, 400, 'district required');
  assert.equal((await sup('/api/users', { username: 'x.super', name: 'X', role: 'super_admin', district: 'Salem', password: 'Super@1234' })).status, 400, 'super admin has no district');
  const { id } = (await sup('/api/users', { username: 'salem.admin', name: 'Salem', role: 'district_admin', district: 'Salem', password: 'Salem@1234' })).body;
  const salem = await login('salem.admin', 'Salem@1234');
  assert.ok((await salem('/api/nurses?size=200')).body.rows.every(r => r.district === 'Salem'));
  assert.equal((await sup(`/api/users/${id}`, { district: 'Erode' }, 'PATCH')).status, 200);
  assert.equal((await salem('/api/me')).status, 401, 'sessions end when access changes');
  const erode = await login('salem.admin', 'Salem@1234');
  assert.equal((await erode('/api/me')).body.user.district, 'Erode');
  assert.equal((await sup(`/api/users/${id}`, { district: null }, 'PATCH')).status, 400, 'cannot leave a District Admin without a district');
  const me = (await sup('/api/me')).body.user;
  assert.equal((await sup(`/api/users/${me.id}`, { active: false }, 'PATCH')).status, 400, 'cannot deactivate yourself');
});

test('old CRM data is upgraded on startup', async () => {
  const sup = await login('admin', 'Admin@123');
  const st = async id => (await sup('/api/nurses/' + id)).body.nurse;
  assert.equal((await st('UYIR-NUR-900001')).status, 'INVITED');
  assert.equal((await st('UYIR-NUR-900002')).status, 'VERIFIED');
  assert.equal((await st('UYIR-NUR-900003')).status, 'NEW');
  assert.equal((await st('UYIR-NUR-900002')).stage_reached, 4);
  const coord = await login('old.coord', 'Legacy@123');
  assert.equal((await coord('/api/me')).body.user.role, 'district_admin', 'coordinator → District Admin');
  await login('old.caller', 'Legacy@123', 401);   // deactivated: role no longer exists
  await login('old.verifier', 'Legacy@123', 401);
  const users = (await sup('/api/users')).body.rows;
  assert.ok(users.every(u => ['super_admin', 'district_admin'].includes(u.role)));
});

test('concurrent writes: unique IDs, duplicate mobile → 409, no double invite', async () => {
  const sup = await login('admin', 'Admin@123');
  const made = await Promise.all(Array.from({ length: 20 }, (_, i) => sup('/api/nurses', { name: `Par ${i}`, mobile: `97777${String(i).padStart(5, '0')}`, district: 'Salem' })));
  assert.ok(made.every(r => r.status === 200));
  assert.equal(new Set(made.map(r => r.body.id)).size, 20, 'sequence gives unique IDs under concurrency');
  const dup = await Promise.all([1, 2].map(() => sup('/api/nurses', { name: 'Dup', mobile: '9666600000', district: 'Salem' })));
  assert.deepEqual(dup.map(r => r.status).sort(), [200, 409]);

  // Two admins bulk-invite the same nurses at the same moment: each nurse gets exactly one invite.
  const ids = made.map(r => r.body.id);
  const [a, b] = await Promise.all([1, 2].map(() => sup('/api/nurses/bulk', { action: 'invite', ids })));
  assert.equal(a.body.done + b.body.done, 20);
  for (const id of ids.slice(0, 5)) assert.equal((await sup('/api/nurses/' + id)).body.messages.filter(m => m.template.startsWith('INVITE')).length, 1);
});

test('Do Not Contact blocks invites and needs a reason to lift', async () => {
  const admin = await login('tenkasi.admin', 'Tenkasi@123');
  const { id } = (await admin('/api/nurses', { name: 'DNC Test', mobile: '9999900002' })).body;
  await admin(`/api/nurses/${id}/consent`, { dnc: true, reason: 'Asked not to be contacted' });
  assert.equal((await admin(`/api/nurses/${id}/transition`, { to: 'INVITED' })).status, 409);
  assert.equal((await admin('/api/nurses/bulk', { action: 'invite', ids: [id] })).body.done, 0);
  assert.equal((await admin(`/api/nurses/${id}/consent`, { dnc: false })).status, 400, 'reason required');
  assert.equal((await admin(`/api/nurses/${id}/consent`, { dnc: false, reason: 'Nurse called helpline' })).status, 200);
  assert.equal((await admin(`/api/nurses/${id}/transition`, { to: 'INVITED' })).status, 200);
});

test('import: Super Admin any district, District Admin own district only', async () => {
  const sup = await login('admin', 'Admin@123');
  const csv = 'Nurse ID,Name,Mobile Number,District\n,"Rani, S",+91 98888 00001,Trichy\n,Bad,123,Madurai\n,Dup,9888800001,Madurai\n,Nowhere,9888800002,Atlantis\n';
  const dry = await sup('/api/import', { csv, dry_run: true });
  assert.equal(dry.body.valid, 1);
  assert.equal(dry.body.errorCount, 3);
  assert.equal((await sup('/api/import', { csv })).body.inserted, 1);
  const row = (await sup('/api/nurses?q=9888800001')).body.rows[0];
  assert.equal(row.district, 'Tiruchirappalli');
  assert.equal(row.status, 'NEW');

  const tenkasi = await login('tenkasi.admin', 'Tenkasi@123');
  const r = await tenkasi('/api/import', { csv: 'Name,Mobile,District\nA One,9888800011,\nB Two,9888800012,Tenkasi\nC Three,9888800013,Madurai\n' });
  assert.equal(r.body.inserted, 2);
  assert.match(r.body.errors[0].reason, /outside your district/);
  assert.equal((await tenkasi('/api/import', { csv: 'Name,Mobile\nD Four,9888800014\n' })).body.inserted, 1, 'district column optional');
});

test('health check responds for the load balancer', async () => {
  const r = await fetch(B + '/healthz');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).storage, 'local');
});

const until = async (fn, ms = 5000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };
const signedPost = (body, secret = WA.WHATSAPP_APP_SECRET) => {
  const raw = JSON.stringify(body);
  return fetch(B + '/api/whatsapp/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex') }, body: raw });
};
const statusUpdate = (id, status) => ({ entry: [{ changes: [{ value: { statuses: [{ id, status }] } }] }] });

test('WhatsApp: correction reaches the nurse; delivery status comes back by webhook', async () => {
  const admin = await login('tenkasi.admin', 'Tenkasi@123');
  const { id } = (await admin('/api/nurses', { name: 'Meena Wa', mobile: '9999900055', invite: true })).body;
  assert.ok(!waSent.some(m => m.body.to === '919999900055'), 'no WhatsApp without opt-in');

  const t = await tokenOf(admin, id);
  await pub(`${t}/details`, { ...DETAILS, consent_whatsapp: true });
  const pdf = readFileSync(join(DATA_DIR, 'uploads', 'demo-sample.pdf'));
  await pub(`${t}/payout`, BANK);
  for (const type of ['QUALIFICATION', 'COUNCIL_REG', 'GOVT_ID']) await uploadDoc(t, type, pdf);
  assert.equal((await pub(`${t}/submit-docs`, {})).status, 200);
  const doc = (await admin('/api/nurses/' + id)).body.documents.find(d => d.type === 'COUNCIL_REG');
  await admin(`/api/nurses/${id}/documents/${doc.id}/review`, { status: 'CORRECTION', note: 'Certificate is blurred' });
  assert.equal((await admin(`/api/nurses/${id}/transition`, { to: 'CORRECTION_REQUIRED', note: 'Council certificate is blurred' })).status, 200);

  const sent = await until(() => waSent.find(m => m.body.to === '919999900055' && m.body.template?.name === 'uyir_correction_required'));
  assert.equal(sent.auth, 'Bearer test-token');
  assert.ok(sent.url.endsWith('/1234567890/messages'), sent.url);
  const params = sent.body.template.components[0].parameters.map(p => p.text);
  assert.equal(params[0], 'Meena');
  assert.equal(params[1], 'Council certificate is blurred');
  assert.ok(params[2].endsWith('/register?t=' + t), params[2]);

  const msg = await until(async () => (await admin('/api/nurses/' + id)).body.messages.find(m => m.channel === 'whatsapp' && m.template === 'CORRECTION' && m.status === 'sent'));
  assert.match(msg.provider_id, /^wamid.TEST/);
  assert.ok(!(await admin('/api/nurses/' + id)).body.messages.some(m => m.channel === 'sms' && m.template === 'CORRECTION'), 'no SMS after the invite');

  // Delivery receipts from Meta
  assert.equal((await signedPost(statusUpdate(msg.provider_id, 'read'), 'wrong-secret')).status, 401, 'unsigned / wrongly signed webhook rejected');
  assert.equal((await signedPost(statusUpdate(msg.provider_id, 'read'))).status, 200);
  await signedPost(statusUpdate(msg.provider_id, 'delivered'));   // arrives late: must not move status backwards
  const after = (await admin('/api/nurses/' + id)).body.messages.find(m => m.id === msg.id);
  assert.equal(after.status, 'read');

  const hs = await fetch(B + '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=42');
  assert.equal(await hs.text(), '42');
  assert.equal((await fetch(B + '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42')).status, 403);
});

test('WhatsApp: permanent errors are marked failed; Do Not Contact sends nothing', async () => {
  const admin = await login('tenkasi.admin', 'Tenkasi@123');
  const { id } = (await admin('/api/nurses', { name: 'Bad Number', mobile: '9999900099', invite: true })).body;
  await sayHi('919999900099', 'Hi Uyir ' + (await admin('/api/nurses/' + id)).body.nurse.wa_code);
  const failed = await until(async () => (await admin('/api/nurses/' + id)).body.messages.find(m => m.channel === 'whatsapp' && m.status === 'failed'));
  assert.match(failed.error, /131026/);

  const dnc = (await admin('/api/nurses', { name: 'No Contact', mobile: '9999900066' })).body.id;
  await admin(`/api/nurses/${dnc}/consent`, { consent_whatsapp: true, dnc: true, reason: 'Asked' });
  assert.equal((await admin('/api/nurses/' + dnc)).body.messages.length, 0);
});

// ---------------- SMS invite → "Hi" on WhatsApp → registration link ----------------
let inboundSeq = 0;
function sayHi(from, text, id = 'wamid.IN' + ++inboundSeq) {
  return signedPost({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'Test Nurse' } }], messages: [{ id, from, type: 'text', text: { body: text } }] } }] }] })
    .then(async r => { assert.equal(r.status, 200); return r.json(); });
}

test('invite SMS carries our WhatsApp chat link; a nurse who says "Hi" on WhatsApp is still matched', async () => {
  const admin = await login('tenkasi.admin', 'Tenkasi@123');
  const made = (await admin('/api/nurses', { name: 'Anitha Flow', mobile: '9999900121', invite: true })).body;
  assert.deepEqual(made.notified, ['sms']);
  let n = (await admin('/api/nurses/' + made.id)).body;
  const code = n.nurse.wa_code;
  assert.match(code, /^UY[2-9A-HJ-NP-Z]{6}$/);
  const sms = n.messages.find(m => m.template === 'INVITE');
  assert.equal(sms.channel, 'sms');
  assert.ok(sms.body.includes(`https://wa.me/${BUSINESS}?text=${encodeURIComponent('Hi Uyir Team, I want to register. My code: ' + code)}`), 'WhatsApp chat link with the code in the SMS: ' + sms.body);
  assert.ok(!sms.body.includes('/register?t='), 'no registration link in the SMS');
  assert.ok(sms.body.includes('Uyir Health App'), 'SMS names the Uyir Health App');
  assert.ok(!waSent.some(m => m.body.to === '919999900121'), 'no WhatsApp before the nurse messages us');

  // The nurse's WhatsApp is on a different number from the mobile we had.
  await sayHi('918888800121', `Hi Uyir ${code}`, 'wamid.DUP1');
  const reply = await until(() => waSent.find(m => m.body.to === '918888800121' && m.body.type === 'text'));
  assert.ok(reply.body.text.body.includes('/register?t=' + n.nurse.reg_token), 'free-text reply with the personal link: ' + reply.body.text.body);
  n = (await admin('/api/nurses/' + made.id)).body;
  assert.equal(n.nurse.whatsapp_number, '918888800121');
  assert.ok(n.nurse.whatsapp_connected_at && n.nurse.consent_whatsapp, 'connected = WhatsApp opt-in');
  assert.ok(n.events.some(e => /WhatsApp connected/.test(e.note || '')));

  // Meta redelivers the same webhook, and the nurse sends a second message: still one reply.
  await sayHi('918888800121', `Hi Uyir ${code}`, 'wamid.DUP1');
  await sayHi('918888800121', 'hello?');
  await new Promise(r => setTimeout(r, 400));
  assert.equal(waSent.filter(m => m.body.to === '918888800121' && m.body.type === 'text').length, 1);

  // Resend from staff now goes straight to WhatsApp with the link, not by SMS.
  const resend = await admin(`/api/nurses/${made.id}/transition`, { to: 'INVITED' });
  assert.deepEqual(resend.body.notified, ['whatsapp']);
  n = (await admin('/api/nurses/' + made.id)).body;
  assert.equal(n.messages.filter(m => m.channel === 'sms').length, 1, 'still only the first SMS');
});

test('WhatsApp: a new sender gets a record and their personal link, once', async () => {
  const sup = await login('admin', 'Admin@123');
  const tenkasi = await login('tenkasi.admin', 'Tenkasi@123');
  const from = '917777700001';
  const r = await sayHi(from, 'Hi, I want to register with Uyir Health');
  assert.equal(r.received, 1);
  const reply = await until(() => waSent.find(m => m.body.to === from && m.body.type === 'text'));
  const t = reply.body.text.body.match(/\/register\?t=([\w-]+)/)?.[1];
  assert.ok(t, 'personal registration link in the reply: ' + reply.body.text.body);

  // The record: source WhatsApp, invited, opted in, no district yet (only Super Admins see it).
  const list = (await sup('/api/nurses?q=7777700001')).body;
  const id = list.rows.find(x => x.mobile === '7777700001')?.id;
  assert.ok(id, 'nurse record created: ' + JSON.stringify(list).slice(0, 300));
  const n = (await sup('/api/nurses/' + id)).body.nurse;
  assert.equal(n.status, 'INVITED');
  assert.equal(n.source, 'WhatsApp');
  assert.equal(n.district, null);
  assert.equal(n.name, 'Test Nurse', 'starts with the WhatsApp profile name');
  assert.equal(n.whatsapp_number, from);
  assert.ok(n.consent_whatsapp && n.whatsapp_connected_at);
  assert.equal((await tenkasi('/api/nurses/' + id)).status, 404, 'district admins do not see it yet');

  // Messaging again, later, does not send the link again.
  await sayHi(from, 'hello, did not get it?');
  await new Promise(r => setTimeout(r, 400));
  assert.equal(waSent.filter(m => m.body.to === from).length, 1, 'registration link sent only once');

  // The form asks for name and district; then the record belongs to that district.
  const form = (await pub(`${t}/form`)).body;
  assert.equal(form.nurse.needs_profile, true);
  assert.ok(form.districts.includes('Tenkasi'));
  assert.equal((await pub(`${t}/details`, { ...DETAILS })).status, 400, 'district required');
  assert.equal((await pub(`${t}/details`, { ...DETAILS, name: 'Kavitha R', district: 'Nowhere' })).status, 400);
  assert.equal((await pub(`${t}/details`, { ...DETAILS, name: 'Kavitha R', district: 'tenkasi' })).status, 200);
  const done = (await tenkasi('/api/nurses/' + id)).body.nurse;
  assert.equal(done.name, 'Kavitha R');
  assert.equal(done.district, 'Tenkasi');
  assert.equal(done.status, 'REGISTERED');
  assert.equal((await pub(`${t}/form`)).body.nurse.needs_profile, false);
});

test('WhatsApp: two first messages at once create one record and one reply; foreign numbers are told why', async () => {
  const from = '917777700002';
  await Promise.all([sayHi(from, 'Hi'), sayHi(from, 'Hi again'), sayHi(from, 'Hi', 'wamid.SAME'), sayHi(from, 'Hi', 'wamid.SAME')]);
  await until(() => waSent.find(m => m.body.to === from));
  await new Promise(r => setTimeout(r, 400));
  assert.equal(waSent.filter(m => m.body.to === from).length, 1);
  const sup = await login('admin', 'Admin@123');
  const list = (await sup('/api/nurses?q=7777700002')).body;
  assert.equal(list.rows.filter(x => x.mobile === '7777700002').length, 1);

  // A reply that failed permanently is retried on the nurse's next message (once it succeeds, no more).
  WA_BAD.add('917777700003');
  await sayHi('917777700003', 'Hi');
  await until(() => waSent.find(m => m.body.to === '917777700003'));
  await new Promise(r => setTimeout(r, 300));
  WA_BAD.delete('917777700003');
  await sayHi('917777700003', 'Hi, still waiting');
  await until(() => waSent.filter(m => m.body.to === '917777700003').length === 2);
  await sayHi('917777700003', 'thanks');
  await new Promise(r => setTimeout(r, 400));
  assert.equal(waSent.filter(m => m.body.to === '917777700003').length, 2, 'failed once, sent once, then no more');

  await sayHi('447700900123', 'Hi');
  const nf = await until(() => waSent.find(m => m.body.to === '447700900123'));
  assert.match(nf.body.text.body, /Indian mobile number/);
});

test('WhatsApp inbound: match by number, Do Not Contact', async () => {
  const admin = await login('tenkasi.admin', 'Tenkasi@123');

  // A nurse we never invited messages us from their own mobile: invited quietly, link in the reply, no SMS.
  const quiet = (await admin('/api/nurses', { name: 'Self Start', mobile: '9999900131' })).body.id;
  await sayHi('919999900131', 'Hi');
  await until(() => waSent.find(m => m.body.to === '919999900131' && m.body.type === 'text'));
  const q = (await admin('/api/nurses/' + quiet)).body;
  assert.equal(q.nurse.status, 'INVITED');
  assert.ok(!q.messages.some(m => m.channel === 'sms'));

  // Do Not Contact: no reply, and staff see why.
  const dnc = (await admin('/api/nurses', { name: 'Dnc Hi', mobile: '9999900141' })).body.id;
  await admin(`/api/nurses/${dnc}/consent`, { dnc: true, reason: 'Asked' });
  await sayHi('919999900141', 'Hi');
  await new Promise(r => setTimeout(r, 400));
  assert.ok(!waSent.some(m => m.body.to === '919999900141'));
  assert.ok((await admin('/api/nurses/' + dnc)).body.events.some(e => /Do Not Contact; no reply/.test(e.note || '')));
});

test('Call / SMS from the admin phone, and the call status log', async () => {
  const admin = await login('tenkasi.admin', 'Tenkasi@123');
  const id = (await admin('/api/nurses', { name: 'Phone Contact', mobile: '9999900151' })).body.id;
  const d = (await admin('/api/nurses/' + id)).body;
  assert.equal(d.contact.tel, 'tel:+919999900151');
  assert.ok(d.contact.sms.startsWith('sms:+919999900151?body='));
  // The SMS carries our WhatsApp chat link with the nurse's code, not the registration link.
  assert.match(d.nurse.wa_code, /^UY[2-9A-HJ-NP-Z]{6}$/);
  assert.ok(d.contact.sms_body.includes(`https://wa.me/${BUSINESS}?text=${encodeURIComponent('Hi Uyir Team, I want to register. My code: ' + d.nurse.wa_code)}`), d.contact.sms_body);
  assert.ok(!d.contact.sms_body.includes('/register'), d.contact.sms_body);
  assert.equal(d.nurse.status, 'NEW', 'opening the page does not invite the nurse');

  assert.equal((await admin(`/api/nurses/${id}/contact`, { channel: 'call' })).status, 200);
  assert.equal((await admin(`/api/nurses/${id}/contact`, { channel: 'sms' })).status, 200);
  // Sending the SMS from the admin's phone is the invite: the link now opens the form, and no
  // system SMS is recorded on top of the admin's own.
  const after = (await admin('/api/nurses/' + id)).body;
  assert.equal(after.nurse.status, 'INVITED');
  assert.equal(after.nurse.wa_code, d.nurse.wa_code, 'same code as in the SMS');
  assert.ok(!after.messages.some(m => m.channel === 'sms'));
  const t = new URL(after.nurse.registration_url).searchParams.get('t');
  assert.equal((await pub(`${t}/form`)).body.nurse.status, 'INVITED');
  assert.equal((await admin(`/api/nurses/${id}/call-log`, { outcome: 'BOGUS' })).status, 400);
  assert.equal((await admin(`/api/nurses/${id}/call-log`, { outcome: 'CALL_BACK', note: 'Free after 6 pm' })).status, 200);
  const ev = (await admin('/api/nurses/' + id)).body.events;
  assert.ok(ev.some(e => e.type === 'call' && /Call started/.test(e.note)));
  assert.ok(ev.some(e => e.type === 'sms' && /WhatsApp chat link/.test(e.note)));
  assert.ok(ev.some(e => e.type === 'call' && e.note === 'Call status: Asked to call back later — Free after 6 pm' && e.actor === 'tenkasi.admin'));

  // Do Not Contact: no links, and the endpoints refuse.
  await admin(`/api/nurses/${id}/consent`, { dnc: true, reason: 'Asked' });
  const blocked = (await admin('/api/nurses/' + id)).body.contact;
  assert.equal(blocked.tel, null);
  assert.equal(blocked.sms, null);
  assert.equal((await admin(`/api/nurses/${id}/contact`, { channel: 'call' })).status, 409);
});

test('uploads: size limit, type from file contents, valid link required', async () => {
  const admin = await login('tenkasi.admin', 'Tenkasi@123');
  const { id } = (await admin('/api/nurses', { name: 'Upload Test', mobile: '9999900161', invite: true })).body;
  const t = await tokenOf(admin, id);
  await pub(`${t}/details`, DETAILS);

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  assert.equal((await uploadDoc('not-a-real-link-token', 'GOVT_ID', png)).status, 404, 'needs a valid registration link');
  assert.equal((await uploadDoc(t, 'NOPE', png)).status, 400, 'unknown document type');
  assert.equal((await uploadDoc(t, 'GOVT_ID', Buffer.alloc(25 * 1024 * 1024 + 10, 0x25))).status, 413, 'over 25 MB');
  // Over 5 MB: photos are refused (the portal compresses them first); a PDF that cannot be compressed below 5 MB is refused.
  assert.equal((await uploadDoc(t, 'GOVT_ID', Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]))).status, 413, 'photo over 5 MB');
  assert.equal((await uploadDoc(t, 'GOVT_ID', Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(5 * 1024 * 1024)]))).status, 413, 'incompressible PDF over 5 MB');
  // The browser says PDF, the bytes say PNG: stored as what it really is.
  assert.equal((await uploadDoc(t, 'GOVT_ID', png, 'id.pdf', 'application/pdf')).status, 200);
  const doc = (await admin('/api/nurses/' + id)).body.documents.find(d => d.type === 'GOVT_ID');
  assert.equal(doc.mime, 'image/png');
  const file = await admin(`/api/documents/${doc.id}/file`);
  assert.equal(file.status, 200, 'staff can open the stored file');

  // A second upload of the same type replaces the first.
  assert.equal((await uploadDoc(t, 'GOVT_ID', png)).status, 200);
  const live = (await admin('/api/nurses/' + id)).body.documents.filter(d => d.type === 'GOVT_ID' && d.status !== 'SUPERSEDED');
  assert.equal(live.length, 1);
});

test('privacy policy and data deletion pages are plain HTML (they work without JavaScript)', async () => {
  for (const [path, heading] of [['/privacy', 'Privacy Policy'], ['/data-deletion', 'Data Deletion']]) {
    const res = await fetch(B + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.ok(html.includes(`<h1>${heading}</h1>`), `${path} has its content in the HTML, not only the app shell`);
    assert.ok(!html.includes('id="root"'), `${path} is not the single-page app`);
  }
});

test('security: cross-site requests refused, secrets never returned, headers set', async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ username: 'admin', password: 'Admin@123' }) });
  assert.equal(r.status, 403, 'foreign Origin refused');
  const ok = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B }, body: JSON.stringify({ username: 'admin', password: 'Admin@123' }) });
  assert.equal(ok.status, 200, 'own origin allowed');
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(ok.headers.get('set-cookie'), /SameSite=Lax/i);
  assert.ok(ok.headers.get('content-security-policy')?.includes("default-src 'self'"));
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(ok.headers.get('x-request-id'));
  assert.equal(ok.headers.get('x-powered-by'), null);

  assert.equal((await fetch(B + '/api/nurses')).status, 401, 'staff API needs a session');
  assert.equal((await fetch(B + '/api/nope')).status, 404);
  const bad = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400);

  const sup = await login('admin', 'Admin@123');
  const n = (await sup('/api/nurses?status=INVITED&size=1')).body.rows[0];
  const detail = (await sup('/api/nurses/' + n.id)).body.nurse;
  for (const k of ['reg_session', 'otp_hash', 'payout_account_enc']) assert.ok(!(k in detail), `${k} not exposed`);
});

test('staff correct registration answers; each edit is in the history', async () => {
  const admin = await login('tenkasi.admin', 'Tenkasi@123');
  const { id } = (await admin('/api/nurses', { name: 'Edit Me', mobile: '9999900181', invite: true })).body;
  await pub(`${await tokenOf(admin, id)}/details`, { ...DETAILS, address: 'Old street' });
  assert.equal((await admin('/api/nurses/' + id, { email: 'not-an-email' }, 'PATCH')).status, 400);
  assert.equal((await admin('/api/nurses/' + id, { address: ' 12 New Street ', experience_years: '7', block: '' }, 'PATCH')).status, 200);
  const d = (await admin('/api/nurses/' + id)).body;
  assert.equal(d.nurse.address, '12 New Street');
  assert.equal(d.nurse.experience_years, 7);
  assert.ok(d.events.some(e => /Address: Old street → 12 New Street/.test(e.note || '') && /Experience/.test(e.note)), 'edit recorded');
  const chennai = await login('chennai.admin', 'Chennai@123');
  assert.equal((await chennai('/api/nurses/' + id, { address: 'x' }, 'PATCH')).status, 404, 'other districts cannot edit');
});

test('nurse changes their district on the form: the record moves to that district', async () => {
  const admin = await login('tenkasi.admin', 'Tenkasi@123');
  const { id } = (await admin('/api/nurses', { name: 'Mover', mobile: '9999900193', invite: true })).body;
  const t = await tokenOf(admin, id);
  assert.equal((await pub(`${t}/details`, { ...DETAILS, district: 'Nowhere' })).status, 400);
  assert.equal((await pub(`${t}/details`, { ...DETAILS, district: 'Chennai' })).status, 200);
  const chennai = await login('chennai.admin', 'Chennai@123');
  const d = (await chennai('/api/nurses/' + id)).body;
  assert.equal(d.nurse.district, 'Chennai');
  assert.ok(d.events.some(e => /district Tenkasi → Chennai/.test(e.note || '')), 'change recorded');
});

test('Super Admin deletes a nurse: personal data and documents erased, ID and audit kept', async () => {
  const admin = await login('tenkasi.admin', 'Tenkasi@123');
  const sup = await login('admin', 'Admin@123');
  const { id } = (await admin('/api/nurses', { name: 'Erase Me', mobile: '9999900191', invite: true })).body;
  const t = await tokenOf(admin, id);
  await pub(`${t}/details`, { ...DETAILS, email: 'erase@example.com', consent_whatsapp: true });
  const pdf = readFileSync(join(DATA_DIR, 'uploads', 'demo-sample.pdf'));
  await uploadDoc(t, 'GOVT_ID', pdf);
  await sayHi('919999900191', 'Hi');
  const dir = join(DATA_DIR, 'uploads', id);
  assert.ok(existsSync(dir), 'document stored');

  assert.equal((await admin(`/api/nurses/${id}/delete`, { reason: 'x', confirm: id })).status, 403, 'District Admins cannot delete');
  assert.equal((await sup(`/api/nurses/${id}/delete`, { confirm: id })).status, 400, 'reason required');
  assert.equal((await sup(`/api/nurses/${id}/delete`, { reason: 'Asked to be deleted', confirm: 'WRONG' })).status, 400, 'typed ID required');
  const del = await sup(`/api/nurses/${id}/delete`, { reason: 'Nurse asked for erasure', confirm: id.toLowerCase() });
  assert.equal(del.status, 200);
  assert.equal(del.body.files_pending, false);
  assert.ok(del.body.files_removed >= 1);
  assert.ok(!existsSync(dir), 'documents erased from storage');

  const d = (await sup('/api/nurses/' + id)).body;
  assert.equal(d.nurse.name, 'Deleted record');
  assert.notEqual(d.nurse.mobile, '9999900191');
  for (const k of ['email', 'address', 'council_reg_no', 'whatsapp_number', 'registration_url', 'wa_code']) assert.equal(d.nurse[k], null, `${k} erased`);
  assert.ok(d.nurse.deleted_at);
  assert.equal(d.nurse.deletion_reason, 'Nurse asked for erasure');
  assert.equal(d.documents.length, 0);
  assert.ok(d.messages.every(m => m.body === ''), 'message texts erased');
  assert.ok(d.events.every(e => e.note == null || /Record deleted by/.test(e.note)), 'history notes erased');
  assert.ok(d.events.some(e => /Record deleted by .*Reason: Nurse asked for erasure/.test(e.note || '')), 'who and why kept');
  assert.ok(d.events.some(e => e.type === 'status' && e.to_status === 'REGISTERED'), 'status history kept');

  assert.equal((await pub(t)).status, 404, 'registration link no longer works');
  assert.ok((await admin('/api/nurses/' + id)).body.nurse.deleted_at, 'District Admin opening it by link sees it is deleted');
  assert.ok(!(await sup('/api/nurses?q=Erase')).body.rows.some(r => r.id === id), 'hidden from the list');
  assert.equal((await sup('/api/nurses/' + id, { name: 'Back' }, 'PATCH')).status, 409, 'cannot be changed');
  assert.equal((await sup(`/api/nurses/${id}/note`, { note: 'x' })).status, 409);
  assert.equal((await sup(`/api/nurses/${id}/delete`, { reason: 'retry', confirm: id })).status, 200, 'delete again = retry files');
  // The person can be registered again as a new record.
  assert.equal((await admin('/api/nurses', { name: 'Erase Me Again', mobile: '9999900191' })).status, 200);
});
