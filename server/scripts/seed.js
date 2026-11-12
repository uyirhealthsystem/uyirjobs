// Usage:
//   node scripts/seed.js            create demo staff accounts (if no users exist)
//   node scripts/seed.js --demo     also generate 44,000 SYNTHETIC leads with a realistic funnel
//   node scripts/seed.js --reset    wipe nurses/events/documents/messages first
// Uses DATABASE_URL like the app.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, q, one, tx, insertMany, formatNurseId, syncNurseSeq } from '../src/db/pool.js';
import { migrate } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/crypto.js';
import { UPLOAD_DIR } from '../src/services/storage.js';
import { STATUSES, DISTRICTS } from '../src/domain/workflow.js';

await migrate();

const args = new Set(process.argv.slice(2));

if (args.has('--reset')) {
  await q(`TRUNCATE messages, documents, events, nurses RESTART IDENTITY CASCADE`);
  await q(`ALTER SEQUENCE nurse_no_seq RESTART WITH 1`);
  console.log('Cleared nurse data.');
}

if (!(await one(`SELECT COUNT(*) c FROM users`)).c) {
  const users = [
    ['admin', 'Super Admin', 'super_admin', null, 'Admin@123'],
    ['tenkasi.admin', 'Tenkasi District Admin', 'district_admin', 'Tenkasi', 'Tenkasi@123'],
    ['chennai.admin', 'Chennai District Admin', 'district_admin', 'Chennai', 'Chennai@123'],
  ];
  await insertMany('users', ['username', 'name', 'role', 'district', 'password_hash'],
    await Promise.all(users.map(async u => ({ username: u[0], name: u[1], role: u[2], district: u[3], password_hash: await hashPassword(u[4]) }))));
  console.log('Created demo staff accounts:');
  for (const u of users) console.log(`  ${u[0].padEnd(16)} ${u[4].padEnd(12)} ${u[1]}`);
  console.log('Change these passwords before using real data.');
}

