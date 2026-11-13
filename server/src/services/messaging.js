// What the nurse is told, and on which channel.
// Invite: staff call the nurse and send an SMS with the personal registration link (usually from
// their own phone; see manualSmsBody). Later updates go on WhatsApp if the nurse ever messages us.
import { q } from '../db/pool.js';
import { config } from '../config.js';
import { logEvent } from './events.js';
import { buildPayload, textPayload, waNumber, PROVIDER as WA_PROVIDER } from './whatsapp.js';

export const regLink = n => `${config.publicUrl}/register?t=${n.reg_token}`;
const firstName = n => String(n.name || '').split(/\s+/)[0];

export const TEMPLATES = {
  // SMS: the invite and its reminder carry the personal registration link.
  INVITE:       n => `Vanakkam ${firstName(n)}, Uyir Health App invites you to register as a nurse. Your personal registration link: ${regLink(n)} (please do not share it).`,
  INVITE_AGAIN: n => `Vanakkam ${firstName(n)}, a reminder to complete your nurse registration with Uyir Health App: ${regLink(n)} (please do not share it).`,
  // WhatsApp
  REG_LINK:   n => `Vanakkam ${firstName(n)}! Here is your personal Uyir registration link: ${regLink(n)} (please do not share it). Open it to fill in your details and upload your documents.`,
  REG_DONE:   n => `Thank you ${firstName(n)}, your Uyir registration is received. Please upload your documents: ${regLink(n)}`,
  DOC_REMIND: n => `Reminder: please upload your nursing certificate, council registration and ID to complete your Uyir registration: ${regLink(n)}`,
  CORRECTION: n => `Uyir: some of your documents need correction (${n.review_note || 'see the link'}). Please re-upload: ${regLink(n)}`,
  REJECTED:   n => `Uyir: we are unable to approve your registration at this time. Reason: ${n.review_note || 'not specified'}.`,
  VERIFIED:   n => `Congratulations ${firstName(n)}! Your documents are verified. Please add your bank details for payments: ${regLink(n)}`,
  NOT_FOUND:  () => `Vanakkam! Uyir registration needs an Indian mobile number. Please message us from your Indian WhatsApp number, or contact your district office.`,
};
const SMS_TEMPLATES = new Set(['INVITE', 'INVITE_AGAIN']);
const WINDOW_MS = 24 * 3600e3 - 5 * 60e3;   // Meta's customer-service window, with a safety margin
const inWindow = n => n.whatsapp_last_inbound_at && Date.now() - new Date(n.whatsapp_last_inbound_at).getTime() < WINDOW_MS;

/**
 * How an invite (or a resend) would reach this nurse: 'whatsapp' once they have messaged us,
 * else 'sms' with the registration link. null = can't be contacted (DNC, or no consent).
 */
export const inviteChannel = n => (n.dnc ? null : n.whatsapp_connected_at && n.consent_whatsapp ? 'whatsapp' : n.consent_sms ? 'sms' : null);

/**
 * Send one message to a nurse. Nothing goes out on Do Not Contact or without consent for the channel.
 * Within 24 h of the nurse's last message we reply in free text; otherwise an approved template is used.
 * Returns the channels used ([] = nothing sent; the reason is logged).
 */
export async function queueMessage(nurse, template) {
  const body = TEMPLATES[template](nurse);
  const channel = SMS_TEMPLATES.has(template) ? 'sms' : 'whatsapp';
  const allowed = !nurse.dnc && (channel === 'sms' ? nurse.consent_sms : nurse.consent_whatsapp);

  if (allowed && channel === 'sms') {
    // No SMS gateway: recorded as 'simulated'. Staff send the invite from their own phone (manualSmsBody).
    await q(`INSERT INTO messages (nurse_id, channel, template, body, status) VALUES (?,?,?,?,?)`, nurse.id, 'sms', template, body, 'simulated');
  } else if (allowed) {
    const payload = inWindow(nurse) ? textPayload(waNumber(nurse), body) : buildPayload(nurse, template, regLink(nurse));
    await q(`INSERT INTO messages (nurse_id, channel, template, body, status, payload) VALUES (?,?,?,?,?,?)`,
      nurse.id, 'whatsapp', template, body, WA_PROVIDER === 'meta' ? 'queued' : 'simulated', payload);
  }

  const label = channel === 'sms' ? 'SMS' : 'WhatsApp';
  if (allowed) await logEvent(nurse.id, 'message', { note: `${template} sent by ${label}`, actor: 'system' });
  else await logEvent(nurse.id, 'message', { note: `${template} not sent: ${nurse.dnc ? 'Do Not Contact' : `no ${label} consent`}`, actor: 'system' });
  return allowed ? [channel] : [];
}

/** Free-text reply to someone who just messaged us (not linked to a nurse). */
export async function replyText(to, template) {
  const body = TEMPLATES[template]();
  await q(`INSERT INTO messages (nurse_id, channel, template, body, status, payload) VALUES (NULL,?,?,?,?,?)`,
    'whatsapp', template, body, WA_PROVIDER === 'meta' ? 'queued' : 'simulated', textPayload(to, body));
}

/** Text for the SMS an admin sends from their own phone: the invite with the personal registration link. */
export const manualSmsBody = nurse => TEMPLATES.INVITE(nurse);
