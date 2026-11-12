import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useToast } from '../components/Toast.jsx';

const MAX = 5 * 1024 * 1024;
const ACCEPT = 'application/pdf,image/jpeg,image/png';

export function DocumentsStep({ reg, info, d, refresh, onEdit }) {
  const n = d.nurse;
  const toast = useToast();
  const latest = {};
  for (const doc of d.documents) if (!latest[doc.type]) latest[doc.type] = doc;
  const submit = useMutation({ mutationFn: () => reg.post('/submit-docs'), onSuccess: refresh, onError: e => toast(e.message, true) });

  return (
    <>
      <div className="step">Step 2 of 3 · Documents</div>
      <h1>Upload your documents</h1>
      {n.status === 'CORRECTION_REQUIRED' && <div className="banner warn"><b>Correction needed:</b> {n.review_note || 'please check the notes below'}</div>}
      <p className="muted small">PDF, JPG or PNG, up to 5 MB each. Photos must be clear and fully readable.</p>
      {Object.entries(info.docTypes).map(([k, t]) => (
        <DocRow key={k} type={k} label={t.label} hint={t.hint} required={d.required.includes(k)} doc={latest[k]} reg={reg} refresh={refresh} />
      ))}
      <button className="btn primary block" style={{ marginTop: 16 }} disabled={d.missing.length > 0 || submit.isPending} onClick={() => submit.mutate()}>
        {submit.isPending ? 'Submitting…' : 'Submit for verification'}
      </button>
      {d.missing.length > 0 && <p className="small muted">Still needed: {d.missing.map(m => info.docTypes[m].label).join(', ')}</p>}
      <p><button type="button" className="linkbtn small" onClick={onEdit}>Edit my details</button></p>
    </>
  );
}

function DocRow({ type, label, hint, required, doc, reg, refresh }) {
  const toast = useToast();
  const [inputKey, setInputKey] = useState(0);
  const upload = useMutation({
    mutationFn: file => {
      const form = new FormData();
      form.append('type', type);
      form.append('file', file, file.name);
      return reg.post('/documents', form);
    },
    onSuccess: () => { toast('Uploaded'); refresh(); },
    onError: e => toast(e.message, true),
    onSettled: () => setInputKey(k => k + 1),   // clear the file input
  });
  function pick(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX) { toast('File must be under 5 MB', true); setInputKey(k => k + 1); return; }
    // Some Android pickers report no type; the server checks the file's real contents either way.
    if (file.type && !ACCEPT.split(',').includes(file.type)) { toast('Upload a PDF, JPG or PNG file', true); setInputKey(k => k + 1); return; }
    upload.mutate(file);
  }
  return (
    <div className="docrow">
      <b>{label}</b>{required ? ' *' : <span className="muted small"> ({hint || 'if applicable'})</span>}
      {doc && (
        <div className="small">
          {doc.filename} — <span className={`pill d-${doc.status}`}>{doc.status === 'SUBMITTED' ? 'uploaded' : doc.status.toLowerCase()}</span>
          {doc.note && <span className="muted"> {doc.note}</span>}
        </div>
      )}
      {(!doc || doc.status !== 'VERIFIED') && (
        <div className="upload">
          <input key={inputKey} type="file" accept={ACCEPT} aria-label={`Upload ${label}`} onChange={pick} disabled={upload.isPending} />
          {upload.isPending && <span className="small muted"> Uploading…</span>}
        </div>
      )}
    </div>
  );
}
