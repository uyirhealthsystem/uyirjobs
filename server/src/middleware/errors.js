import multer from 'multer';
import { HttpError, httpError } from '../lib/errors.js';

/** Postgres / body-parser / upload errors that are the caller's fault, not ours. */
function normalize(e) {
  if (e instanceof HttpError) return e;
  if (e.code === '23505') return httpError(409, 'That record already exists (duplicate mobile number or ID)');
  if (e.code === '22P02' || e.code === '22001') return httpError(400, 'Invalid input');
  if (e.type === 'entity.too.large') return httpError(413, 'Request too large');
  if (e.type === 'entity.parse.failed') return httpError(400, 'Invalid JSON');
  if (e instanceof multer.MulterError) return httpError(e.code === 'LIMIT_FILE_SIZE' ? 413 : 400, e.code === 'LIMIT_FILE_SIZE' ? 'File is too large (up to 25 MB; larger PDFs are compressed to 5 MB)' : e.message);
  return e;
}

export const notFound = (req, res, next) => next(httpError(404, 'No such endpoint'));

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const e = normalize(err);
  const status = e.status || 500;
  if (status >= 500) req.log?.error({ err }, 'request failed');
  if (res.headersSent) return res.end();
  res.status(status).json({ error: status >= 500 && !(e instanceof HttpError) ? 'Internal error' : e.message, ...(e.details ? { details: e.details } : {}) });
}
