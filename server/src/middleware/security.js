import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { httpError } from '../lib/errors.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated requests (on top of SameSite=Lax cookies): a browser
 * always sends Origin on cross-site state-changing requests, so refuse any that isn't ours.
 * Non-browser clients (no Origin header) are unaffected.
 */
export function sameOrigin(req, res, next) {
  if (SAFE.has(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  const allowed = new Set([config.publicUrl, `${req.protocol}://${req.get('host')}`]);
  if (!allowed.has(origin)) throw httpError(403, 'Cross-site request refused');
  next();
}

// Per-instance limits (in-memory). They blunt password guessing and OTP / SMS abuse; the
// database-level checks (OTP attempts, resend interval) remain the real guarantee across instances.
const limiter = (windowMs, limit, message, extra = {}) => rateLimit({
  windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: () => config.NODE_ENV === 'test',
  handler: (req, res, next) => next(httpError(429, message)),
  ...extra,
});
export const loginLimiter = limiter(15 * 60e3, 20, 'Too many sign-in attempts. Try again in a few minutes.', {
  skipSuccessfulRequests: true,
});
// Mobile carriers put many phones behind one IP (CGNAT), so per-IP limits on the nurse portal stay generous…
export const registrationLimiter = limiter(60e3, 300, 'Too many requests. Please wait a minute and try again.');
// …and the OTP limit is per registration link, not per IP.
export const otpLimiter = limiter(15 * 60e3, 6, 'Too many codes requested. Please wait and try again.', {
  keyGenerator: req => 'otp:' + req.params.t,
});
