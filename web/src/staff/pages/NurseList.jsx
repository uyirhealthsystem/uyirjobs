import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api, qs } from '../../lib/api.js';
import { fmt, when } from '../../lib/format.js';
import { useToast } from '../../components/Toast.jsx';
import { Loading, ErrorPanel } from '../../components/Loading.jsx';
import { StatusPill } from '../../components/StatusPill.jsx';
import { useAuth, isSuper, NOT_SENT, sentBy } from '../auth.jsx';

const FILTER_KEYS = ['q', 'district', 'status', 'origin', 'sort', 'dnc', 'page'];

export function NurseList() {
  const { user, meta } = useAuth();
  const [params, setParams] = useSearchParams();
  const filters = Object.fromEntries(FILTER_KEYS.map(k => [k, params.get(k) || '']));
  const [selected, setSelected] = useState(() => new Set());
  const [showAdd, setShowAdd] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const query = qs(filters);

  const mine = useQuery({ queryKey: ['pages', 'mine'], queryFn: () => api.get('/api/pages/mine'), enabled: !isSuper(user) });
  const list = useQuery({ queryKey: ['nurses', query], queryFn: () => api.get('/api/nurses' + query), placeholderData: keepPreviousData });
  useEffect(() => setSelected(new Set()), [query]);

  const bulk = useMutation({
    mutationFn: ids => api.post('/api/nurses/bulk', { ids, action: 'invite' }),
    onSuccess: r => {
      toast(`Links sent to ${r.done}; skipped ${r.skippedCount}${r.skipped[0] ? ` (e.g. ${r.skipped[0].reason})` : ''}`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['nurses'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: e => toast(e.message, true),
  });

  const setFilter = next => setParams(new URLSearchParams(Object.entries(next).filter(([, v]) => v !== '' && v != null)));
  const d = list.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.size)) : 1;
  const title = filters.status ? meta.statuses[filters.status]?.label : filters.origin === 'added' ? 'Added via Add nurse button' : 'Nurses';
  const scopeLabel = isSuper(user) ? 'All districts' : `${user.district} district`;
  const toggle = id => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOnPage = d?.rows.length > 0 && d.rows.every(r => selected.has(r.id));

  return (
    <>
      <div className="pagehead">
        <div><h1>{title}</h1><div className="muted">{scopeLabel}{d && ` · ${fmt(d.total)} record${d.total === 1 ? '' : 's'}`}</div></div>
        <div className="actions">
          {isSuper(user) && <a className="btn" href={'/api/nurses/export.csv' + qs({ ...filters, page: '', sort: '' })}>Export CSV</a>}
          <button className="btn primary" onClick={() => setShowAdd(s => !s)} aria-expanded={showAdd}>Add nurse</button>
        </div>
      </div>

      {showAdd && <AddNurse onDone={() => setShowAdd(false)} />}

      {!isSuper(user) && mine.data && (
        <div className="banner info">
          {mine.data.page
            ? <><b>Page {mine.data.page.page_no}</b> released {when(mine.data.page.released_at)} · {fmt(mine.data.page.size)} nurses from the Uyir nurse list, {fmt(mine.data.page.verified_nurses)} verified so far.
                {' '}The Super Admin releases the next page after checking this one (at most one page a day).</>
            : <>No page of nurses from the Uyir nurse list has been released to you yet. The Super Admin releases one page at a time.</>}
        </div>
      )}

      <div className="panel">
        <FilterBar filters={filters} onApply={f => setFilter({ ...f, page: '' })} />

        {selected.size > 0 && (
          <div className="toolbar">
            <b>{selected.size} selected</b>
            <button className="btn sm primary" disabled={bulk.isPending} onClick={() => bulk.mutate([...selected])}>
              {bulk.isPending ? 'Saving…' : 'Mark as invited'}
            </button>
            <span className="small muted">Activates each nurse’s registration link. No SMS is sent automatically: call each nurse and use “SMS WhatsApp link” on their page. Nurses already invited or on Do Not Contact are skipped.</span>
          </div>
        )}

        {list.isPending ? <Loading /> : list.isError ? <ErrorPanel error={list.error} onRetry={list.refetch} /> : (
          <>
            <div className="tablewrap" style={{ opacity: list.isPlaceholderData ? 0.6 : 1 }}>
              <table>
                <thead>
                  <tr>
                    <th><input type="checkbox" aria-label="Select all on this page" checked={allOnPage}
                      onChange={e => setSelected(s => { const n = new Set(s); d.rows.forEach(r => (e.target.checked ? n.add(r.id) : n.delete(r.id))); return n; })} /></th>
                    <th>Nurse ID</th><th>Name</th><th>Mobile</th>{isSuper(user) && <th>District</th>}<th>Status</th><th>Entered via</th><th>Qualification</th><th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.length ? d.rows.map(r => <NurseRow key={r.id} r={r} checked={selected.has(r.id)} onToggle={toggle} showDistrict={isSuper(user)} />)
                    : <tr><td colSpan={9} className="empty">Nothing here</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <span className="muted">Page {d.page} of {fmt(pages)}</span>
              <button className="btn sm" disabled={d.page <= 1} onClick={() => setFilter({ ...filters, page: d.page - 1 })}>‹ Prev</button>
              <button className="btn sm" disabled={d.page >= pages} onClick={() => setFilter({ ...filters, page: d.page + 1 })}>Next ›</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function NurseRow({ r, checked, onToggle, showDistrict }) {
  const navigate = useNavigate();
  const open = () => navigate(`/nurses/${encodeURIComponent(r.id)}`);
  return (
    <tr className="click" onClick={e => { if (e.target.type !== 'checkbox') open(); }}>
      <td><input type="checkbox" aria-label={`Select ${r.name}`} checked={checked} onChange={() => onToggle(r.id)} /></td>
      <td className="mono">{r.id}</td>
      <td><a href={`/nurses/${encodeURIComponent(r.id)}`} onClick={e => { e.preventDefault(); open(); }}>{r.name}</a></td>
      <td className="mono">{r.mobile}</td>
      {showDistrict && <td>{r.district || <span className="muted">—</span>}</td>}
      <td>
        <StatusPill status={r.status} />{' '}
        {r.whatsapp_connected_at && <span className="pill ch-whatsapp" title="Connected on WhatsApp">WA</span>}{' '}
        {r.dnc && <span className="pill dnc">DNC</span>}
      </td>
      <td><OriginTag r={r} /></td>
      <td>{r.qualification || ''}</td>
      <td className="small muted">{when(r.updated_at)}</td>
    </tr>
  );
}

/** How the nurse got into the app. Nurses outside the Uyir list stand out (only the Super Admin verifies them). */
export function OriginTag({ r }) {
  const { meta } = useAuth();
  const o = meta.origins[r.origin];
  if (!o) return null;
  if (r.origin === 'list') return <span className="small muted">{o.short}{r.page_no ? ` · page ${r.page_no}` : r.page_no === 0 ? ' · earlier' : ''}</span>;
  return <span className={`pill o-${r.origin}`} title={o.label + (r.added_by_name ? ` by ${r.added_by_name}` : '')}>
    {o.short}{r.added_by_name ? ` · ${r.added_by_name}` : ''}
  </span>;
}

function FilterBar({ filters, onApply }) {
  const { user, meta } = useAuth();
  const [f, setF] = useState(filters);
  useEffect(() => setF(filters), [filters.q, filters.district, filters.status, filters.origin, filters.sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }));
  const sorts = [['id', 'Nurse ID'], ['name', 'Name'], ['updated', 'Recently updated'], ...(isSuper(user) ? [['district', 'District']] : [])];
  return (
    <form className="toolbar" onSubmit={e => { e.preventDefault(); onApply(f); }}>
      <input type="search" className="grow" aria-label="Search" placeholder="Search name, ID, mobile or council reg. no." value={f.q} onChange={set('q')} />
      {isSuper(user) && (
        <select aria-label="District" value={f.district} onChange={set('district')}>
          <option value="">All districts</option>
          {meta.districts.map(x => <option key={x}>{x}</option>)}
        </select>
      )}
      <select aria-label="Status" value={f.status} onChange={set('status')}>
        <option value="">All statuses</option>
        {Object.entries(meta.statuses).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
      </select>
      <select aria-label="Entered via" value={f.origin} onChange={set('origin')}>
        <option value="">Entered any way</option>
        <option value="outside">Not in the Uyir list (all)</option>
        {Object.entries(meta.origins).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}
      </select>
      <select aria-label="Sort" value={f.sort || 'id'} onChange={set('sort')}>
        {sorts.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}
      </select>
      <button className="btn">Apply</button>
    </form>
  );
}

function AddNurse({ onDone }) {
  const { user, meta } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', mobile: '', district: '', source: '', invite: true });
  const create = useMutation({
    mutationFn: body => api.post('/api/nurses', body),
    onSuccess: r => {
      if (r.notified && !r.notified.length) toast(`Created ${r.id}. ${NOT_SENT}`, true);
      else toast(`Created ${r.id}${r.notified ? ': ' + sentBy(r.notified) : ''}`);
      qc.invalidateQueries({ queryKey: ['nurses'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      onDone();
      navigate(`/nurses/${encodeURIComponent(r.id)}`);
    },
    onError: e => toast(e.message, true),
  });
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  return (
    <div className="panel">
      <h2>Add nurse</h2>
      <div className="small muted" style={{ marginBottom: 8 }}>
        For nurses who are not in the Uyir nurse list. They are marked “Added via Add nurse button”{isSuper(user) ? '' : ' with your name'}, and only the Super Admin can review their documents and verify them.
      </div>
      <form className="toolbar" onSubmit={e => { e.preventDefault(); create.mutate(form); }}>
        <input type="text" aria-label="Full name" placeholder="Full name" value={form.name} onChange={set('name')} required />
        <input type="tel" aria-label="Mobile" placeholder="Mobile (10 digits)" value={form.mobile} onChange={set('mobile')} required />
        {isSuper(user) && (
          <select aria-label="District" value={form.district} onChange={set('district')} required>
            <option value="">District…</option>
            {meta.districts.map(x => <option key={x}>{x}</option>)}
          </select>
        )}
        <input type="text" aria-label="Source" placeholder="Source (optional)" value={form.source} onChange={set('source')} />
        <label className="chk"><input type="checkbox" checked={form.invite} onChange={set('invite')} /> Mark as invited (activates the registration link)</label>
        <button className="btn primary" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create'}</button>
      </form>
    </div>
  );
}
