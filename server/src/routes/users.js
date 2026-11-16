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

function cleanUsername(v) {
  const username = String(v || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw httpError(400, 'Username: 3–32 letters, digits, . _ -');
  return username;
}
function cleanName(v) {
  const name = String(v || '').trim().slice(0, 120);
  if (!name) throw httpError(400, 'Name is required');
  return name;
}

async function loadUser(id) {
  const u = /^\d+$/.test(id) ? await one(`SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`, Number(id)) : null;
  if (!u) throw httpError(404, 'User not found');
  return u;
}

usersRouter.get('/', async (req, res) => {
  res.json({ rows: await q(`SELECT id, username, name, role, district, active FROM users WHERE deleted_at IS NULL ORDER BY role DESC, district NULLS FIRST, name`) });
});

usersRouter.post('/', async (req, res) => {
  const body = req.body || {};
  const username = cleanUsername(body.username);
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
  const u = await loadUser(req.params.id);
  if (u.id === user.id && (body.active === false || (body.role && body.role !== u.role))) throw httpError(400, 'You cannot deactivate or demote yourself');
  if (body.password && String(body.password).length < MIN_PASSWORD) throw httpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  const name = body.name !== undefined ? cleanName(body.name) : null;
  const username = body.username !== undefined ? cleanUsername(body.username) : null;
  if (username && username !== u.username && await one(`SELECT 1 FROM users WHERE username = ? AND id <> ?`, username, u.id)) throw httpError(409, 'Username taken');
  const role = body.role ?? u.role;
  const district = body.district !== undefined ? (body.district ? normalizeDistrict(body.district) : null) : u.district;
  if (body.district && !district) throw httpError(400, 'Unknown district');
  const roleChange = (body.role !== undefined && body.role !== u.role) || (body.district !== undefined && district !== u.district);
  const willBeActive = body.active != null ? !!body.active : u.active;
  // Validate any role change, and never leave an invalid account active (e.g. District Admin with no district).
  if (roleChange || willBeActive) checkRoleDistrict(role, district);
  const passwordHash = body.password ? await hashPassword(body.password) : null;
  const usernameChange = !!username && username !== u.username;
  await tx(async () => {
    if (name) await q(`UPDATE users SET name = ? WHERE id = ?`, name, u.id);
    if (usernameChange) await q(`UPDATE users SET username = ? WHERE id = ?`, username, u.id);
    if (roleChange) await q(`UPDATE users SET role = ?, district = ? WHERE id = ?`, role, district, u.id);
    if (body.active != null) await q(`UPDATE users SET active = ? WHERE id = ?`, !!body.active, u.id);
    if (passwordHash) await q(`UPDATE users SET password_hash = ? WHERE id = ?`, passwordHash, u.id);
    // Access changed: end the user's sessions so the new scope applies immediately.
    if (roleChange || body.active === false || passwordHash) await q(`DELETE FROM sessions WHERE user_id = ?`, u.id);
  });
  req.log.info({ by: user.id, target: u.id, renamed: !!name, usernameChange, roleChange, active: body.active, passwordReset: !!passwordHash }, 'staff account updated');
  res.json({ ok: true });
});

// Delete: sign the user out, unassign their nurses and free the username. The row is kept (hidden)
// so nurse histories, document reviews and deletions still show who did them.
usersRouter.delete('/:id', async (req, res) => {
  const { user } = req;
  const u = await loadUser(req.params.id);
  if (u.id === user.id) throw httpError(400, 'You cannot delete your own account');
  if (u.role === 'super_admin' && u.active) {
    const { c } = await one(`SELECT COUNT(*)::int c FROM users WHERE role = 'super_admin' AND active AND deleted_at IS NULL`);
    if (c <= 1) throw httpError(400, 'This is the only active Super Admin');
  }
  await tx(async () => {
    await q(`DELETE FROM sessions WHERE user_id = ?`, u.id);
    await q(`UPDATE nurses SET assigned_to = NULL WHERE assigned_to = ?`, u.id);
    await q(`UPDATE users SET active = false, deleted_at = now(), username = ? WHERE id = ?`, `${u.username}#deleted-${u.id}`, u.id);
  });
  req.log.info({ by: user.id, target: u.id, username: u.username }, 'staff account deleted');
  res.json({ ok: true });
});
