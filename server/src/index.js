// Process entry point: migrate the schema, start HTTP + the WhatsApp worker, shut down cleanly.
import { config } from './config.js';
import { logger } from './logger.js';
import { pool, one } from './db/pool.js';
import { migrate } from './db/schema.js';
import { storage } from './services/storage.js';
import * as whatsapp from './services/whatsapp.js';
import { createApp } from './app.js';

process.on('unhandledRejection', err => logger.error({ err }, 'unhandled promise rejection'));
process.on('uncaughtException', err => { logger.fatal({ err }, 'uncaught exception'); process.exit(1); });

// On Windows a second process can bind a port that is already in use without any error, and
// requests then keep going to the old process. Refuse to start if anything already answers there.
async function portInUse(port) {
  const { connect } = await import('node:net');
  const probe = host => new Promise(resolve => {
    const s = connect({ port, host });
    s.setTimeout(500);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
  return (await Promise.all([probe('127.0.0.1'), probe('::1')])).some(Boolean);
}
if (await portInUse(config.PORT)) {
  logger.fatal({ port: config.PORT }, `Port ${config.PORT} is already in use (is an older copy of the server still running?). Stop it, or set PORT to a free port.`);
  await new Promise(r => setTimeout(r, 100));   // let the log line flush
  process.exit(1);
}

await migrate();

const app = createApp();
const server = app.listen(config.PORT, async () => {
  logger.info({ url: config.publicUrl, port: config.PORT, storage: storage.name, whatsapp: whatsapp.PROVIDER, env: config.NODE_ENV }, 'Uyir nurse registration started');
  whatsapp.startWorker();
  const { c } = await one(`SELECT COUNT(*) c FROM users WHERE active`);
  if (!c) logger.warn('No staff accounts yet. Run `npm run seed` (development) or `npm run create-admin` (production).');
});
server.on('error', err => {
  logger.fatal({ err, port: config.PORT }, err.code === 'EADDRINUSE' ? `Port ${config.PORT} is already in use` : 'HTTP server error');
  setTimeout(() => process.exit(1), 100);
});
// Longer than the ALB idle timeout (60 s), so the load balancer always closes idle connections first.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 120_000;

// Graceful shutdown: ECS sends SIGTERM on deploys / scale-in. Stop taking work, finish in-flight
// requests and the current WhatsApp batch, then close the database pool.
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  setTimeout(() => { logger.error('forced exit after timeout'); process.exit(1); }, 25_000).unref();
  await whatsapp.stopWorker();
  server.close(async () => {
    await pool.end().catch(() => {});
    logger.info('stopped');
    process.exit(0);
  });
  server.closeIdleConnections();
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig));
