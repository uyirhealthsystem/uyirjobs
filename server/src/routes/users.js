// Staff accounts (Super Admin only).
import { Router } from 'express';
import { q, one, tx } from '../db/pool.js';
import { hashPassword } from '../lib/crypto.js';
import { httpError } from '../lib/errors.js';
import { ROLES, normalizeDistrict } from '../domain/workflow.js';
import { requireSuper } from '../middleware/auth.js';

export const usersRouter = Router();
usersRouter.use(requireSuper);

function checkRoleDistrict(role, district) {
  if (!ROLES[role]) throw httpError(400, 'Unknown role');
  if (role === 'district_admin' && !district) throw httpError(400, 'A District Admin needs a district');
  if (role === 'super_admin' && district) throw httpError(400, 'The Super Admin covers all districts; leave district empty');
}
const MIN_PASSWORD = 8;

usersRouter.get('/', async (req, res) => {
  res.json({ rows: await q(`SELECT id, username, name, role, district, active FROM users ORDER BY role DESC, district NULLS FIRST, name`) });
});

usersRouter.post('/', async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw httpError(400, 'Username: 3–32 letters, digits, . _ -');
  if (String(body.password || '').length < MIN_PASSWORD) throw httpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  const district = body.district ? normalizeDistrict(body.district) : null;
  if (body.district && !district) throw httpError(400, 'Unknown district');
  checkRoleDistrict(body.role, district);
  if (await one(`SELECT 1 FROM users WHERE username = ?`, username)) throw httpError(409, 'Username taken');
  const r = await one(`INSERT INTO users (username, name, role, district, password_hash) VALUES (?,?,?,?,?) RETURNING id`,
    username, String(body.name || username).trim().slice(0, 120), body.role, district, await hashPassword(body.password));
  req.log.info({ by: req.user.id, created: r.id, role: body.role }, 'staff account created');
  res.json({ id: r.id });
});

usersRouter.patch('/:id', async (req, res) => {
  const { user } = req, body = req.body || {};
  const u = /^\d+$/.test(req.params.id) ? await one(`SELECT * FROM users WHERE id = ?`, Number(req.params.id)) : null;
  if (!u) throw httpError(404, 'User not found');
  if (u.id === user.id && (body.active === false || (body.role && body.role !== u.role))) throw httpError(400, 'You cannot deactivate or demote yourself');
  if (body.password && String(body.password).length < MIN_PASSWORD) throw httpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  const role = body.role ?? u.role;
  const district = body.district !== undefined ? (body.district ? normalizeDistrict(body.district) : null) : u.district;
  if (body.district && !district) throw httpError(400, 'Unknown district');
  const roleChange = body.role !== undefined || body.district !== undefined;
  const willBeActive = body.active != null ? !!body.active : u.active;
  // Validate any role change, and never leave an invalid account active (e.g. District Admin with no district).
  if (roleChange || willBeActive) checkRoleDistrict(role, district);
  const passwordHash = body.password ? await hashPassword(body.password) : null;
  await tx(async () => {
    if (roleChange) await q(`UPDATE users SET role = ?, district = ? WHERE id = ?`, role, district, u.id);
    if (body.active != null) await q(`UPDATE users SET active = ? WHERE id = ?`, !!body.active, u.id);
    if (passwordHash) await q(`UPDATE users SET password_hash = ? WHERE id = ?`, passwordHash, u.id);
    // Access changed: end the user's sessions so the new scope applies immediately.
    if (roleChange || body.active === false || passwordHash) await q(`DELETE FROM sessions WHERE user_id = ?`, u.id);
  });
  req.log.info({ by: user.id, target: u.id, roleChange, active: body.active, passwordReset: !!passwordHash }, 'staff account updated');
  res.json({ ok: true });
});
