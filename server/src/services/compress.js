// Shrinks an oversized PDF (usually a phone scan) with Ghostscript: images are resampled to
// 150 dpi ("/ebook"), which keeps certificates readable. Returns the smaller PDF, or null when
// Ghostscript is unavailable or fails (the caller then rejects the upload as too large).
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';

const GS = process.env.GHOSTSCRIPT_BIN || (process.platform === 'win32' ? 'gswin64c' : 'gs');

export async function compressPdf(buf) {
  const dir = await mkdtemp(join(tmpdir(), 'uyir-pdf-'));
  const src = join(dir, 'in.pdf'), out = join(dir, 'out.pdf');
  try {
    await writeFile(src, buf);
    await new Promise((resolve, reject) => execFile(GS, [
      '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5',
      '-dPDFSETTINGS=/ebook', '-dDetectDuplicateImages=true', `-sOutputFile=${out}`, src,
    ], { timeout: 60_000, maxBuffer: 1024 * 1024 }, err => err ? reject(err) : resolve()));
    const small = await readFile(out);
    return small.length && small.length < buf.length ? small : buf;
  } catch (e) {
    logger.warn({ err: e.message }, 'PDF compression failed');
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
