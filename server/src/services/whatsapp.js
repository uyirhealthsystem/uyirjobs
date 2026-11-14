// WhatsApp messages through the WhatsApp Business Cloud API (Meta).
//
// Business-initiated messages must use templates pre-approved in WhatsApp Manager: one per
// entry in WA_TEMPLATES (same name, same number of {{n}} body variables, in WHATSAPP_LANG).
// See docs/WHATSAPP.md.
//
// Flow: the invite SMS carries a wa.me link that opens a chat with the business number,
// pre-typed "Hi Uyir Team, I want to register. My code: <code>". When the nurse sends it, Meta calls our webhook; we match the
// code (or the sender's number) to the nurse and reply with their registration link.
// The nurse messaging us is their opt-in and opens a 24-hour window for free-text replies.
//
// Sending is decoupled from requests: rows are written to `messages` as 'queued' inside the
// same transaction as the status change, and a worker sends them. Workers on several app
// servers can run together: rows are claimed with FOR UPDATE SKIP LOCKED.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { q } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export const PROVIDER = config.WHATSAPP_PROVIDER;
const API_BASE = config.WHATSAPP_API_BASE.replace(/\/+$/, '');
const MAX_ATTEMPTS = 5;
export const BUSINESS_NUMBER = config.WHATSAPP_BUSINESS_NUMBER;
const log = logger.child({ module: 'whatsapp' });

/** The message the chat link pre-types; the code at the end tells us which nurse sent it. */
export const chatText = code => (code ? `Hi Uyir Team, I want to register. My code: ${code}` : 'Hi Uyir Team, I want to register.');
/** wa.me link that opens a chat with us, pre-typed with chatText. */
export const chatLink = code => `https://wa.me/${BUSINESS_NUMBER || '910000000000'}?text=${encodeURIComponent(chatText(code))}`;
/** Invite codes look like UY7K3M9Q (no 0/O/1/I to avoid confusion). */
export const CODE_RE = /\bUY[2-9A-HJ-NP-Z]{6}\b/i;

const first = n => String(n.name || '').split(/\s+/)[0] || 'Nurse';

/** App template → approved WhatsApp template name + its body variables ({{1}}, {{2}} …). */
export const WA_TEMPLATES = {
  REG_DONE:   { name: 'uyir_registration_received', params: (n, link) => [first(n), link] },
  DOC_REMIND: { name: 'uyir_document_reminder',     params: (n, link) => [first(n), link] },
  CORRECTION: { name: 'uyir_correction_required',   params: (n, link) => [first(n), n.review_note || 'see the link', link] },
  REJECTED:   { name: 'uyir_registration_rejected', params: n => [first(n), n.review_note || 'not specified'] },
  VERIFIED:   { name: 'uyir_verified_add_bank',     params: (n, link) => [first(n), link] },
  REG_LINK:   { name: 'uyir_registration_link',     params: (n, link) => [first(n), link] },   // resend outside the 24 h window
};

/** The nurse's WhatsApp number: the one they messaged us from, else their mobile. */
export const waNumber = nurse => nurse.whatsapp_number || '91' + nurse.mobile;

/** Payload stored on the message row, so the worker sends exactly what was decided at the time. */
export function buildPayload(nurse, template, link) {
  const t = WA_TEMPLATES[template];
  if (!t) return null;
  return {
    to: waNumber(nurse), name: t.name, lang: config.WHATSAPP_LANG,
    params: t.params(nurse, link).map(p => String(p).slice(0, 1000)),
  };
}
/** Free-text message: only allowed within 24 h of the nurse's last message to us. */
export const textPayload = (to, body) => ({ to, kind: 'text', body: String(body).slice(0, 4096) });

/** Incoming messages from a webhook body: [{ id, from, text, name }]. */
export function parseInbound(body) {
  const out = [];
  for (const entry of body?.entry || []) for (const ch of entry.changes || []) {
    const names = Object.fromEntries((ch.value?.contacts || []).map(c => [c.wa_id, c.profile?.name]));
    for (const m of ch.value?.messages || []) {
      const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? '';
      if (m.id && m.from) out.push({ id: m.id, from: String(m.from).replace(/\D/g, ''), text: String(text).slice(0, 2000), name: names[m.from] || null });
    }
  }
  return out;
}