if (args.has('--demo')) {
  if ((await one(`SELECT COUNT(*) c FROM nurses`)).c) { console.log('Nurses already exist; use --reset --demo to regenerate.'); await pool.end(); process.exit(0); }
  const TOTAL = Number(process.env.DEMO_COUNT || 44000);
  const first = ['Lakshmi', 'Priya', 'Divya', 'Kavitha', 'Meena', 'Revathi', 'Saranya', 'Anitha', 'Deepa', 'Gayathri', 'Jothi', 'Malathi', 'Nandhini', 'Pavithra', 'Ramya', 'Sangeetha', 'Selvi', 'Sumathi', 'Tamilselvi', 'Vani', 'Vijaya', 'Yamuna', 'Bhuvana', 'Indhu', 'Kalaiselvi', 'Mahalakshmi', 'Rajeswari', 'Shanthi', 'Thenmozhi', 'Uma', 'Karthik', 'Suresh', 'Arun', 'Prakash', 'Senthil', 'Vignesh'];
  const initials = 'ABCDEGJKMNPRSTV';
  // Share of nurses in each status for an "average" district; scaled per district below.
  const W = { INVITED: 20, REGISTERED: 6, SUBMITTED: 2, CORRECTION_REQUIRED: 1, REJECTED: 0.3, VERIFIED: 4 };
  const rand = (() => { let s = 42; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; })();
  const pick = a => a[Math.floor(rand() * a.length)];
  const perf = Object.fromEntries(DISTRICTS.map(d => [d, 0.3 + rand() * 1.4]));
  const popW = Object.fromEntries(DISTRICTS.map(d => [d, d === 'Chennai' ? 4 : d === 'Coimbatore' || d === 'Madurai' ? 2.5 : 0.6 + rand()]));
  const popTotal = Object.values(popW).reduce((a, b) => a + b, 0);
  const sources = ['Nursing council list', 'Hospital referral', 'Nursing college alumni', 'Field camp', 'Website enquiry'];
  const mobiles = new Set();
  const daysAgoDate = d => new Date(Date.now() - d * 864e5);

  // Sample document (local driver) so the verification queue can be exercised.
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 52>>stream\nBT /F1 14 Tf 20 60 Td (SAMPLE DOCUMENT - DEMO) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  writeFileSync(join(UPLOAD_DIR, 'demo-sample.pdf'), pdf);

  const nurses = [], events = [], docs = [];
  for (let i = 1; i <= TOTAL; i++) {
    let r = rand() * popTotal, district = DISTRICTS[0];
    for (const d of DISTRICTS) { r -= popW[d]; if (r <= 0) { district = d; break; } }
    const f = perf[district];
    const weights = { NEW: 60 / f, ...Object.fromEntries(Object.entries(W).map(([k, w]) => [k, w * (STATUSES[k].stage >= 2 ? f : 1)])) };
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    let x = rand() * sum, status = 'NEW';
    for (const [k, w] of Object.entries(weights)) { x -= w; if (x <= 0) { status = k; break; } }
    let mobile; do { mobile = String(6 + Math.floor(rand() * 4)) + String(Math.floor(rand() * 1e9)).padStart(9, '0'); } while (mobiles.has(mobile));
    mobiles.add(mobile);
    const id = formatNurseId(i), st = STATUSES[status];
    const reg = st.stage >= 1, registered = st.stage >= 2;
    const daysAgo = Math.floor(rand() * 40);
    nurses.push({
      id, name: `${pick(first)} ${pick(initials)}.`, mobile, district, source: pick(sources), status, stage_reached: st.stage,
      ...(status === 'NEW' && rand() < 0.01 ? { dnc: true, dnc_reason: 'Asked not to be contacted (demo)' } : { dnc: false, dnc_reason: null }),
      reg_token: reg ? `demo${i.toString(36)}${Math.floor(rand() * 1e9).toString(36)}` : null,
      registered_at: registered ? daysAgoDate(daysAgo) : null, consent_data_processing_at: registered ? new Date() : null,
      qualification: registered ? pick(['B.Sc Nursing', 'GNM Diploma', 'M.Sc Nursing', 'ANM']) : null,
      council_reg_no: registered ? `TNNMC-${100000 + i}` : null,
      experience_years: registered ? Math.floor(rand() * 15) : null, work_preference: registered ? pick(['Full-time', 'Part-time']) : null,
      taluk: registered ? `${district} Taluk` : null, address: registered ? `Demo address, ${district}` : null,
      review_note: status === 'CORRECTION_REQUIRED' ? 'Council registration certificate is blurred' : status === 'REJECTED' ? 'Council registration could not be verified' : null,
      created_at: daysAgoDate(daysAgo + 30), updated_at: daysAgoDate(daysAgo),
    });
    events.push({ nurse_id: id, at: daysAgoDate(daysAgo + 30), type: 'import', note: 'Imported (synthetic demo data)', actor: 'system' });
    if (status !== 'NEW') events.push({ nurse_id: id, at: daysAgoDate(daysAgo), type: 'status', from_status: 'NEW', to_status: status, note: 'Demo data', actor: 'system' });
    if (st.stage >= 3) {
      const docStatus = status === 'SUBMITTED' ? 'SUBMITTED' : status === 'CORRECTION_REQUIRED' ? 'CORRECTION' : status === 'REJECTED' ? 'REJECTED' : 'VERIFIED';
      for (const t of ['QUALIFICATION', 'COUNCIL_REG', 'GOVT_ID']) {
        docs.push({ nurse_id: id, type: t, filename: `${t.toLowerCase()}.pdf`, mime: 'application/pdf', stored_name: 'demo-sample.pdf', storage: 'local', size: pdf.length,
          status: docStatus === 'CORRECTION' && t !== 'COUNCIL_REG' ? 'VERIFIED' : docStatus });
      }
      // Demo nurses who declared experience also get an experience document, matching the policy.
      if (nurses.at(-1).experience_years > 0) docs.push({ nurse_id: id, type: 'EXPERIENCE', filename: 'experience.pdf', mime: 'application/pdf', stored_name: 'demo-sample.pdf', storage: 'local', size: pdf.length, status: docStatus === 'CORRECTION' ? 'VERIFIED' : docStatus });
    }
  }

  await tx(async () => {
    await insertMany('nurses', Object.keys(nurses[0]), nurses, { chunk: 500 });
    await insertMany('events', ['nurse_id', 'at', 'type', 'from_status', 'to_status', 'note', 'actor'], events);
    await insertMany('documents', ['nurse_id', 'type', 'filename', 'mime', 'stored_name', 'storage', 'size', 'status'], docs);
    await syncNurseSeq();
  });
  console.log(`Generated ${TOTAL.toLocaleString()} synthetic leads across ${DISTRICTS.length} districts.`);
}

await pool.end();
