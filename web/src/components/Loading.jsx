export function Loading({ full = false, label = 'Loading…' }) {
  return (
    <div className={full ? 'loading full' : 'loading'} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

export function ErrorPanel({ error, onRetry }) {
  return (
    <div className="panel banner dnc" role="alert">
      {error?.message || 'Something went wrong'}
      {onRetry && <> <button className="btn sm" style={{ marginLeft: 8 }} onClick={onRetry}>Try again</button></>}
    </div>
  );
}