async function sendToMeta(p) {
  const res = await fetch(`${API_BASE}/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(p.kind === 'text'
      ? { messaging_product: 'whatsapp', to: p.to, type: 'text', text: { body: p.body, preview_url: true } }
      : {
        messaging_product: 'whatsapp', to: p.to, type: 'template',
        template: {
          name: p.name, language: { code: p.lang },
          components: [{ type: 'body', parameters: p.params.map(text => ({ type: 'text', text })) }],
        },
      }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.messages?.[0]?.id) return { id: data.messages[0].id };
  const err = data.error || {};
  // 429 / 5xx / throttling codes are worth retrying; other 4xx (bad number, template not approved…) are not.
  const retry = res.status === 429 || res.status >= 500 || [4, 80007, 130429, 131048, 131056].includes(err.code);
  return { error: `${res.status} ${err.code ?? ''} ${err.message || 'send failed'}`.trim(), retry };
}

/** Send one batch of due messages. Returns how many were attempted. */
export async function sendDue(limit = 20) {
  // Messages stuck in 'sending' (a server died mid-send) go back to the queue.
  await q(`UPDATE messages SET status = 'queued' WHERE channel = 'whatsapp' AND status = 'sending' AND updated_at < now() - interval '2 minutes'`);
  const rows = await q(`UPDATE messages SET status = 'sending', attempts = attempts + 1, updated_at = now()
      WHERE id IN (SELECT id FROM messages WHERE channel = 'whatsapp' AND status = 'queued' AND next_attempt_at <= now()
                   ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED)
      RETURNING id, payload, attempts`, limit);
  for (const m of rows) {
    let r;
    try { r = await sendToMeta(m.payload); } catch (e) { r = { error: e.message, retry: true }; }
    if (r.id) {
      await q(`UPDATE messages SET status = 'sent', provider_id = ?, sent_at = now(), error = NULL, updated_at = now() WHERE id = ?`, r.id, m.id);
      log.info({ messageId: m.id, attempts: m.attempts }, 'WhatsApp message accepted by Meta');
    } else if (r.retry && m.attempts < MAX_ATTEMPTS) {
      log.warn({ messageId: m.id, attempts: m.attempts, error: r.error }, 'WhatsApp message failed, will retry');
      // Back off 30 s, 2 min, 8 min, 32 min …
      await q(`UPDATE messages SET status = 'queued', error = ?, next_attempt_at = now() + make_interval(secs => ?), updated_at = now() WHERE id = ?`,
        r.error, 30 * 4 ** (m.attempts - 1), m.id);
    } else {
      log.warn({ messageId: m.id, error: r.error }, 'WhatsApp message failed permanently');
      await q(`UPDATE messages SET status = 'failed', error = ?, updated_at = now() WHERE id = ?`, r.error, m.id);
    }
  }
  return rows.length;
}

let timer = null, running = null;
export function startWorker() {
  if (PROVIDER !== 'meta' || timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = (async () => {
      try { while ((await sendDue()) > 0); } catch (e) { log.error({ err: e }, 'worker error'); } finally { running = null; }
    })();
  }, config.WHATSAPP_POLL_MS);
  timer.unref();
  log.info({ apiVersion: config.WHATSAPP_API_VERSION, pollMs: config.WHATSAPP_POLL_MS }, 'sending via WhatsApp Cloud API');
}
/** Stop polling and wait for an in-flight batch to finish (graceful shutdown). */
export async function stopWorker() {
  clearInterval(timer); timer = null;
  await running;
}

// ---------------- webhook ----------------
/** GET handshake when the webhook URL is registered in the Meta app dashboard. */
export function verifyHandshake(query) {
  const t = config.WHATSAPP_VERIFY_TOKEN;
  return t && query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === t ? String(query['hub.challenge'] ?? '') : null;
}

/** Meta signs the raw body with the app secret. */
export function validSignature(raw, header) {
  const secret = config.WHATSAPP_APP_SECRET;
  if (!secret) return !config.isProd;   // development without a secret: accept
  if (!raw) return false;
  const want = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  const got = String(header || '');
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

const RANK = { queued: 0, sending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
/** Apply sent / delivered / read / failed updates. Never moves a status backwards. */
export async function applyStatuses(body) {
  let n = 0;
  for (const entry of body?.entry || []) for (const ch of entry.changes || []) for (const s of ch.value?.statuses || []) {
    if (!s.id || RANK[s.status] == null) continue;
    const err = s.status === 'failed' ? (s.errors?.map(e => `${e.code} ${e.title || e.message || ''}`.trim()).join('; ') || 'failed') : null;
    const r = await q(`UPDATE messages SET status = ?, error = COALESCE(?, error), updated_at = now()
        WHERE provider_id = ? AND channel = 'whatsapp' AND (CASE status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE 0 END) < ?
        RETURNING id`, s.status, err, s.id, RANK[s.status]);
    n += r.length;
    // Meta accepted the message earlier but could not deliver it (e.g. payment, number, policy).
    if (err) log.warn({ messageId: r[0]?.id ?? null, error: err }, 'WhatsApp delivery failed (receipt from Meta)');
  }
  return n;
}
