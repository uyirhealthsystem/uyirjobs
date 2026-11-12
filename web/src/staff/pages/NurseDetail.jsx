import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { when } from '../../lib/format.js';
import { Loading, ErrorPanel } from '../../components/Loading.jsx';
import { StatusPill } from '../../components/StatusPill.jsx';
import { useAuth } from '../auth.jsx';
import {
  ActionsPanel, DocumentsPanel, RegistrationPanel, ContactPanel, CallLogPanel, BasicDetailsPanel,
  ConsentPanel, NotePanel, HistoryPanel, MessagesPanel, NEEDS_NOTE,
} from '../nurse/panels.jsx';

export function NurseDetail() {
  const { id } = useParams();
  const { meta } = useAuth();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['nurse', id], queryFn: () => api.get('/api/nurses/' + encodeURIComponent(id)) });

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorPanel error={q.error} onRetry={q.refetch} />;
  const d = q.data, n = d.nurse, st = meta.statuses[n.status];

  return (
    <>
      <div className="pagehead">
        <div>
          <div className="muted mono">{n.id}</div>
          <h1>{n.name} <StatusPill status={n.status} /> {n.dnc && <span className="pill dnc">Do Not Contact</span>}</h1>
          <div className="muted">{n.district} · <span className="mono">{n.mobile}</span>{n.source && ` · ${n.source}`}</div>
        </div>
        <button className="btn" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/nurses'))}>← Back</button>
      </div>

      <div className="stages" aria-label="Registration progress">
        {meta.funnel.map(f => <div key={f.stage} className={n.stage_reached >= f.stage ? 'on' : ''}><i />{f.label}</div>)}
      </div>
      <div style={{ height: 14 }} />
      {n.dnc && <div className="banner dnc"><b>Do Not Contact</b> since {when(n.dnc_at)} — {n.dnc_reason}. Invites and reminders are blocked.</div>}
      {n.review_note && NEEDS_NOTE.includes(n.status) && <div className="banner warn"><b>{st.label}:</b> {n.review_note}</div>}

      <div className="grid2">
        <div>
          <ActionsPanel d={d} />
          {n.stage_reached >= 2 && <DocumentsPanel d={d} />}
          <RegistrationPanel n={n} />
        </div>
        <div>
          <ContactPanel d={d} />
          <CallLogPanel d={d} />
          {/* Re-mounted when the record changes, so the form fields start from the saved values. */}
          <BasicDetailsPanel key={'b' + n.updated_at} n={n} />
          <ConsentPanel key={'c' + n.updated_at + n.consent_sms + n.consent_whatsapp} n={n} />
          <NotePanel n={n} />
          <HistoryPanel events={d.events} />
          <MessagesPanel messages={d.messages} />
        </div>
      </div>
    </>
  );
}
