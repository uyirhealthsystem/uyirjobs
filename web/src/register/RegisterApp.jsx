// Nurse registration portal (https://uyirjobs.in/register?t=…), mobile-first:
// 1 verify mobile (OTP on WhatsApp) → 2 details & consent → 3 documents → staff review → 4 bank details.
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { regApi } from '../lib/api.js';
import { Loading } from '../components/Loading.jsx';
import { OtpStep } from './OtpStep.jsx';
import { DetailsStep } from './DetailsStep.jsx';
import { DocumentsStep } from './DocumentsStep.jsx';
import { PayoutStep } from './PayoutStep.jsx';
import { DoneStep } from './DoneStep.jsx';

const storageKey = t => 'reg:' + t;
const readSession = t => { try { return sessionStorage.getItem(storageKey(t)) || null; } catch { return null; } };
const writeSession = (t, v) => { try { v ? sessionStorage.setItem(storageKey(t), v) : sessionStorage.removeItem(storageKey(t)); } catch { /* private mode */ } };

export default function RegisterApp() {
  const [params] = useSearchParams();
  const t = params.get('t') || '';
  const [session, setSessionState] = useState(() => readSession(t));
  const [editing, setEditing] = useState(false);
  const [editingPayout, setEditingPayout] = useState(false);
  const qc = useQueryClient();

  const setSession = useCallback(v => { writeSession(t, v); setSessionState(v); }, [t]);
  // Any 401 means the 2-hour session ended: drop it so the nurse verifies their mobile again.
  const reg = useMemo(() => {
    const base = regApi(t, () => session);
    const wrap = fn => async (...args) => {
      try { return await fn(...args); } catch (e) { if (e.status === 401 && session) setSession(null); throw e; }
    };
    return { get: wrap(base.get), post: wrap(base.post) };
  }, [t, session, setSession]);

  const info = useQuery({ queryKey: ['reg', t, 'info'], queryFn: () => reg.get(''), enabled: !!t, retry: false });
  const form = useQuery({
    queryKey: ['reg', t, 'form', session],
    queryFn: () => reg.get('/form'),
    enabled: !!t && !!session && info.isSuccess,
    retry: false,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['reg', t, 'form'] });
  const ctx = { t, reg, info: info.data, refresh, setSession };

  let body;
  if (!t || info.isError) {
    body = <><h2>Link not available</h2><p className="muted">{info.error?.message || 'This registration link is invalid or has expired.'}</p></>;
  } else if (info.isPending) {
    body = <Loading />;
  } else if (!session) {
    body = <OtpStep {...ctx} />;
  } else if (form.isPending) {
    body = <Loading />;
  } else if (form.isError) {
    body = <><p className="banner dnc">{form.error.message}</p><button className="btn" onClick={() => form.refetch()}>Try again</button></>;
  } else {
    const d = form.data, n = d.nurse;
    if (n.status === 'INVITED' || editing) body = <DetailsStep {...ctx} d={d} onDone={() => setEditing(false)} />;
    else if (['REGISTERED', 'CORRECTION_REQUIRED'].includes(n.status)) body = <DocumentsStep {...ctx} d={d} onEdit={() => setEditing(true)} />;
    else if (d.payout.needed && (!d.payout.on_file || editingPayout)) body = <PayoutStep {...ctx} d={d} onDone={() => setEditingPayout(false)} onCancel={d.payout.on_file ? () => setEditingPayout(false) : null} />;
    else body = <DoneStep d={d} onEditPayout={() => setEditingPayout(true)} />;
  }

  return (
    <div className="reg">
      <div className="wrap">
        <div className="brand">Uyir · Nurse Registration</div>
        <div className="panel">{body}</div>
      </div>
    </div>
  );
}
