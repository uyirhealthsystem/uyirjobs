import { q } from '../db/pool.js';

/** Append to a nurse's history. actor: 'system', 'nurse', or the staff username. */
export async function logEvent(nurseId, type, { from = null, to = null, note = null, user = null, actor = null } = {}) {
  await q(`INSERT INTO events (nurse_id, type, from_status, to_status, note, user_id, actor) VALUES (?,?,?,?,?,?,?)`,
    nurseId, type, from, to, note, user?.id ?? null, actor ?? user?.username ?? 'system');
}
