import { useAuth } from '../staff/auth.jsx';

export function StatusPill({ status }) {
  const { meta } = useAuth();
  const s = meta.statuses[status];
  return <span className={`pill g-${s?.group || 'old'} s-${status}`}>{s?.label || status}</span>;
}

export function EventText({ e }) {
  if (e.type === 'status') {
    return (
      <>
        {e.from_status && <><StatusPill status={e.from_status} /> → </>}
        <StatusPill status={e.to_status} />
        {e.note && <span className="muted"> {e.note}</span>}
      </>
    );
  }
  if (e.type === 'call') return <><b>📞 call</b> {e.note}</>;
  return <><b>{e.type}</b> {e.note}</>;
}
