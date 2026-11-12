import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { fmt } from '../../lib/format.js';
import { useToast } from '../../components/Toast.jsx';
import { useAuth, isSuper } from '../auth.jsx';

const MAX_BYTES = 25 * 1024 * 1024;

export function ImportPage() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const [source, setSource] = useState('');
  const [result, setResult] = useState(null);   // { r, done }
  const run = useMutation({
    mutationFn: dryRun => api.post('/api/import', { csv, default_source: source, dry_run: dryRun }),
    onSuccess: (r, dryRun) => {
      setResult({ r, done: !dryRun });
      if (!dryRun) { qc.invalidateQueries({ queryKey: ['nurses'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); }
    },
    onError: e => toast(e.message, true),
  });

  async function pick(e) {
    const file = e.target.files[0];
    setResult(null);
    if (!file) return setCsv('');
    if (file.size > MAX_BYTES) { e.target.value = ''; setCsv(''); return toast('File is too large (25 MB max). Split it into smaller files.', true); }
    setCsv(await file.text());
  }

  const r = result?.r;
  return (
    <>
      <div className="pagehead"><div><h1>Import nurses</h1><div className="muted">Add many nurses at once from a CSV file. They start as “Not Invited”; send links from the nurse list.</div></div></div>
      <div className="panel">
        <p>CSV with a header row. Required: <b>Name</b>, <b>Mobile</b>{isSuper(user) && <>, <b>District</b></>}. Optional:{' '}
          {!isSuper(user) && <><b>District</b> (must be {user.district}), </>}<b>Nurse ID</b> (UYIR-NUR-000001 format; generated if blank), <b>Source</b>, <b>WhatsApp consent</b> (yes / no).</p>
        <p className="small muted">Mobiles are normalised to 10 digits (+91 / spaces removed). Duplicate mobiles and unknown districts are reported and skipped. Common spellings (Trichy, Tuticorin, Kanyakumari…) are recognised.{!isSuper(user) && ' Rows for other districts are skipped.'}</p>
        <div className="toolbar">
          <input type="file" aria-label="CSV file" accept=".csv,text/csv" onChange={pick} />
          <input type="text" aria-label="Default source" placeholder="Default source (e.g. Council list 2026)" style={{ width: 280 }} value={source} onChange={e => setSource(e.target.value)} />
          <button className="btn" disabled={!csv || run.isPending} onClick={() => run.mutate(true)}>Validate</button>
          <button className="btn primary" disabled={!csv || run.isPending || result?.done || !r?.valid} onClick={() => run.mutate(false)}>
            {run.isPending && run.variables === false ? 'Importing…' : 'Import'}
          </button>
        </div>
        {r && (
          <>
            <div className={`banner ${r.errorCount ? 'warn' : 'info'}`}>
              {result.done ? <>Imported <b>{fmt(r.inserted)}</b> nurses.</> : <><b>{fmt(r.valid)}</b> rows ready to import.</>}{' '}
              {r.errorCount > 0 && `${fmt(r.errorCount)} row(s) skipped.`}
            </div>
            {r.errors.length > 0 && (
              <>
                <div className="tablewrap"><table>
                  <thead><tr><th>Line</th><th>Problem</th></tr></thead>
                  <tbody>{r.errors.map(x => <tr key={x.line}><td>{x.line}</td><td>{x.reason}</td></tr>)}</tbody>
                </table></div>
                {r.errorCount > r.errors.length && <div className="muted small">Showing first {r.errors.length}.</div>}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
