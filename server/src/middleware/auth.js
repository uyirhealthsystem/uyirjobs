// Staff sessions (opaque token in an HttpOnly cookie, rows in `sessions`) and district scoping.
// District scoping is enforced in SQL on the server, never only hidden in the UI.
import { one } from '../db/pool.js';
import { config } from '../config.js';
import { ROLES } from '../domain/workflow.js';
import { httpError } from '../lib/errors.js';
import { getNurse } from '../services/nurses.js';

export const SESSION_COOKIE = 'sid';
export const cookieOptions = () => ({
  httpOnly: true, sameSite: 'lax', path: '/', secure: config.isProd, maxAge: config.SESSION_DAYS * 86400e3,
});

/** Resolve the signed-in staff member (or null). A District Admin with no district never gets statewide access. */
export async function currentUser(req) {
  const t = req.cookies?.[SESSION_COOKIE];
  if (!t) return null;
  const u = await one(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > now() AND u.active`, t);
  if (!u || !ROLES[u.role] || (u.role === 'district_admin' && !u.district)) return null;
  return u;
}

export async function requireAuth(req, res, next) {
  const user = await currentUser(req);
  if (!user) throw httpError(401, 'Please sign in');
  req.user = user;
  next();
}

export const isSuper = user => user.role === 'super_admin';
export function needSuper(user) { if (!isSuper(user)) throw httpError(403, 'Only the Super Admin can do this'); }
export const requireSuper = (req, res, next) => { needSuper(req.user); next(); };

/** SQL WHERE fragment limiting nurses to what this user may see. */
export function scope(user, alias = 'n') {
  if (isSuper(user)) return { w: [], v: [] };
  return { w: [`${alias}.district = ?`], v: [user.district] };
}
export const canSee = (user, n) => !!n && (isSuper(user) || n.district === user.district);

/** Load a nurse the user may see; 404 otherwise (no hint that the record exists in another district). */
export async function loadVisibleNurse(user, id) {
  const n = await getNurse(id);
  if (!canSee(user, n)) throw httpError(404, 'Nurse not found');
  return n;
}
