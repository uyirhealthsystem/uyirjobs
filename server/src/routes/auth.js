import { Router } from 'express';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { token, verifyPassword } from '../lib/crypto.js';
import { httpError } from '../lib/errors.js';
import { STATUSES, FUNNEL, ROLES, DOC_TYPES, DISTRICTS } from '../domain/workflow.js';
import { CALL_OUTCOMES } from '../services/nurses.js';
import { BUSINESS_NUMBER } from '../services/whatsapp.js';
import { requireAuth, SESSION_COOKIE, cookieOptions } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/security.js';

export const authRouter = Router();

authRouter.post('/login', loginLimiter, async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const u = await one(`SELECT * FROM users WHERE username = ? AND active`, username);
  // Always run the hash, so response time doesn't reveal whether the username exists.
  const ok = await verifyPassword(String(req.body?.password || ''), u?.password_hash);
  if (!u || !ok) throw httpError(401, 'Invalid username or password');
  if (!ROLES[u.role] || (u.role === 'district_admin' && !u.district)) throw httpError(403, 'This account has no district assigned. Ask the Super Admin.');
  const t = token(32);
  await q(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, now() + make_interval(days => ?))`, t, u.id, config.SESSION_DAYS);
  await q(`DELETE FROM sessions WHERE expires_at < now()`);
  req.log.info({ userId: u.id }, 'staff signed in');
  res.cookie(SESSION_COOKIE, t, cookieOptions()).json({ ok: true });
});

authRouter.post('/logout', async (req, res) => {
  const t = req.cookies?.[SESSION_COOKIE];
  if (t) await q(`DELETE FROM sessions WHERE token = ?`, t);
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined }).json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    user: { id: u.id, username: u.username, name: u.name, role: u.role, district: u.district },
    meta: { statuses: STATUSES, funnel: FUNNEL, roles: ROLES, docTypes: DOC_TYPES, districts: DISTRICTS, callOutcomes: CALL_OUTCOMES, whatsappNumber: BUSINESS_NUMBER || null },
  });
});
