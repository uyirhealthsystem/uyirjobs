// WhatsApp webhook (called by Meta): delivery receipts and incoming messages ("Hi Uyir <code>").
import { Router } from 'express';
import { httpError } from '../lib/errors.js';
import { handleInbound } from '../services/inbound.js';
import * as whatsapp from '../services/whatsapp.js';

export const whatsappRouter = Router();

whatsappRouter.get('/webhook', (req, res) => {
  const challenge = whatsapp.verifyHandshake(req.query);
  if (challenge == null) throw httpError(403, 'Verification failed');
  res.type('text/plain').send(challenge);
});

whatsappRouter.post('/webhook', async (req, res) => {
  // req.rawBody is captured by the JSON parser: the signature covers the exact bytes Meta sent.
  if (!whatsapp.validSignature(req.rawBody, req.get('x-hub-signature-256'))) throw httpError(401, 'Bad signature');
  const inbound = whatsapp.parseInbound(req.body);
  if (inbound.length) await handleInbound(inbound);
  res.json({ ok: true, updated: await whatsapp.applyStatuses(req.body), received: inbound.length });
});
