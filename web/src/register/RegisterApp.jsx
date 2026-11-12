// Nurse registration portal (https://uyirjobs.in/register?t=…), mobile-first. The personal link
// (sent by SMS from staff) opens directly, with no OTP:
// welcome (who we are) → 1 details & consent → 2 documents → staff review → 3 bank details.
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { regApi } from '../lib/api.js';
import { Loading } from '../components/Loading.jsx';
import { DetailsStep } from './DetailsStep.jsx';
import { DocumentsStep } from './DocumentsStep.jsx';
import { PayoutStep } from './PayoutStep.jsx';
import { DoneStep } from './DoneStep.jsx';
import { WelcomeStep } from './WelcomeStep.jsx';

export default function RegisterApp() {
  const [params] = useSearchParams();
  const t = params.get('t') || '';
  const [editing, setEditing] = useState(false);
  const [editingPayout, setEditingPayout] = useState(false);
  const [started, setStarted] = useState(false);   // past the welcome screen (shown before registering)
  const qc = useQueryClient();
  const reg = useMemo(() => regApi(t), [t]);

  const info = useQuery({ queryKey: ['reg', t, 'info'], queryFn: () => reg.get(''), enabled: !!t, retry: false });
  const form = useQuery({
    queryKey: ['reg', t, 'form'],
    queryFn: () => reg.get('/form'),
    enabled: !!t && info.isSuccess,
    retry: false,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['reg', t, 'form'] });
  const ctx = { t, reg, info: info.data, refresh };

  let body;
  if (!t || info.isError) {
    body = <><h2>Link not available</h2><p className="muted">{info.error?.message || 'This registration link is invalid or has expired.'}</p></>;
  } else if (info.isPending || form.isPending) {
    body = <Loading />;
  } else if (form.isError) {
    body = <><p className="banner dnc">{form.error.message}</p><button className="btn" onClick={() => form.refetch()}>Try again</button></>;
  } else {
    const d = form.data, n = d.nurse;
    if (n.status === 'INVITED' && !started) body = <WelcomeStep info={info.data} onStart={() => { setStarted(true); window.scrollTo(0, 0); }} />;
    else if (n.status === 'INVITED' || editing) body = <DetailsStep {...ctx} d={d} onDone={() => setEditing(false)} />;
    else if (['REGISTERED', 'CORRECTION_REQUIRED'].includes(n.status)) body = <DocumentsStep {...ctx} d={d} onEdit={() => setEditing(true)} />;
    else if (d.payout.needed && (!d.payout.on_file || editingPayout)) body = <PayoutStep {...ctx} d={d} onDone={() => setEditingPayout(false)} onCancel={d.payout.on_file ? () => setEditingPayout(false) : null} />;
    else body = <DoneStep d={d} onEditPayout={() => setEditingPayout(true)} />;
  }

  return (
    <div className="reg">
      <div className="wrap">
        <div className="brand">Uyir Health App · Nurse Registration</div>
        <div className="panel">{body}</div>
      </div>
    </div>
  );
}
