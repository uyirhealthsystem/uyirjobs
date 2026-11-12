// Structured JSON logs (CloudWatch-friendly). Secrets and personal tokens are redacted.
import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL || (config.NODE_ENV === 'test' ? 'warn' : 'info'),
  base: { app: 'uyir' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.cookie', 'req.headers.authorization', 'req.headers["x-reg-session"]', 'req.headers["x-hub-signature-256"]',
      'res.headers["set-cookie"]', '*.password', '*.otp', '*.account_number', '*.account_number_confirm',
    ],
    censor: '[redacted]',
  },
});
