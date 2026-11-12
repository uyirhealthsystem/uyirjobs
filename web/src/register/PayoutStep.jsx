import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useToast } from '../components/Toast.jsx';

// Bank / payment details (only after verification).
export function PayoutStep({ reg, d, refresh, onDone, onCancel }) {
  const p = d.payout;
  const toast = useToast();
  const [f, setF] = useState({ account_holder: p.holder ?? '', account_number: '', account_number_confirm: '', ifsc: p.ifsc ?? '', upi: p.upi ?? '' });
  const save = useMutation({ mutationFn: () => reg.post('/payout', f), onSuccess: () => { toast('Payment details saved'); onDone(); refresh(); } });
  const set = k => e => setF(x => ({ ...x, [k]: k === 'ifsc' ? e.target.value.toUpperCase() : e.target.value }));

  return (
    <>
      <div className="step">Step 4 of 4 · Bank details</div>
      <h1>Where should we pay you?</h1>
      <p className="muted small">Your documents are verified. Add the bank account where you want to receive payments for services.
        Your account number is stored encrypted, and our staff see only the last 4 digits.</p>
      {p.on_file && <p className="small">Currently on file: a/c ••••{p.last4} · {p.ifsc}</p>}
      <form onSubmit={e => { e.preventDefault(); save.mutate(); }}>
        <label className="f"><span>Account holder name *</span><input value={f.account_holder} onChange={set('account_holder')} required autoComplete="name" /></label>
        <label className="f"><span>Account number *</span><input value={f.account_number} onChange={set('account_number')} inputMode="numeric" autoComplete="off" pattern="[\d ]{9,22}" required /></label>
        <label className="f"><span>Re-enter account number *</span><input value={f.account_number_confirm} onChange={set('account_number_confirm')} inputMode="numeric" autoComplete="off" required /></label>
        <label className="f"><span>IFSC code *</span><input value={f.ifsc} onChange={set('ifsc')} maxLength={11} pattern="[A-Za-z]{4}0[A-Za-z0-9]{6}" required /></label>
        <label className="f"><span>UPI ID (optional)</span><input value={f.upi} onChange={set('upi')} /></label>
        {save.isError && <div className="banner dnc" role="alert">{save.error.message}</div>}
        <button className="btn primary block" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save payment details'}</button>
      </form>
      {onCancel && <p><button type="button" className="linkbtn small" onClick={onCancel}>Cancel</button></p>}
    </>
  );
}
