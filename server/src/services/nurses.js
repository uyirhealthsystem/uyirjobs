// Nurse domain operations. Every status change goes through transition() so history,
// progress, consent rules and the nurse's messages are applied consistently.
import { randomBytes } from 'node:crypto';
import { q, one, tx } from '../db/pool.js';
import { token } from '../lib/crypto.js';
import { httpError } from '../lib/errors.js';
import { STATUSES, canTransition, requiredDocTypes } from '../domain/workflow.js';
import { logEvent } from './events.js';
import { queueMessage, inviteChannel } from './messaging.js';

export const getNurse = id => one(`SELECT * FROM nurses WHERE id = ?`, id);

const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const newCode = () => 'UY' + Array.from(randomBytes(6), b => CODE_CHARS[b % CODE_CHARS.length]).join('');

/**
 * Move a nurse to a new status. Runs in a transaction and locks the nurse row, so two app
 * servers can't apply conflicting transitions at the same moment.
 * ctx: { role, user, actor, from?, quiet? }. role 'system' = automation / the registration portal;
 * from = the status the caller expects (optimistic check); quiet = don't send the usual message.
 */
export function transition(nurseId, to, ctx, note = null) {
  return tx(async () => {
    const n = await one(`SELECT * FROM nurses WHERE id = ? FOR UPDATE`, nurseId);
    if (!n) throw httpError(404, 'Nurse not found');
    if (!STATUSES[to]) throw httpError(400, `Unknown status ${to}`);
    if (ctx.from && n.status !== ctx.from) throw httpError(409, `Already changed to ${STATUSES[n.status]?.label} by someone else. Refresh and try again.`);
    const check = canTransition(n.status, to, ctx.role);
    if (!check.ok) throw httpError(409, check.reason);
    if (n.dnc && to === 'INVITED') throw httpError(409, 'Nurse is on Do Not Contact. Lift it (with fresh consent) before sending an invite.');

    const sets = [`status = ?`, `stage_reached = GREATEST(stage_reached, ?)`, `updated_at = now()`];
    const vals = [to, STATUSES[to].stage];
    if (['CORRECTION_REQUIRED', 'REJECTED'].includes(to)) { sets.push(`review_note = ?`); vals.push(note); }
    if (to === 'INVITED') {
      sets.push(`last_contacted_at = now()`);
      if (!n.reg_token) { sets.push(`reg_token = ?`); vals.push(token(18)); }
      if (!n.wa_code) { sets.push(`wa_code = ?`); vals.push(newCode()); }
    }
    if (to === 'REGISTERED' && !n.registered_at) sets.push(`registered_at = now()`);
    await q(`UPDATE nurses SET ${sets.join(', ')} WHERE id = ?`, ...vals, nurseId);
    await logEvent(nurseId, 'status', { from: n.status, to, note, user: ctx.user, actor: ctx.actor });

    if (!ctx.quiet) await notify(nurseId, n.status, to);
    return getNurse(nurseId);
  });
}

// The nurse is told whenever their registration moves on.
async function notify(id, from, to) {
  const n = await getNurse(id);
  switch (to) {
    // Invite by SMS with our WhatsApp chat link; if the nurse has messaged us on WhatsApp, a resend
    // goes to WhatsApp instead.
    case 'INVITED':             return inviteChannel(n) === 'whatsapp' ? queueMessage(n, 'REG_LINK') : queueMessage(n, from === 'INVITED' ? 'INVITE_AGAIN' : 'INVITE');
    case 'REGISTERED':          return queueMessage(n, 'REG_DONE');
    case 'CORRECTION_REQUIRED': return queueMessage(n, 'CORRECTION');
    case 'REJECTED':            return queueMessage(n, 'REJECTED');
    case 'VERIFIED':            return queueMessage(n, 'VERIFIED');
  }
}

/**
 * Give the nurse their WhatsApp invite code if they don't have one yet, so the SMS an admin sends
 * from their own phone can carry the chat link (the code tells us who messaged). Returns the code.
 */
export async function ensureWaCode(nurse) {
  if (nurse.wa_code) return nurse.wa_code;
  const row = await one(`UPDATE nurses SET wa_code = COALESCE(wa_code, ?) WHERE id = ? RETURNING wa_code`, newCode(), nurse.id);
  return row.wa_code;
}

/** Which required documents (per policy and the nurse's details) are missing a live upload. */
export async function missingRequiredDocs(nurseId, nurse = null) {
  const have = new Set((await q(`SELECT DISTINCT type FROM documents WHERE nurse_id = ? AND status IN ('SUBMITTED','VERIFIED')`, nurseId)).map(r => r.type));
  return requiredDocTypes(nurse || await getNurse(nurseId)).filter(k => !have.has(k));
}

// Outcomes an admin records after calling a nurse from their own phone.
export const CALL_OUTCOMES = {
  ANSWERED:       'Answered',
  NO_ANSWER:      'No answer',
  BUSY:           'Busy',
  SWITCHED_OFF:   'Switched off / not reachable',
  CALL_BACK:      'Asked to call back later',
  WRONG_NUMBER:   'Wrong number',
  NOT_INTERESTED: 'Not interested',
};
