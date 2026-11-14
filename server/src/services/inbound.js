// Someone messaged our WhatsApp number, usually by tapping the chat link in the SMS staff send
// from their own phone ("Hi, I want to register with Uyir…").
//
// Match by invite code, else by sender number. A sender we don't know yet gets a new nurse record
// (source 'WhatsApp') so they have a personal registration link; they fill in their name and
// district in the form. The registration link is sent automatically once per nurse: later messages
// get no automatic reply (staff can resend from the nurse page).
//
// Each message is handled in one transaction, and the message ID is recorded in the same
// transaction: Meta's repeat deliveries are skipped, and if anything fails the whole message
// rolls back, the webhook answers 500 and Meta's retry processes it again.
import { q, one, tx, nextNurseId } from '../db/pool.js';
import { normalizeMobile } from '../domain/workflow.js';
import { logEvent } from './events.js';
import { queueMessage, replyText } from './messaging.js';
import { transition, getNurse } from './nurses.js';
import { CODE_RE } from './whatsapp.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'whatsapp-inbound' });

/** 10-digit Indian mobile for a WhatsApp number like 919876543210, else null. */
const indianMobile = from => (/^91[6-9]\d{9}$/.test(from) ? normalizeMobile(from) : null);
/** WhatsApp profile name as a starting name; the nurse corrects it in the form. */
const startName = profile => String(profile || '').replace(/[\p{C}<>]/gu, '').trim().slice(0, 100) || 'Nurse';

async function findNurse(m) {
  const code = (m.text.match(CODE_RE) || [])[0]?.toUpperCase();
  return (code && await one(`SELECT id FROM nurses WHERE wa_code = ?`, code))
    || await one(`SELECT id FROM nurses WHERE whatsapp_number = ? OR '91' || mobile = ? ORDER BY (whatsapp_number = ?) DESC NULLS LAST LIMIT 1`, m.from, m.from, m.from);
}

/**
 * New sender: create their record. ON CONFLICT covers two first messages arriving at once
 * (the second waits for the first transaction, then finds its row).
 */
async function createFromWhatsApp(m) {
  const mobile = indianMobile(m.from);
  if (!mobile) return null;
  const id = await nextNurseId();
  const made = await one(`INSERT INTO nurses (id, name, mobile, district, source, consent_whatsapp) VALUES (?,?,?,NULL,'WhatsApp',true)
      ON CONFLICT (mobile) DO NOTHING RETURNING id`, id, startName(m.name), mobile);
  if (!made) return { found: await one(`SELECT id FROM nurses WHERE mobile = ?`, mobile), created: false };
  await logEvent(id, 'import', { note: 'Started on WhatsApp (chat link in the SMS); record created automatically', actor: 'nurse' });
  return { found: made, created: true };
}

async function handleOne(m) {
  const fresh = await one(`INSERT INTO whatsapp_inbound (wa_message_id, from_number, profile_name, body) VALUES (?,?,?,?)
      ON CONFLICT (wa_message_id) DO NOTHING RETURNING id`, m.id, m.from, m.name, m.text);
  if (!fresh) return;   // webhook redelivered

  let found = await findNurse(m), created = false;
  if (!found) ({ found, created } = (await createFromWhatsApp(m)) || {});
  if (!found) {
    // Not an Indian mobile number: we can't register them.
    await replyText(m.from, 'NOT_FOUND');
    await q(`UPDATE whatsapp_inbound SET outcome = 'unmatched' WHERE id = ?`, fresh.id);
    log.info({ inboundId: fresh.id, outcome: 'unmatched' }, 'WhatsApp message received (not an Indian number)');
    return;
  }

  let n = await one(`SELECT * FROM nurses WHERE id = ? FOR UPDATE`, found.id);
  let outcome;
  if (n.dnc) {
    outcome = 'dnc';
    await logEvent(n.id, 'message', { note: 'Messaged us on WhatsApp while on Do Not Contact; no reply sent. Lift Do Not Contact (with the nurse’s consent) to continue.', actor: 'nurse' });
  } else {
    const isFirst = !n.whatsapp_connected_at;
    await q(`UPDATE nurses SET whatsapp_number = ?, consent_whatsapp = true, whatsapp_last_inbound_at = now(),
        whatsapp_connected_at = COALESCE(whatsapp_connected_at, now()), updated_at = now() WHERE id = ?`, m.from, n.id);
    if (isFirst || n.whatsapp_number !== m.from) {
      await logEvent(n.id, 'message', { note: `Messaged us on WhatsApp from +${m.from}${m.name ? ` (${m.name})` : ''}: WhatsApp connected, opt-in recorded`, actor: 'nurse' });
    }
    // Not yet invited: invite quietly (gives them their link token); the link goes in the reply.
    if (n.status === 'NEW') await transition(n.id, 'INVITED', { role: 'system', actor: 'nurse', quiet: true }, 'Nurse messaged us on WhatsApp');
    n = await getNurse(n.id);
    // Once per nurse. The row lock above makes this check safe against concurrent webhooks.
    // A link that failed permanently, or was only simulated (before WhatsApp was connected), never
    // reached the nurse and doesn't count: their next message gets a fresh try.
    const sent = await one(`SELECT 1 FROM messages WHERE nurse_id = ? AND channel = 'whatsapp' AND template = 'REG_LINK' AND status NOT IN ('failed', 'simulated') LIMIT 1`, n.id);
    if (!sent) await queueMessage(n, 'REG_LINK');
    outcome = created ? 'created' : isFirst ? 'linked' : 'matched';
    // When there is no reply, say why: the link was already sent once (staff can resend it).
    log.info({ inboundId: fresh.id, nurseId: n.id, outcome, reply: sent ? 'none: registration link already sent' : 'registration link queued' }, 'WhatsApp message received');
  }
  if (outcome === 'dnc') log.info({ inboundId: fresh.id, nurseId: n.id, outcome }, 'WhatsApp message received (Do Not Contact: no reply)');
  await q(`UPDATE whatsapp_inbound SET nurse_id = ?, outcome = ? WHERE id = ?`, n.id, outcome, fresh.id);
}

export async function handleInbound(messages) {
  for (const m of messages) await tx(() => handleOne(m));
}
