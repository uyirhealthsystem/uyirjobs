import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';

export function OtpStep({ reg, info, setSession }) {
  const [sent, setSent] = useState(null);
  const [otp, setOtp] = useState('');
  const send = useMutation({ mutationFn: () => reg.post('/otp'), onSuccess: r => { setSent(r); setOtp(''); } });
  const verify = useMutation({ mutationFn: () => reg.post('/verify', { otp }), onSuccess: r => setSession(r.session) });
  const error = verify.error || send.error;

  return (
    <>
      <div className="step">Step 1 of 4 · Verify your mobile</div>
      <h1>Vanakkam {info.first_name}</h1>
      <p className="muted">We will send a 6-digit code to your <b>WhatsApp</b> (<b className="mono">{info.masked_mobile}</b>).</p>
      {error && <div className="banner dnc" role="alert">{error.message}</div>}
      {sent ? (
        <>
          <form onSubmit={e => { e.preventDefault(); verify.mutate(); }}>
            <input className="otp" aria-label="6-digit code" value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus />
            {sent.dev_otp && <p className="small muted">Development mode — code: <b className="mono">{sent.dev_otp}</b></p>}
            <button className="btn primary block" disabled={verify.isPending || otp.length !== 6}>{verify.isPending ? 'Checking…' : 'Verify'}</button>
          </form>
          <p><button type="button" className="linkbtn small" disabled={send.isPending} onClick={() => send.mutate()}>Send a new code</button></p>
        </>
      ) : (
        <button className="btn primary block" disabled={send.isPending} onClick={() => send.mutate()}>{send.isPending ? 'Sending…' : 'Send code'}</button>
      )}
    </>
  );
}
