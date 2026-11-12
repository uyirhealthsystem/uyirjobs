import { Router } from 'express';
import { one } from '../db/pool.js';
import { httpError } from '../lib/errors.js';
import { DOC_TYPES } from '../domain/workflow.js';
import { logEvent } from '../services/events.js';
import { getNurse } from '../services/nurses.js';
import { storageFor, safeFilename } from '../services/storage.js';
import { canSee } from '../middleware/auth.js';

export const documentsRouter = Router();

documentsRouter.get('/:id/file', async (req, res) => {
  const d = /^\d+$/.test(req.params.id) ? await one(`SELECT * FROM documents WHERE id = ?`, Number(req.params.id)) : null;
  if (!d || !canSee(req.user, await getNurse(d.nurse_id))) throw httpError(404, 'Not found');
  const store = storageFor(d.storage);
  await logEvent(d.nurse_id, 'document', { note: `Viewed ${DOC_TYPES[d.type]?.label || d.type}`, user: req.user });   // access audit for sensitive IDs
  // S3: authorise here, then hand the browser a presigned URL that expires in about a minute.
  const url = await store.viewUrl(d.stored_name, { filename: d.filename, mime: d.mime });
  res.set('Cache-Control', 'private, no-store');
  if (url) return res.redirect(302, url);
  const buf = await store.get(d.stored_name);
  res.set({ 'Content-Type': d.mime, 'Content-Disposition': `inline; filename="${safeFilename(d.filename)}"` }).send(buf);
});
