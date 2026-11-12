import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../lib/api.js';
import { fmt, pct, when } from '../../lib/format.js';
import { Loading, ErrorPanel } from '../../components/Loading.jsx';
import { EventText } from '../../components/StatusPill.jsx';
import { useAuth, isSuper } from '../auth.jsx';

const COLS = [['total', 'Total'], ['NEW', 'Not invited'], ['INVITED', 'Invited'], ['REGISTERED', 'Docs pending'],
  ['SUBMITTED', 'To review'], ['CORRECTION_REQUIRED', 'Correction'], ['VERIFIED', 'Verified']];

export function Dashboard() {
  const { user, meta } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const district = params.get('district') || '';
  const [sort, setSort] = useState({ key: 'district', dir: 1 });
  const q = useQuery({ queryKey: ['dashboard', district], queryFn: () => api.get('/api/dashboard' + qs({ district })) });

  const rows = useMemo(() => {
    const val = (r, k) => (k === 'rate' ? r.VERIFIED / (r.total || 1) : r[k]);
    return [...(q.data?.districts || [])].sort((a, b) => {
      const va = val(a, sort.key), vb = val(b, sort.key);
      return (va > vb ? 1 : va < vb ? -1 : 0) * sort.dir;
    });
  }, [q.data, sort]);

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorPanel error={q.error} onRetry={q.refetch} />;
  const c = q.data.cards;
  const base = district ? { district } : {};
  const title = district ? `${district} district` : isSuper(user) ? 'All districts' : `${user.district} district`;

  const cards = [['total', 'Total nurses', {}], ...Object.keys(meta.statuses).map(s => [s, meta.statuses[s].label, { status: s }]),
    ['whatsapp_connected', 'Connected on WhatsApp', null], ['bank_details', 'Bank details added', null], ['dnc', 'Do Not Contact', { dnc: '1' }]];

  // Progress: nurses who have reached each step (a verified nurse also counts as invited, registered…).
  const reached = st => Object.entries(meta.statuses).filter(([, s]) => s.stage >= st).reduce((a, [k]) => a + (c[k] || 0), 0);
  const funnel = meta.funnel.map(f => ({ ...f, v: f.stage === 0 ? c.total : reached(f.stage) }));
  const top = funnel[0].v || 1;

  const sortBy = k => setSort(s => ({ key: k, dir: s.key === k ? -s.dir : k === 'district' ? 1 : -1 }));
  const Th = ({ k, children, num = true }) => (
    <th className={`sort ${num ? 'n' : ''}`} onClick={() => sortBy(k)} aria-sort={sort.key === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
      {children}{sort.key === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{title}</h1>
          <div className="muted">Nurse information collected through personal registration links.</div>
        </div>
        {isSuper(user) && (
          <div className="toolbar" style={{ margin: 0 }}>
            <select aria-label="District" value={district} onChange={e => navigate('/' + qs({ district: e.target.value }))}>
              <option value="">All districts</option>
              {meta.districts.map(d => <option key={d}>{d}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className="cards">
        {cards.map(([k, label, filter]) => {
          const inner = <>
            <div className="v">{fmt(c[k])}</div><div className="l">{label}</div>
            {k !== 'total' && <div className="p">{pct(c[k], c.total)}</div>}
          </>;
          return filter
            ? <Link key={k} className={`card ${k === 'VERIFIED' ? 'accent' : ''}`} to={'/nurses' + qs({ ...base, ...filter })}>{inner}</Link>
            : <div key={k} className="card">{inner}</div>;
        })}
      </div>

      <div className="grid3">
        <div className="panel">
          <h2>Registration progress</h2>
          <div className="funnel">
            {funnel.map((f, i) => (
              <div className="row" key={f.stage}>
                <div>{f.label}</div>
                <div className="bar"><i style={{ width: `${((100 * f.v) / top).toFixed(2)}%` }} /></div>
                <div className="num">{fmt(f.v)}<span>{i ? pct(f.v, funnel[i - 1].v) : ''}</span></div>
              </div>
            ))}
          </div>
          <div className="legend" style={{ marginTop: 8 }}><span>Each step counts nurses who have reached it; % is from the previous step.</span></div>
        </div>
        <div className="panel">
          <h2>Recent activity</h2>
          {q.data.recent.length ? (
            <ul className="timeline">
              {q.data.recent.slice(0, 8).map((e, i) => (
                <li key={i} className={`t-${e.type}`}>
                  <div><Link to={`/nurses/${encodeURIComponent(e.nurse_id)}`}>{e.name}</Link> <span className="muted small">{e.district}</span></div>
                  <div><EventText e={e} /></div>
                  <div className="when">{when(e.at)} · {e.actor}</div>
                </li>
              ))}
            </ul>
          ) : <div className="empty">No activity yet</div>}
        </div>
      </div>

      {isSuper(user) && !district && (
        <div className="panel">
          <h2>By district</h2>
          <div className="tablewrap">
            <table>
              <thead><tr><Th k="district" num={false}>District</Th>{COLS.map(([k, l]) => <Th key={k} k={k}>{l}</Th>)}<Th k="rate">Verified %</Th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.district} className="click" onClick={() => navigate('/' + qs({ district: r.district }))}>
                    <td>{r.district}</td>
                    {COLS.map(([k]) => <td key={k} className="n">{fmt(r[k])}</td>)}
                    <td className="n">{pct(r.VERIFIED, r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
