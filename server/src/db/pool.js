// PostgreSQL data access (Amazon RDS in production).
//
//   q(sql, ...params)    → rows          (? placeholders, converted to $1, $2 …)
//   one(sql, ...params)  → first row | undefined
//   tx(async () => …)    → runs everything inside on one connection in a transaction.
//                          Re-entrant: nested tx() calls join the outer transaction.
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../logger.js';

// COUNT(*) is bigint and numeric is arbitrary precision: return JS numbers.
pg.types.setTypeParser(20, v => Number(v));
pg.types.setTypeParser(1700, v => Number(v));

export const pool = new pg.Pool({
  ...(config.databaseUrl ? { connectionString: config.databaseUrl } : {}),   // otherwise pg reads PGHOST/PGUSER/…
  max: config.PG_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
  application_name: 'uyirjobs',
  ...(config.DATABASE_SSL ? {
    ssl: { rejectUnauthorized: true, ...(config.DATABASE_CA_FILE ? { ca: readFileSync(config.DATABASE_CA_FILE, 'utf8') } : {}) },
  } : {}),
});
// An idle client erroring (e.g. during an RDS failover) must not crash the process; the pool replaces it.
pool.on('error', e => logger.error({ err: e }, 'idle database client error'));

const als = new AsyncLocalStorage();

/** Convert ? placeholders to $n, ignoring ? inside '…' string literals. */
export function toPg(sql) {
  let out = '', n = 0, inStr = false;
  for (const c of sql) {
    if (c === "'") inStr = !inStr;
    out += c === '?' && !inStr ? '$' + ++n : c;
  }
  return out;
}

export async function q(sql, ...params) {
  return (await (als.getStore() || pool).query(toPg(sql), params)).rows;
}
export const one = async (sql, ...params) => (await q(sql, ...params))[0];

export async function tx(fn) {
  if (als.getStore()) return fn();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await als.run(client, fn);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Multi-row INSERT in chunks (keeps imports of tens of thousands of rows fast). */
export async function insertMany(table, cols, rows, { chunk = 1000, suffix = '' } = {}) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk), vals = [];
    const tuples = part.map(r => `(${cols.map(c => (vals.push(r[c] ?? null), '$' + vals.length)).join(',')})`);
    await (als.getStore() || pool).query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ${suffix}`, vals);
  }
}

export const formatNurseId = n => `UYIR-NUR-${String(n).padStart(6, '0')}`;
export const nextNurseId = async () => formatNurseId((await one(`SELECT nextval('nurse_no_seq') n`)).n);
/** After inserting explicit IDs (import / migration), move the sequence past them. */
export const syncNurseSeq = () => q(`SELECT setval('nurse_no_seq', GREATEST(
    (SELECT COALESCE(MAX(substring(id from 10)::int), 0) FROM nurses WHERE id ~ '^UYIR-NUR-[0-9]{6}$'),
    (SELECT last_value FROM nurse_no_seq), 1))`);
