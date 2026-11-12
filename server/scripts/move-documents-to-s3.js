// Move documents still on local disk (documents.storage = 'local') into S3.
//
//   STORAGE_DRIVER=s3 S3_BUCKET=… AWS_REGION=ap-south-1 DATABASE_URL=… node scripts/move-documents-to-s3.js [--dry-run]
//
// Safe to re-run: each file is uploaded, then its rows are switched to s3 in a transaction.
// Local files are left in place; delete them yourself once you've checked the bucket.
import { createHash } from 'node:crypto';
import { pool, q, tx } from '../src/db/pool.js';
import { storage, storageFor, documentKey } from '../src/services/storage.js';

if (storage.name !== 's3') { console.error('Set STORAGE_DRIVER=s3 (and S3_BUCKET, AWS_REGION) first.'); process.exit(1); }
const dry = process.argv.includes('--dry-run');
const local = storageFor('local');

// Group by stored file: several rows may point at one file (e.g. demo data).
const files = await q(`SELECT stored_name, MIN(nurse_id) nurse_id, MIN(type) type, MIN(mime) mime, COUNT(*) n
    FROM documents WHERE storage = 'local' GROUP BY stored_name ORDER BY stored_name`);
console.log(`${files.length} local file(s) referenced by ${files.reduce((a, f) => a + f.n, 0)} document row(s).`);

let moved = 0, failed = 0;
for (const f of files) {
  try {
    const buf = await local.get(f.stored_name);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const key = documentKey(f.nurse_id, f.type, f.mime);
    if (dry) { console.log(`would move ${f.stored_name} → ${key}`); continue; }
    await storage.put({ key, body: buf, contentType: f.mime, sha256, metadata: { 'nurse-id': f.nurse_id, 'doc-type': f.type } });
    await tx(() => q(`UPDATE documents SET storage = 's3', stored_name = ?, sha256 = ? WHERE storage = 'local' AND stored_name = ?`, key, sha256, f.stored_name));
    moved++;
  } catch (e) {
    failed++; console.error(`failed ${f.stored_name}: ${e.message}`);
  }
}
console.log(dry ? 'Dry run complete.' : `Moved ${moved}, failed ${failed}.`);
await pool.end();
