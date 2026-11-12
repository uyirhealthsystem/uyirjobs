// What the nurse is told, and on which channel.
// Invite by SMS (with a WhatsApp chat link) → nurse says "Hi" on WhatsApp → everything else on WhatsApp.
import { q } from '../db/pool.js';
import { config } from '../config.js';
import { httpError } from '../lib/errors.js';
import { logEvent } from './events.js';
import { buildPayload, textPayload, sendNow, chatLink, waNumber, PROVIDER as WA_PROVIDER } from './whatsapp.js';

export const regLink = n => `${config.publicUrl}/register?t=${n.reg_token}`;
const firstName = n => String(n.name || '').split(/\s+/)[0];

export const TEMPLATES = {
  // SMS: the only SMS messages. They carry the WhatsApp chat link, not the registration link.
  INVITE:       n => `Vanakkam ${firstName(n)}, Uyir invites you to register as a nurse. Tap to chat with us on WhatsApp and get your registration link: ${chatLink(n.wa_code)}`,
  INVITE_AGAIN: n => `Vanakkam ${firstName(n)}, a reminder to register with Uyir. Tap to chat with us on WhatsApp: ${chatLink(n.wa_code)}`,
  // WhatsApp
  REG_LINK:   n => `Vanakkam ${firstName(n)}! Here is your personal Uyir registration link: ${regLink(n)} (please do not share it). Open it to verify your number, fill in your details and upload your documents.`,
  REG_DONE:   n => `Thank you ${firstName(n)}, your Uyir registration is received. Please upload your documents: ${regLink(n)}`,
  DOC_REMIND: n => `Reminder: please upload your nursing certificate, council registration and ID to complete your Uyir registration: ${regLink(n)}`,
  CORRECTION: n => `Uyir: some of your documents need correction (${n.review_note || 'see the link'}). Please re-upload: ${regLink(n)}`,
  REJECTED:   n => `Uyir: we are unable to approve your registration at this time. Reason: ${n.review_note || 'not specified'}.`,
  VERIFIED:   n => `Congratulations ${firstName(n)}! Your documents are verified. Please add your bank details for payments: ${regLink(n)}`,
  OTP:        () => `Your Uyir verification code is ******. It is valid for 10 minutes.`,
  NOT_FOUND:  () => `Vanakkam! We could not find your Uyir registration from this message. Please tap the WhatsApp link in the SMS we sent you, or contact your district office.`,
};
const SMS_TEMPLATES = new Set(['INVITE', 'INVITE_AGAIN']);
const WINDOW_MS = 24 * 3600e3 - 5 * 60e3;   // Meta's customer-service window, with a safety margin
const inWindow = n => n.whatsapp_last_inbound_at && Date.now() - new Date(n.whatsapp_last_inbound_at).getTime() < WINDOW_MS;

/**
 * How an invite (or a resend) would reach this nurse: 'whatsapp' once they have messaged us,
 * else 'sms' with the WhatsApp chat link. null = can't be contacted (DNC, or no consent).
 */
export const inviteChannel = n => (n.dnc ? null : n.whatsapp_connected_at && n.consent_whatsapp ? 'whatsapp' : n.consent_sms ? 'sms' : null);

/**
 * Send one message to a nurse. Nothing goes out on Do Not Contact or without consent for the channel.
 * Within 24 h of the nurse's last message we reply in free text; otherwise an approved template is used.
 * `force` = the OTP, which the nurse asked for: sent immediately, never stored (masked).
 * Returns the channels used ([] = nothing sent; the reason is logged). Throws 502 if an OTP failed.
 */
export async function queueMessage(nurse, template, { force = false, code = null } = {}) {
  const body = TEMPLATES[template](nurse);
  const channel = SMS_TEMPLATES.has(template) ? 'sms' : 'whatsapp';
  const allowed = force || (!nurse.dnc && (channel === 'sms' ? nurse.consent_sms : nurse.consent_whatsapp));
  let status = null, error = null;

  if (allowed && channel === 'sms') {
    // No SMS gateway yet: recorded as 'simulated'. A gateway sender would pick up 'queued' rows.
    await q(`INSERT INTO messages (nurse_id, channel, template, body, status) VALUES (?,?,?,?,?)`, nurse.id, 'sms', template, body, 'simulated');
    status = 'sent';
  } else if (allowed) {
    const payload = !force && inWindow(nurse) ? textPayload(waNumber(nurse), body) : buildPayload(nurse, template, regLink(nurse), { code });
    if (force) {
      const r = await sendNow(payload);
      const masked = { ...payload, params: payload.params.map(() => '******') };
      await q(`INSERT INTO messages (nurse_id, channel, template, body, status, payload, provider_id, error, sent_at) VALUES (?,?,?,?,?,?,?,?,${r.error ? 'NULL' : 'now()'})`,
        nurse.id, 'whatsapp', template, body, r.simulated ? 'simulated' : r.error ? 'failed' : 'sent', masked, r.id ?? null, r.error ?? null);
      status = r.error ? 'failed' : 'sent'; error = r.error;
    } else {
      await q(`INSERT INTO messages (nurse_id, channel, template, body, status, payload) VALUES (?,?,?,?,?,?)`,
        nurse.id, 'whatsapp', template, body, WA_PROVIDER === 'meta' ? 'queued' : 'simulated', payload);
      status = 'sent';
    }
  }

  const label = channel === 'sms' ? 'SMS' : 'WhatsApp';
  if (status === 'sent') await logEvent(nurse.id, 'message', { note: `${template} sent by ${label}`, actor: 'system' });
  else await logEvent(nurse.id, 'message', { note: `${template} not sent: ${error ? 'WhatsApp delivery failed' : nurse.dnc ? 'Do Not Contact' : `no ${label} consent`}`, actor: 'system' });
  if (force && status !== 'sent') throw httpError(502, 'We could not send the code to your WhatsApp. Check that this number uses WhatsApp, then try again.');
  return status === 'sent' ? [channel] : [];
}

/** Free-text reply to someone who just messaged us (not linked to a nurse). */
export async function replyText(to, template) {
  const body = TEMPLATES[template]();
  await q(`INSERT INTO messages (nurse_id, channel, template, body, status, payload) VALUES (NULL,?,?,?,?,?)`,
    'whatsapp', template, body, WA_PROVIDER === 'meta' ? 'queued' : 'simulated', textPayload(to, body));
}

/** Text for an SMS the admin sends from their own phone: the invite wording with the WhatsApp chat link. */
export const manualSmsBody = (nurse, code) => TEMPLATES.INVITE({ ...nurse, wa_code: code });
