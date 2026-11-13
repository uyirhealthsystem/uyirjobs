// Document storage. Two drivers behind one interface:
//   s3     production: private S3 bucket with SSE-KMS. Staff view documents through short-lived
//          presigned URLs, so file bytes never pass back through the app.
//   local  development / tests: files under DATA_DIR/uploads, streamed by the app.
//
// Object keys hold no personal data: documents/<nurseId>/<docType>/<uuid>.<ext>
// S3 credentials come from the default AWS chain (ECS task role). Never use static keys.
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, ListObjectVersionsCommand, DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

export const UPLOAD_DIR = resolve(config.dataDir, 'uploads');
const EXT = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };
const safeName = f => String(f || 'document').replace(/[^\w.\- ]/g, '_');

/** Nurse IDs are used as key prefixes: only the generated format is accepted when erasing. */
const NURSE_ID_RE = /^[A-Z0-9-]{3,40}$/;
const nursePrefix = (prefix, nurseId) => {
  if (!NURSE_ID_RE.test(nurseId)) throw new Error('Bad nurse ID for storage');
  return `${prefix}${nurseId}/`;
};

export function documentKey(nurseId, type, mime) {
  const prefix = config.STORAGE_DRIVER === 's3' ? config.S3_PREFIX : '';
  return `${prefix}${nurseId}/${type}/${randomUUID()}${EXT[mime] || ''}`;
}

function localDriver() {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const path = key => {
    const p = resolve(UPLOAD_DIR, key);
    if (!p.startsWith(UPLOAD_DIR + sep)) throw new Error('Bad storage key');
    return p;
  };
  return {
    name: 'local',
    async put({ key, body }) { await mkdir(dirname(path(key)), { recursive: true }); await writeFile(path(key), body); },
    async get(key) { return readFile(path(key)); },
    async viewUrl() { return null; },   // null → the app streams the bytes itself
    async check() { return true; },
    /** Erase every file of one nurse. Returns how many files were removed (0 if none). */
    async purgeNurse(nurseId) {
      const dir = path(nursePrefix('', nurseId).slice(0, -1));
      const files = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
      await rm(dir, { recursive: true, force: true });
      return files.filter(f => f.isFile()).length;
    },
  };
}

function s3Driver() {
  const Bucket = config.S3_BUCKET;
  const client = new S3Client({
    region: config.AWS_REGION,
    maxAttempts: 4,   // SDK retries with backoff
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: true } : {}),
  });
  const kms = config.S3_KMS_KEY_ID;
  return {
    name: 's3',
    async put({ key, body, contentType, sha256, metadata = {} }) {
      await client.send(new PutObjectCommand({
        Bucket, Key: key, Body: body, ContentType: contentType,
        ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),   // S3 rejects corrupted uploads
        ...(config.S3_SSE === 'aws:kms' ? { ServerSideEncryption: 'aws:kms', ...(kms ? { SSEKMSKeyId: kms } : {}), BucketKeyEnabled: true } : {}),
        Metadata: metadata,
      }));
    },
    async get(key) {
      const r = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      return Buffer.from(await r.Body.transformToByteArray());
    },
    async viewUrl(key, { filename, mime }) {
      return getSignedUrl(client, new GetObjectCommand({
        Bucket, Key: key,
        ResponseContentType: mime,
        ResponseContentDisposition: `inline; filename="${safeName(filename)}"`,
        ResponseCacheControl: 'private, no-store',
      }), { expiresIn: config.S3_URL_TTL });
    },
    async check() { await client.send(new HeadBucketCommand({ Bucket })); return true; },
    /**
     * Erase every file of one nurse, including old versions and delete markers: the bucket is
     * versioned, so a plain delete would leave the bytes recoverable for the retention period.
     * Returns how many object versions were removed.
     */
    async purgeNurse(nurseId) {
      const Prefix = nursePrefix(config.S3_PREFIX, nurseId);
      let removed = 0, KeyMarker, VersionIdMarker;
      for (;;) {
        const page = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix, KeyMarker, VersionIdMarker, MaxKeys: 1000 }));
        const Objects = [...(page.Versions || []), ...(page.DeleteMarkers || [])].map(v => ({ Key: v.Key, VersionId: v.VersionId }));
        if (Objects.length) {
          const r = await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }));
          if (r.Errors?.length) throw new Error(`S3 could not delete ${r.Errors.length} file(s): ${r.Errors[0].Code}`);
          removed += Objects.length;
        }
        if (!page.IsTruncated) return removed;
        ({ NextKeyMarker: KeyMarker, NextVersionIdMarker: VersionIdMarker } = page);
      }
    },
  };
}

const local = localDriver();
/** Driver new uploads go to. */
export const storage = config.STORAGE_DRIVER === 's3' ? s3Driver() : local;
/** Driver a stored document lives in (documents.storage), so files from before the S3 switch stay readable. */
export function storageFor(name) {
  if (name === storage.name) return storage;
  if (name === 'local') return local;
  throw new Error(`Document is stored in "${name}" but that driver is not configured`);
}
export const safeFilename = safeName;

/** Erase a nurse's files from every storage driver their documents were written to. */
export async function purgeNurseFiles(nurseId, driverNames) {
  let removed = 0;
  for (const name of new Set([storage.name, ...driverNames])) removed += await storageFor(name).purgeNurse(nurseId);
  return removed;
}
