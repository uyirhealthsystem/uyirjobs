// Express application: security headers, structured request logs, JSON APIs, and the built
// React app (same origin, so the session cookie never needs CORS).
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { one } from './db/pool.js';
import { storage } from './services/storage.js';
import { requireAuth } from './middleware/auth.js';
import { sameOrigin } from './middleware/security.js';
import { notFound, errorHandler } from './middleware/errors.js';
import { authRouter } from './routes/auth.js';
import { dashboardRouter } from './routes/dashboard.js';
import { nursesRouter } from './routes/nurses.js';
import { documentsRouter } from './routes/documents.js';
import { importRouter } from './routes/import.js';
import { usersRouter } from './routes/users.js';
import { registrationRouter } from './routes/registration.js';
import { whatsappRouter } from './routes/whatsapp.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);   // behind the ALB: real client IP and https
  app.disable('x-powered-by');

  app.use(pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = req.headers['x-request-id'] || req.headers['x-amzn-trace-id'] || randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    autoLogging: { ignore: req => req.url === '/healthz' || req.url.startsWith('/assets/') },
    customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    serializers: { req: r => ({ id: r.id, method: r.method, url: r.url.replace(/([?&]t=|\/reg\/)[^/&?]+/, '$1[token]').replace(/([?&]hub[._]verify_token=)[^&]*/g, '$1[redacted]') }) },
  }));

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
        // YouTube: the welcome video's thumbnail (i.ytimg.com) and its privacy-enhanced player.
        imgSrc: ["'self'", 'data:', 'blob:', 'https://i.ytimg.com'], connectSrc: ["'self'"], fontSrc: ["'self'"],
        frameSrc: ["'self'", 'blob:', 'https://www.youtube-nocookie.com'], objectSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"], frameAncestors: ["'self'"],
      },
    },
    strictTransportSecurity: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(compression());
  app.use(cookieParser());

  // Health check for the load balancer and ECS.
  app.get('/healthz', async (req, res) => {
    await one('SELECT 1');
    if (config.HEALTH_CHECK_STORAGE) await storage.check();
    res.json({ ok: true, storage: storage.name });
  });

  // ---------------- API ----------------
  const api = express.Router();
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use('/import', express.json({ limit: '30mb' }));   // large CSVs; must run before the default parser
  api.use(express.json({
    limit: '1mb',
    verify: (req, res, buf) => { req.rawBody = buf; },     // exact bytes, for webhook signature checks
  }));
  api.use(sameOrigin);

  // Public
  api.use('/', authRouter);                               // /login, /logout, /me (requireAuth inside)
  api.use('/public/reg', registrationRouter);
  api.use('/whatsapp', whatsappRouter);
  // Staff only
  api.use('/dashboard', requireAuth, dashboardRouter);
  api.use('/nurses', requireAuth, nursesRouter);
  api.use('/documents', requireAuth, documentsRouter);
  api.use('/import', requireAuth, importRouter);
  api.use('/users', requireAuth, usersRouter);
  api.use(notFound);
  app.use('/api', api);

  // ---------------- React app ----------------
  const indexHtml = join(config.webDist, 'index.html');
  if (existsSync(indexHtml)) {
    // Hashed build assets can be cached forever; index.html must always be revalidated.
    app.use('/assets', express.static(join(config.webDist, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
    app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
    // Plain HTML pages that must work without JavaScript (Meta checks these links): /privacy, /data-deletion.
    for (const page of ['privacy', 'data-deletion']) {
      app.get(`/${page}`, (req, res) => res.set('Cache-Control', 'public, max-age=3600').sendFile(join(config.webDist, `${page}.html`)));
    }
    app.get('/{*path}', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(indexHtml));
  } else {
    app.get('/', (req, res) => res.type('text/plain').send('API is running. Build the web app (npm run build) or use the Vite dev server.'));
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
