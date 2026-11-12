// Passwords (scrypt, async so logins don't block the event loop), random tokens,
// and AES-256-GCM field encryption for bank account numbers.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(scryptCb);

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${(await scrypt(String(pw), salt, 32)).toString('hex')}`;
}

// Used when the username doesn't exist, so the response time doesn't reveal which usernames are real.
const DUMMY = `${'0'.repeat(32)}:${'0'.repeat(64)}`;
export async function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || DUMMY).split(':');
  if (!salt || !hash) return false;
  const a = await scrypt(String(pw), Buffer.from(salt, 'hex'), 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b) && !!stored;
}

export const token = (n = 24) => randomBytes(n).toString('base64url');
export const sha256 = s => createHash('sha256').update(s).digest('hex');

const FIELD_KEY = (() => {
  if (config.FIELD_ENC_KEY) {
    const b = Buffer.from(config.FIELD_ENC_KEY, 'base64');
    if (b.length !== 32) throw new Error('FIELD_ENC_KEY must be 32 bytes, base64');
    return b;
  }
  return createHash('sha256').update('uyir-dev-only-field-key').digest();   // development only (config enforces production)
})();

export function encryptField(plain) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', FIELD_KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
export function decryptField(stored) {
  const [v, iv, tag, enc] = String(stored).split(':');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const d = createDecipheriv('aes-256-gcm', FIELD_KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
