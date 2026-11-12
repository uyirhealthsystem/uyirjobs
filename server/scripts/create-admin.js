// Create (or reset) a staff account without the demo seed. Use this for the first Super Admin in production:
//
//   ADMIN_USERNAME=superadmin ADMIN_PASSWORD='…' ADMIN_NAME='State Super Admin' node scripts/create-admin.js
//   (District Admin: also set ADMIN_ROLE=district_admin ADMIN_DISTRICT=Tenkasi)
//
// On AWS, run it as a one-off ECS task (docs/DEPLOYMENT-AWS.md). Credentials come from environment
// variables, never command-line arguments, so they don't end up in shell history or logs.
import { pool, one } from '../src/db/pool.js';
import { migrate } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/crypto.js';
import { ROLES, normalizeDistrict } from '../src/domain/workflow.js';

const username = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || '');
const role = process.env.ADMIN_ROLE || 'super_admin';
const district = process.env.ADMIN_DISTRICT ? normalizeDistrict(process.env.ADMIN_DISTRICT) : null;
const name = process.env.ADMIN_NAME || username;

const fail = msg => { console.error(msg); process.exit(1); };
if (!/^[a-z0-9._-]{3,32}$/.test(username)) fail('ADMIN_USERNAME: 3–32 letters, digits, . _ -');
if (password.length < 12) fail('ADMIN_PASSWORD: at least 12 characters');
if (!ROLES[role]) fail(`ADMIN_ROLE must be one of ${Object.keys(ROLES).join(', ')}`);
if (role === 'district_admin' && !district) fail('ADMIN_DISTRICT is required (and must be a valid district) for a District Admin');
if (role === 'super_admin' && district) fail('A Super Admin has no district');

await migrate();
const r = await one(`INSERT INTO users (username, name, role, district, password_hash) VALUES (?,?,?,?,?)
    ON CONFLICT (username) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, district = EXCLUDED.district,
      password_hash = EXCLUDED.password_hash, active = true
    RETURNING id, (xmax = 0) AS created`, username, name, role, district, await hashPassword(password));
await one(`DELETE FROM sessions WHERE user_id = ? RETURNING 1`, r.id);
console.log(`${r.created ? 'Created' : 'Updated'} ${ROLES[role].label} "${username}"${district ? ` for ${district}` : ''}.`);
await pool.end();
