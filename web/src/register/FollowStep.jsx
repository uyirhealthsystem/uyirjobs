import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useToast } from '../components/Toast.jsx';

// After documents are submitted: the nurse opens each of Uyir's social pages and confirms they
// follow them all, then continues. (The networks can't tell us whether they really followed, so
// we record that each page was opened and the nurse's confirmation.)
export function FollowStep({ reg, d, refresh }) {
  const toast = useToast();
  const { links } = d.social;
  const [opened, setOpened] = useState(() => new Set(d.social.opened));
  const [confirmed, setConfirmed] = useState(false);
  const allOpened = Object.keys(links).every(k => opened.has(k));
  const confirm = useMutation({ mutationFn: () => reg.post('/social/confirm'), onSuccess: refresh, onError: e => toast(e.message, true) });

  function open(k) {
    setOpened(s => new Set(s).add(k));
    // Recorded in the background; the link itself opens the page (or the app) in a new tab.
    reg.post('/social/open', { network: k }).catch(() => {});
  }

  return (
    <>
      <div className="step">Step 4 of 4 · Follow Uyir</div>
      <h1>Follow us to continue</h1>
      <p>Thank you for submitting your documents. Follow Uyir on Instagram, Facebook and YouTube: we share nursing work,
        updates and news there. Tap each button, follow us, then come back to this page.</p>
      <div className="social">
        {Object.entries(links).map(([k, s]) => (
          <a key={k} className={`btn block social-${k}${opened.has(k) ? ' done' : ''}`} href={s.url} target="_blank" rel="noopener noreferrer" onClick={() => open(k)}>
            {opened.has(k) ? '✓ ' : ''}{s.action}
          </a>
        ))}
      </div>
      <label className="chk">
        <input type="checkbox" checked={confirmed} disabled={!allOpened} onChange={e => setConfirmed(e.target.checked)} />
        <span>I have followed Uyir on Instagram, Facebook and YouTube.</span>
      </label>
      {!allOpened && <p className="small muted">Open all three pages to continue.</p>}
      <button className="btn primary block" disabled={!allOpened || !confirmed || confirm.isPending} onClick={() => confirm.mutate()}>
        {confirm.isPending ? 'Saving…' : 'Continue'}
      </button>
    </>
  );
}
