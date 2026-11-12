// All configuration comes from the environment, validated once at startup.
// A bad production setting stops the process with a clear message instead of failing later.
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bool = z.enum(['0', '1', 'true', 'false']).optional().transform(v => v === '1' || v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  TRUST_PROXY: z.string().default('1'),            // hops in front of us (the ALB)
  WEB_DIST: z.string().optional(),                 // built React app; served by Express in production

  // Database (RDS PostgreSQL): DATABASE_URL, or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD.
  DATABASE_URL: z.string().optional(),
  PGHOST: z.string().optional(),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_SSL: bool,
  DATABASE_CA_FILE: z.string().optional(),

  // Documents
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  DATA_DIR: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_PREFIX: z.string().default('documents/'),
  S3_KMS_KEY_ID: z.string().optional(),
  S3_URL_TTL: z.coerce.number().int().min(10).max(900).default(60),
  S3_ENDPOINT: z.string().optional(),              // MinIO / LocalStack in development only
  S3_SSE: z.enum(['aws:kms', 'none']).default('aws:kms'),   // 'none' only for MinIO without KMS
  AWS_REGION: z.string().optional(),
  HEALTH_CHECK_STORAGE: bool,

  FIELD_ENC_KEY: z.string().optional(),
  SESSION_DAYS: z.coerce.number().int().positive().default(7),

  // WhatsApp (Meta Cloud API)
  WHATSAPP_PROVIDER: z.enum(['meta', 'simulated']).default('simulated'),
  WHATSAPP_API_BASE: z.string().default('https://graph.facebook.com'),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  WHATSAPP_LANG: z.string().default('en'),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_BUSINESS_NUMBER: z.string().default('').transform(v => v.replace(/\D/g, '')),
  WHATSAPP_POLL_MS: z.coerce.number().int().positive().default(3000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid configuration:\n${issues}`);
}
const env = parsed.data;
const isProd = env.NODE_ENV === 'production';

const fail = msg => { throw new Error(`Invalid configuration: ${msg}`); };
const publicUrl = (env.PUBLIC_URL || `http://localhost:${env.PORT}`).replace(/\/+$/, '');

if (isProd) {
  if (!publicUrl.startsWith('https://')) fail('PUBLIC_URL must be the https:// origin in production, e.g. https://uyirjobs.in');
  if (!env.FIELD_ENC_KEY) fail('FIELD_ENC_KEY is required in production');
  if (!env.WHATSAPP_BUSINESS_NUMBER) fail('WHATSAPP_BUSINESS_NUMBER is required (the number nurses message from the invite SMS)');
  if (!env.DATABASE_URL && !env.PGHOST) fail('set DATABASE_URL, or PGHOST/PGUSER/PGPASSWORD/PGDATABASE');
}
if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) fail('STORAGE_DRIVER=s3 requires S3_BUCKET');
if (isProd && env.STORAGE_DRIVER === 's3' && env.S3_SSE === 'none') fail('S3_SSE=none is not allowed in production (documents must be KMS-encrypted)');
if (env.WHATSAPP_PROVIDER === 'meta') {
  for (const k of ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']) if (!env[k]) fail(`WHATSAPP_PROVIDER=meta requires ${k}`);
  if (isProd && !env.WHATSAPP_APP_SECRET) fail('WHATSAPP_APP_SECRET is required in production (webhook signature check)');
}

export const config = Object.freeze({
  ...env,
  isProd,
  isDev: !isProd,
  publicUrl,
  serverRoot: SERVER_ROOT,
  dataDir: resolve(env.DATA_DIR || resolve(SERVER_ROOT, '..', 'data')),
  webDist: resolve(env.WEB_DIST || resolve(SERVER_ROOT, '..', 'web', 'dist')),
  databaseUrl: env.DATABASE_URL || (env.PGHOST ? null : isProd ? null : 'postgres://postgres@localhost:5432/uyir'),
  trustProxy: /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY,
});
