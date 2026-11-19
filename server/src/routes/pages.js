// Page release: the Super Admin hands nurses from the Uyir nurse list to each district one page at a
// time. Rules, per district: at most one page a day (India time), and the next page only after the
// Super Admin has verified the current one. District Admins see list nurses only once they are on a
// released page (see scope / canSee in middleware/auth.js).
import { Router } from 'express';
import { q, one, tx, insertMany } from '../db/pool.js';
import { httpError } from '../lib/errors.js';
import { DISTRICTS, STATUSES, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../domain/workflow.js';
import { isSuper, needSuper } from '../middleware/auth.js';

export const pagesRouter = Router();

const TODAY_IST = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;
const releasedToday = alias => `(${alias}.page_no > 0 AND (${alias}.released_at AT TIME ZONE 'Asia/Kolkata')::date = ${TODAY_IST})`;
const UNRELEASED = `origin = 'list' AND page_id IS NULL AND deleted_at IS NULL`;

/** Why the next page can't be released for this district (null = it can). */
function blockReason(latest, remaining) {
  if (latest?.page_no > 0 && !latest.verified_at) return `Page ${latest.page_no} is not verified yet`;
  if (latest?.released_today) return 'A page was already released today; the next one can be released tomorrow';
  if (!remaining) return 'No nurses left in the Uyir nurse list for this district';
  return null;
}

const latestPage = district => one(`SELECT p.*, ${releasedToday('p')} released_today FROM nurse_pages p
    WHERE p.district = ? ORDER BY p.page_no DESC LIMIT 1`, district);

// District Admin: the page they are working on now (for the banner on their nurse list).
pagesRouter.get('/mine', async (req, res) => {
  const { user } = req;
  if (isSuper(user)) return res.json({ page: null });
  const page = await one(`SELECT p.page_no, p.size, p.released_at, p.verified_at,
        (SELECT COUNT(*) FROM nurses n WHERE n.page_id = p.id AND n.deleted_at IS NULL AND n.status = 'VERIFIED') verified_nurses
      FROM nurse_pages p WHERE p.district = ? AND p.page_no > 0 ORDER BY p.page_no DESC LIMIT 1`, user.district);
  res.json({ page: page || null });
});

pagesRouter.use((req, res, next) => { needSuper(req.user); next(); });

// Every district: nurses still waiting in the list, the current page and its progress, whether the next can go out.
pagesRouter.get('/', async (req, res) => {
  const statusCols = Object.keys(STATUSES).map(s => `COUNT(*) FILTER (WHERE n.status = '${s}') "${s}"`).join(', ');
  const [latest, remaining, progress] = await Promise.all([
    q(`SELECT DISTINCT ON (p.district) p.id, p.district, p.page_no, p.size, p.released_at, p.verified_at, ${releasedToday('p')} released_today,
          rb.name released_by_name, vb.name verified_by_name
        FROM nurse_pages p LEFT JOIN users rb ON rb.id = p.released_by LEFT JOIN users vb ON vb.id = p.verified_by
        ORDER BY p.district, p.page_no DESC`),
    q(`SELECT district, COUNT(*) c FROM nurses WHERE ${UNRELEASED} AND district IS NOT NULL GROUP BY district`),
    q(`SELECT n.page_id, COUNT(*) total, ${statusCols} FROM nurses n
        WHERE n.deleted_at IS NULL AND n.page_id IN (SELECT DISTINCT ON (district) id FROM nurse_pages ORDER BY district, page_no DESC)
        GROUP BY n.page_id`),
  ]);
  const byDistrict = Object.fromEntries(latest.map(p => [p.district, p]));
  const left = Object.fromEntries(remaining.map(r => [r.district, r.c]));
  const prog = Object.fromEntries(progress.map(r => [r.page_id, r]));
  res.json({
    pageSize: PAGE_SIZE_DEFAULT, maxPageSize: PAGE_SIZE_MAX,
    districts: DISTRICTS.map(d => {
      const p = byDistrict[d] || null;
      return { district: d, remaining: left[d] || 0, page: p && { ...p, progress: prog[p.id] || { total: 0 } }, blocked: blockReason(p, left[d] || 0) };
    }),
  });
});

/** Release the next page for one district. Throws 409 with the reason when it can't. */
async function releaseOne(district, size, user) {
  return tx(async () => {
    await q(`SELECT pg_advisory_xact_lock(727002, hashtext(?))`, district);   // two releases at once → one page
    const latest = await latestPage(district);
    const { c: remaining } = await one(`SELECT COUNT(*) c FROM nurses WHERE ${UNRELEASED} AND district = ?`, district);
    const reason = blockReason(latest, remaining);
    if (reason) throw httpError(409, reason);
    const pageNo = (latest?.page_no ?? 0) + 1;
    const page = await one(`INSERT INTO nurse_pages (district, page_no, size, released_by) VALUES (?,?,0,?) RETURNING id`, district, pageNo, user.id);
    const ids = (await q(`UPDATE nurses SET page_id = ?, updated_at = now() WHERE id IN (
        SELECT id FROM nurses WHERE ${UNRELEASED} AND district = ? ORDER BY id LIMIT ? FOR UPDATE)
      RETURNING id`, page.id, district, size)).map(r => r.id);
    await q(`UPDATE nurse_pages SET size = ? WHERE id = ?`, ids.length, page.id);
    await insertMany('events', ['nurse_id', 'type', 'note', 'user_id', 'actor'], ids.map(id => ({
      nurse_id: id, type: 'note', note: `Released to ${district} District Admin (page ${pageNo})`, user_id: user.id, actor: user.username,
    })));
    return { district, page_no: pageNo, count: ids.length };
  });
}

// Body: { district } for one district, or { all: true } for every district that is ready. size: nurses per page.
pagesRouter.post('/release', async (req, res) => {
  const body = req.body || {};
  const size = Math.round(Number(body.size) || PAGE_SIZE_DEFAULT);
  if (size < 1 || size > PAGE_SIZE_MAX) throw httpError(400, `Page size must be 1 to ${PAGE_SIZE_MAX}`);
  if (body.all) {
    const released = [], skipped = [];
    for (const d of DISTRICTS) {
      try { released.push(await releaseOne(d, size, req.user)); }
      catch (e) { if (e.status === 409) skipped.push({ district: d, reason: e.message }); else throw e; }
    }
    req.log.info({ released: released.length, size }, 'pages released to all districts');
    return res.json({ released, skipped });
  }
  if (!DISTRICTS.includes(body.district)) throw httpError(400, 'Choose a district');
  const r = await releaseOne(body.district, size, req.user);
  req.log.info(r, 'page released');
  res.json({ released: [r], skipped: [] });
});

// The Super Admin has checked the district's work on this page: the next page can be released (from tomorrow if one went out today).
pagesRouter.post('/:id/verify', async (req, res) => {
  const p = /^\d+$/.test(req.params.id) ? await one(`SELECT * FROM nurse_pages WHERE id = ?`, Number(req.params.id)) : null;
  if (!p) throw httpError(404, 'Page not found');
  if (p.verified_at) throw httpError(409, `Page ${p.page_no} is already verified`);
  await q(`UPDATE nurse_pages SET verified_at = now(), verified_by = ? WHERE id = ? AND verified_at IS NULL`, req.user.id, p.id);
  res.json({ ok: true });
});
