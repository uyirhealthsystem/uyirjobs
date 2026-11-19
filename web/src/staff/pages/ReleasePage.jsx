// Super Admin: release pages of nurses from the Uyir nurse list to District Admins.
// Per district: at most one page a day, and the next page only after the current one is verified.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../lib/api.js';
import { fmt, when } from '../../lib/format.js';
import { useToast } from '../../components/Toast.jsx';
import { Loading, ErrorPanel } from '../../components/Loading.jsx';

export function ReleasePage() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['pages'], queryFn: () => api.get('/api/pages') });
  const [size, setSize] = useState('');
  const [confirmVerify, setConfirmVerify] = useState(null);   // page id awaiting a second click

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['pages'] });
    qc.invalidateQueries({ queryKey: ['nurses'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const release = useMutation({
    mutationFn: body => api.post('/api/pages/release', { ...body, size: Number(size) || q.data.pageSize }),
    onSuccess: r => {
      const n = r.released.reduce((a, x) => a + x.count, 0);
      if (!r.released.length) toast(`Nothing released${r.skipped[0] ? `: ${r.skipped[0].reason}` : ''}`, true);
      else if (r.released.length === 1) toast(`${r.released[0].district}: page ${r.released[0].page_no} released (${fmt(n)} nurses)`);
      else toast(`Released to ${r.released.length} districts (${fmt(n)} nurses); ${r.skipped.length} not ready`);
      refresh();
    },
    onError: e => toast(e.message, true),
  });
  const verify = useMutation({
    mutationFn: id => api.post(`/api/pages/${id}/verify`, {}),
    onSuccess: () => { setConfirmVerify(null); toast('Page verified. The next page can be released (from tomorrow if one went out today).'); refresh(); },
    onError: e => toast(e.message, true),
  });

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorPanel error={q.error} onRetry={q.refetch} />;
  const rows = q.data.districts;
  const ready = rows.filter(r => !r.blocked).length;
  const busy = release.isPending || verify.isPending;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Page release</h1>
          <div className="muted">District Admins only see nurses from the Uyir nurse list once you release the page they are on.
            One page a day per district; the next page only after you verify the current one.</div>
        </div>
      </div>

      <div className="panel">
        <div className="toolbar" style={{ margin: 0 }}>
          <label className="small">Nurses per page{' '}
            <input type="number" min={1} max={q.data.maxPageSize} placeholder={String(q.data.pageSize)} value={size}
              onChange={e => setSize(e.target.value)} style={{ width: 90 }} aria-label="Nurses per page" />
          </label>
          <button className="btn primary" disabled={busy || !ready} onClick={() => release.mutate({ all: true })}>
            {release.isPending ? 'Releasing…' : `Release next page to all ready districts (${ready})`}
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>District</th><th className="n">Waiting in list</th><th>Current page</th><th>Released</th>
                <th>Progress on this page</th><th>Verified</th><th>Next page</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const p = r.page, pr = p?.progress || {};
                const notDone = p ? (pr.total || 0) - (pr.VERIFIED || 0) - (pr.REJECTED || 0) : 0;
                return (
                  <tr key={r.district}>
                    <td><Link to={'/nurses' + qs({ district: r.district })}>{r.district}</Link></td>
                    <td className="n">{fmt(r.remaining)}</td>
                    <td>{p ? (p.page_no === 0 ? 'Earlier work' : `Page ${p.page_no}`) : <span className="muted">None yet</span>}{p && <span className="muted small"> · {fmt(p.size)} nurses</span>}</td>
                    <td className="small">{p && p.page_no > 0 ? <>{when(p.released_at)}{p.released_by_name && <div className="muted">{p.released_by_name}</div>}</> : '—'}</td>
                    <td className="small">
                      {p && pr.total ? <>
                        {fmt(pr.VERIFIED || 0)} verified · {fmt(pr.SUBMITTED || 0)} to review · {fmt((pr.REGISTERED || 0) + (pr.CORRECTION_REQUIRED || 0))} pending · {fmt(pr.INVITED || 0)} invited · {fmt(pr.NEW || 0)} not invited
                      </> : '—'}
                    </td>
                    <td className="small">
                      {!p ? '—' : p.verified_at ? <span className="pill d-VERIFIED">verified</span> : confirmVerify === p.id ? (
                        <span>
                          {notDone > 0 && <div className="muted">{fmt(notDone)} nurse{notDone === 1 ? '' : 's'} not verified yet.</div>}
                          <button className="btn sm primary" disabled={busy} onClick={() => verify.mutate(p.id)}>Confirm</button>{' '}
                          <button className="btn sm" onClick={() => setConfirmVerify(null)}>Cancel</button>
                        </span>
                      ) : <button className="btn sm" disabled={busy} onClick={() => setConfirmVerify(p.id)}>Mark page verified</button>}
                      {p?.verified_at && p.verified_by_name && <div className="muted">{p.verified_by_name}</div>}
                    </td>
                    <td className="small">
                      {r.blocked ? <span className="muted">{r.blocked}</span>
                        : <button className="btn sm primary" disabled={busy} onClick={() => release.mutate({ district: r.district })}>Release page {(p?.page_no ?? 0) + 1}</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
