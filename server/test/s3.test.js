// Document storage on S3: runs the app with STORAGE_DRIVER=s3 against a stand-in S3 endpoint and
// checks what the AWS SDK actually sends (key layout, KMS encryption, checksum) and how staff view files.
// Runs after api.test.js (same throwaway database, already seeded).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL || !/test/i.test(new URL(DATABASE_URL).pathname)) throw new Error('Set TEST_DATABASE_URL (see api.test.js)');

const objects = new Map();   // key → { body, headers }
const requests = [];
const deleted = [];   // { key, version } removed through DeleteObjects
const fakeS3 = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const url = new URL(req.url, 'http://x');
  requests.push({ method: req.method, path: url.pathname, headers: req.headers });
  if (req.method === 'HEAD' && /^\/uyir-docs\/?$/.test(url.pathname)) { res.writeHead(200); return res.end(); }
  if (req.method === 'PUT') {
    objects.set(decodeURIComponent(url.pathname), { body: Buffer.concat(chunks), headers: req.headers });
    res.writeHead(200, { ETag: '"abc"' }); return res.end();
  }
  // Versioned bucket: every object has its current version plus an older one and a delete marker,
  // so erasing has to remove all of them.
  const isBucket = /^\/uyir-docs\/?$/.test(url.pathname);
  if (req.method === 'GET' && isBucket && url.searchParams.has('versions')) {
    const prefix = url.searchParams.get('prefix') || '';
    const keys = [...objects.keys()].map(k => k.replace(/^\/uyir-docs\//, '')).filter(k => k.startsWith(prefix));
    const xml = keys.map(k => `<Version><Key>${k}</Key><VersionId>v2</VersionId><IsLatest>true</IsLatest></Version><Version><Key>${k}</Key><VersionId>v1</VersionId><IsLatest>false</IsLatest></Version><DeleteMarker><Key>${k}</Key><VersionId>m1</VersionId><IsLatest>false</IsLatest></DeleteMarker>`).join('');
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult><Name>uyir-docs</Name><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${xml}</ListVersionsResult>`);
  }
  if (req.method === 'POST' && isBucket && url.searchParams.has('delete')) {
    const body = Buffer.concat(chunks).toString();
    const items = [...body.matchAll(/<Object><Key>([^<]+)<\/Key><VersionId>([^<]+)<\/VersionId><\/Object>/g)].map(m => ({ key: m[1], version: m[2] }));
    deleted.push(...items);
    for (const { key } of items) objects.delete('/uyir-docs/' + key);
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    return res.end('<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>');
  }
  res.writeHead(404); res.end();
});
await new Promise(r => fakeS3.listen(0, r));
const S3 = `http://127.0.0.1:${fakeS3.address().port}`;

const PORT = 3990 + Math.floor(Math.random() * 9);
const B = `http://localhost:${PORT}`;
const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), PUBLIC_URL: '', DATABASE_URL, WHATSAPP_PROVIDER: 'simulated',
  STORAGE_DRIVER: 's3', S3_BUCKET: 'uyir-docs', S3_ENDPOINT: S3, S3_KMS_KEY_ID: 'arn:aws:kms:ap-south-1:111122223333:key/test',
  AWS_REGION: 'ap-south-1', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', HEALTH_CHECK_STORAGE: '1',
};
let srv;
before(async () => {
  srv = spawn(process.execPath, ['src/index.js'], { env, stdio: process.env.TEST_SERVER_LOG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 80; i++) { try { await fetch(B + '/healthz'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
});
after(() => { srv?.kill(); fakeS3.close(); });

const json = async (path, { body, cookie, session } = {}) => {
  const r = await fetch(B + path, { method: body ? 'POST' : 'GET', redirect: 'manual',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(session ? { 'x-reg-session': session } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, headers: r.headers, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
};

test('documents are written to S3 with KMS encryption and viewed through presigned URLs', async () => {
  const health = await json('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.body.storage, 's3');
  assert.ok(requests.some(r => r.method === 'HEAD' && r.path.startsWith('/uyir-docs')), 'health check reaches the bucket');

  const login = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'tenkasi.admin', password: 'Tenkasi@123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { id } = (await json('/api/nurses', { cookie, body: { name: 'S3 Nurse', mobile: '9999900171', invite: true } })).body;
  const t = new URL((await json('/api/nurses/' + id, { cookie })).body.nurse.registration_url).searchParams.get('t');
  const otp = (await json(`/api/public/reg/${t}/otp`, { body: {} })).body.dev_otp;
  const session = (await json(`/api/public/reg/${t}/verify`, { body: { otp } })).body.session;
  await json(`/api/public/reg/${t}/details`, { session, body: { consent: true, name: 'S3 Nurse', address: 'x', pincode: '627811', email: 's3@example.com', taluk: 'y', preferred_locations: 'Tenkasi, Tenkasi (Tenkasi)', qualification: 'ANM',
    council_reg_no: 'TN9', current_employment: 'Not working', experience_years: 0, work_preference: 'Either', service_interests: 'Home nursing' } });

  const pdf = Buffer.from('%PDF-1.4\n% test document\n%%EOF');
  const form = new FormData();
  form.append('type', 'COUNCIL_REG');
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'council.pdf');
  const up = await fetch(`${B}/api/public/reg/${t}/documents`, { method: 'POST', headers: { 'x-reg-session': session }, body: form });
  assert.equal(up.status, 200);

  const [key, obj] = [...objects].find(([k]) => k.includes(`/${id}/COUNCIL_REG/`));
  assert.match(key, new RegExp(`^/uyir-docs/documents/${id}/COUNCIL_REG/[0-9a-f-]{36}\\.pdf$`), 'key holds no personal data');
  assert.deepEqual(obj.body, pdf, 'exact bytes stored');
  assert.equal(obj.headers['content-type'], 'application/pdf');
  assert.equal(obj.headers['x-amz-server-side-encryption'], 'aws:kms');
  assert.equal(obj.headers['x-amz-server-side-encryption-aws-kms-key-id'], env.S3_KMS_KEY_ID);
  assert.equal(obj.headers['x-amz-checksum-sha256'], createHash('sha256').update(pdf).digest('base64'), 'S3 verifies integrity');
  assert.equal(obj.headers['x-amz-meta-nurse-id'], id);

  const doc = (await json('/api/nurses/' + id, { cookie })).body.documents.find(d => d.type === 'COUNCIL_REG');
  const view = await json(`/api/documents/${doc.id}/file`, { cookie });
  assert.equal(view.status, 302, 'staff are redirected to S3, bytes never pass through the app');
  const loc = new URL(view.headers.get('location'));
  assert.equal(loc.origin, S3);
  assert.equal(loc.pathname, key);
  assert.ok(loc.searchParams.get('X-Amz-Signature'), 'presigned');
  assert.equal(loc.searchParams.get('X-Amz-Expires'), '60', 'expires in a minute');
  assert.equal(loc.searchParams.get('response-content-disposition'), 'inline; filename="council.pdf"');

  const other = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'chennai.admin', password: 'Chennai@123' }) });
  const otherCookie = other.headers.get('set-cookie').split(';')[0];
  assert.equal((await json(`/api/documents/${doc.id}/file`, { cookie: otherCookie })).status, 404, 'other districts cannot open it');
});

test('deleting a nurse erases every version of their documents on S3', async () => {
  const signIn = async (username, password) => (await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })).headers.get('set-cookie').split(';')[0];
  const sup = await signIn('admin', 'Admin@123');
  const [key] = [...objects.keys()].filter(k => k.includes('/COUNCIL_REG/'));
  const id = key.split('/')[3];
  const before = objects.size;
  const r = await json(`/api/nurses/${id}/delete`, { cookie: sup, body: { reason: 'Test erasure', confirm: id } });
  assert.equal(r.status, 200);
  assert.equal(r.body.files_pending, false);
  assert.equal(r.body.files_removed, 3, 'current version, older version and delete marker');
  assert.deepEqual(deleted.map(d => d.version).sort(), ['m1', 'v1', 'v2']);
  assert.ok(deleted.every(d => d.key.startsWith(`documents/${id}/`)), 'only this nurse\'s files');
  assert.equal(objects.size, before - 1);
  assert.ok(![...objects.keys()].some(k => k.includes(`/${id}/`)));
});
