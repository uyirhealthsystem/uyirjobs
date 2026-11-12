// A nurse messaged our WhatsApp number (usually "Hi Uyir UY7K3M9Q" from the invite SMS).
// Match by code, else by sender number; record their WhatsApp number (= opt-in) and reply with
// their registration link. Unknown senders get a short "not found" reply.
import { q, one, tx } from '../db/pool.js';
import { logEvent } from './events.js';
import { queueMessage, replyText } from './messaging.js';
import { transition, getNurse } from './nurses.js';
import { CODE_RE } from './whatsapp.js';

const REPLY_GAP_SECS = 120;   // don't answer every message in a burst ("Hi", "hello", "?")

export async function handleInbound(messages) {
  for (const m of messages) {
    const fresh = await one(`INSERT INTO whatsapp_inbound (wa_message_id, from_number, profile_name, body) VALUES (?,?,?,?)
        ON CONFLICT (wa_message_id) DO NOTHING RETURNING id`, m.id, m.from, m.name, m.text);
    if (!fresh) continue;   // webhook redelivered
    const code = (m.text.match(CODE_RE) || [])[0]?.toUpperCase();
    let outcome = 'unmatched', nurseId = null;
    await tx(async () => {
      const found = (code && await one(`SELECT id FROM nurses WHERE wa_code = ?`, code))
        || await one(`SELECT id FROM nurses WHERE whatsapp_number = ? OR '91' || mobile = ? ORDER BY (whatsapp_number = ?) DESC NULLS LAST LIMIT 1`, m.from, m.from, m.from);
      if (!found) return;
      let n = await one(`SELECT * FROM nurses WHERE id = ? FOR UPDATE`, found.id);
      nurseId = n.id;
      if (n.dnc) {
        outcome = 'dnc';
        await logEvent(n.id, 'message', { note: 'Messaged us on WhatsApp while on Do Not Contact; no reply sent. Lift Do Not Contact (with the nurse’s consent) to continue.', actor: 'nurse' });
        return;
      }
      const isFirst = !n.whatsapp_connected_at;
      await q(`UPDATE nurses SET whatsapp_number = ?, consent_whatsapp = true, whatsapp_last_inbound_at = now(),
          whatsapp_connected_at = COALESCE(whatsapp_connected_at, now()), updated_at = now() WHERE id = ?`, m.from, n.id);
      if (isFirst || n.whatsapp_number !== m.from) {
        await logEvent(n.id, 'message', { note: `Messaged us on WhatsApp from +${m.from}${m.name ? ` (${m.name})` : ''}: WhatsApp connected, opt-in recorded`, actor: 'nurse' });
      }
      // A nurse we never invited (found by number) is invited quietly; the link goes in the reply.
      if (n.status === 'NEW') await transition(n.id, 'INVITED', { role: 'system', actor: 'nurse', quiet: true }, 'Nurse messaged us on WhatsApp');
      n = await getNurse(n.id);
      const recent = await one(`SELECT 1 FROM messages WHERE nurse_id = ? AND template = 'REG_LINK' AND created_at > now() - make_interval(secs => ?) LIMIT 1`, n.id, REPLY_GAP_SECS);
      if (!recent) await queueMessage(n, 'REG_LINK');
      outcome = isFirst ? 'linked' : 'matched';
    });
    if (outcome === 'unmatched') await replyText(m.from, 'NOT_FOUND');
    await q(`UPDATE whatsapp_inbound SET nurse_id = ?, outcome = ? WHERE wa_message_id = ?`, nurseId, outcome, m.id);
  }
}
