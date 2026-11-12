// One-time copy of the old SQLite database (data/crm.db) into PostgreSQL.
//
//   DATABASE_URL=postgres://… node scripts/migrate-from-sqlite.js [path/to/crm.db]
//
// Refuses to run if the Postgres database already has nurses. Sessions are not copied
// (staff simply sign in again). Uploaded files stay where they are: documents keep
// storage='local'. Move them to S3 afterwards with scripts/move-documents-to-s3.js.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool, q, one, tx, insertMany, syncNurseSeq } from '../src/db/pool.js';
import { migrate, upgradeLegacyData } from '../src/db/schema.js';
import { config } from '../src/config.js';

await migrate();
const DATA_DIR = config.dataDir;

const file = resolve(process.argv[2] || resolve(DATA_DIR, 'crm.db'));
if (!existsSync(file)) { console.error(`SQLite file not found: ${file}`); process.exit(1); }
if ((await one(`SELECT COUNT(*) c FROM nurses`)).c) { console.error('Target database already has nurses. Aborting.'); process.exit(1); }

const lite = new DatabaseSync(file, { readOnly: true });
const liteCols = t => new Set(lite.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
const pgCols = async t => (await q(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ? AND table_schema = current_schema()`, t));

// SQLite stored UTC as 'YYYY-MM-DD HH:MM:SS' (datetime('now')) or ISO strings; 0/1 for flags.
const toTs = v => (v == null || v === '' ? null : new Date(String(v).includes('T') ? v : String(v).replace(' ', 'T') + 'Z'));

// Old SQLite column names → current Postgres names (the old crm.db has the earlier column names).
const RENAMED = { nurses: { call_attempts: 'ivr_attempts', consent_call: 'consent_ivr' } };

async function copy(table) {
  const have = liteCols(table), ren = RENAMED[table] || {};
  const src = c => (have.has(c) ? c : ren[c] && have.has(ren[c]) ? ren[c] : null);
  const cols = (await pgCols(table)).filter(c => src(c.column_name));
  const rows = lite.prepare(`SELECT * FROM ${table}`).all().map(r => {
    const row = Object.fromEntries(cols.map(({ column_name: c, data_type: t }) => {
      const v = r[src(c)];
      return [c, v == null ? null : t === 'boolean' ? !!v : t.startsWith('timestamp') ? toTs(v) : v];
    }));
    if (table === 'nurses' && row.status === 'IVR_INITIATED') row.status = 'NOT_CONTACTED';   // old status → Not Invited after the upgrade
    return row;
  });
  if (rows.length) await insertMany(table, cols.map(c => c.column_name), rows, { chunk: 500 });
  return rows.length;
}

await tx(async () => {
  const counts = {};
  // Users first (nurses reference them), then nurses, then everything that references nurses.
  if ((await one(`SELECT COUNT(*) c FROM users`)).c) {
    console.log('Users already exist in Postgres; skipping users (assigned_to / reviewed_by keep their numeric IDs).');
  } else counts.users = await copy('users');
  for (const t of ['nurses', 'events', 'documents', 'messages']) counts[t] = await copy(t);
  // Identity columns must continue after the copied IDs.
  for (const t of ['users', 'events', 'documents', 'messages']) {
    await q(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), 1))`);
  }
  await syncNurseSeq();
  console.log('Copied:', counts);
});
await upgradeLegacyData(); // old CRM statuses and roles → information collection
await pool.end();
