import { Router } from 'express';
import { q, one } from '../db/pool.js';
import { STATUSES } from '../domain/workflow.js';
import { scope, isSuper } from '../middleware/auth.js';

export const dashboardRouter = Router();
const cnt = cond => `COUNT(*) FILTER (WHERE ${cond})`;

dashboardRouter.get('/', async (req, res) => {
  const { user } = req;
  const { w, v } = scope(user);
  if (isSuper(user) && req.query.district) { w.push('n.district = ?'); v.push(String(req.query.district)); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const statusCols = Object.keys(STATUSES).map(s => `${cnt(`n.status = '${s}'`)} "${s}"`).join(', ');
  const [cards, districts, recent] = await Promise.all([
    one(`SELECT COUNT(*) total, ${statusCols}, ${cnt('n.dnc')} dnc, ${cnt('n.payout_added_at IS NOT NULL')} bank_details,
        ${cnt('n.whatsapp_connected_at IS NOT NULL')} whatsapp_connected FROM nurses n ${where}`, ...v),
    q(`SELECT n.district, COUNT(*) total, ${statusCols} FROM nurses n ${where} GROUP BY n.district ORDER BY n.district`, ...v),
    q(`SELECT e.at, e.type, e.from_status, e.to_status, e.note, e.actor, n.id nurse_id, n.name, n.district
        FROM events e JOIN nurses n ON n.id = e.nurse_id ${where} ORDER BY e.id DESC LIMIT 15`, ...v),
  ]);
  res.json({ cards, districts, recent });
});
