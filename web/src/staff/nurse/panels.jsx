// Panels on the nurse detail page. Every action goes through useNurseAction, which disables
// the button while the request runs (no double submits) and refreshes the page data after.
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { when, kb } from '../../lib/format.js';
import { useToast } from '../../components/Toast.jsx';
import { StatusPill, EventText } from '../../components/StatusPill.jsx';
import { useAuth, isSuper, NOT_SENT, sentBy } from '../auth.jsx';

export const NEEDS_NOTE = ['CORRECTION_REQUIRED', 'REJECTED'];
const ACTION_LABEL = { INVITED: ['Send registration link', 'primary'], VERIFIED: ['Mark verified', 'primary'], CORRECTION_REQUIRED: ['Ask for correction', ''], REJECTED: ['Reject', 'danger'] };
const REMINDERS = { REGISTERED: ['DOC_REMIND', 'Send document reminder'], CORRECTION_REQUIRED: ['CORRECTION', 'Resend correction notice'] };
const WAITING = {
  REGISTERED: 'Waiting for the nurse to upload documents.', CORRECTION_REQUIRED: 'Waiting for the nurse to re-upload corrected documents.',
  VERIFIED: 'Verified. The nurse can add bank details through their link.', REJECTED: 'Registration rejected.',
};

/** POST/PATCH to /api/nurses/:id/<path>, then refresh this nurse, the list and the overview. */
function useNurseAction(nurseId, { onSuccess } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ path = '', body, method = 'post' }) => api[method](`/api/nurses/${encodeURIComponent(nurseId)}${path}`, body),
    onSuccess: (data, vars) => {
      onSuccess?.(data, vars);
      qc.invalidateQueries({ queryKey: ['nurse', nurseId] });
      qc.invalidateQueries({ queryKey: ['nurses'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: e => toast(e.message, true),
  });
}

function InlineForm({ label, placeholder, required = true, multiline = true, submitLabel = 'Confirm', pending, onSubmit, onCancel }) {
  const [value, setValue] = useState('');
  const Input = multiline ? 'textarea' : 'input';
  return (
    <form className="inline-form" onSubmit={e => { e.preventDefault(); onSubmit(value.trim()); }}>
      <div style={{ marginBottom: 6 }}>{label}</div>
      <Input value={value} onChange={e => setValue(e.target.value)} placeholder={placeholder} required={required} autoFocus style={multiline ? undefined : { width: '100%' }} />
      <div className="actions" style={{ marginTop: 6 }}>
        <button className="btn primary" disabled={pending}>{pending ? 'Saving…' : submitLabel}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function ActionsPanel({ d }) {
  const { meta } = useAuth();
  const toast = useToast();
  const n = d.nurse;
  const [pendingTo, setPendingTo] = useState(null);
  const act = useNurseAction(n.id, {
    onSuccess: (r, { body }) => {
      setPendingTo(null);
      if (body?.template) return toast('Reminder sent by ' + r.sent.join(' + '));
      if (body.to === 'INVITED' && !r.notified.length) toast(NOT_SENT, true);
      else toast(`Now: ${meta.statuses[r.status].label}${body.to === 'INVITED' ? ` (${sentBy(r.notified)})` : ''}`);
    },
  });
  const actions = d.allowed.map(s => (s === 'INVITED' && n.status === 'INVITED' ? ['INVITED', 'Resend registration link', ''] : [s, ...ACTION_LABEL[s]]));
  const run = to => (NEEDS_NOTE.includes(to) ? setPendingTo(to) : act.mutate({ path: '/transition', body: { to } }));

  return (
    <div className="panel">
      <h2>Actions</h2>
      {actions.length ? (
        <div className="actions">
          {actions.map(([s, label, cls]) => (
            <button key={s} className={`btn ${cls}`} disabled={act.isPending || (s === 'INVITED' && n.dnc)} onClick={() => run(s)}>{label}</button>
          ))}
        </div>
      ) : <div className="muted">{WAITING[n.status] || 'No actions right now.'}</div>}
      {n.status === 'SUBMITTED' && <div className="small muted" style={{ marginTop: 8 }}>Review each document below first. “Mark verified” needs every required document verified.</div>}
      {pendingTo && (
        <InlineForm
          label={<><StatusPill status={pendingTo} /> — <b>reason required</b>, the nurse sees it when they open their registration link</>}
          placeholder="Reason" pending={act.isPending}
          onSubmit={note => act.mutate({ path: '/transition', body: { to: pendingTo, note } })}
          onCancel={() => setPendingTo(null)}
        />
      )}
      {REMINDERS[n.status] && (
        <div style={{ marginTop: 12 }}>
          <button className="btn" disabled={n.dnc || act.isPending} onClick={() => act.mutate({ path: '/message', body: { template: REMINDERS[n.status][0] } })}>
            {REMINDERS[n.status][1]}
          </button>
        </div>
      )}
      {n.whatsapp_connected_at && (
        <div className="small" style={{ marginTop: 12 }}>
          WhatsApp: <b>connected</b> {when(n.whatsapp_connected_at)} from <span className="mono">+{n.whatsapp_number}</span>
        </div>
      )}
      {n.registration_url && (
        <div className="small muted" style={{ marginTop: 6 }}>
          Registration link: <a href={n.registration_url} target="_blank" rel="noopener noreferrer">{n.registration_url}</a>
        </div>
      )}
    </div>
  );
}

export function DocumentsPanel({ d }) {
  const { meta } = useAuth();
  const toast = useToast();
  const n = d.nurse;
  const canReview = n.status === 'SUBMITTED';
  const docs = d.documents.filter(x => x.status !== 'SUPERSEDED');
  const [review, setReview] = useState(null);   // { id, status }
  const act = useNurseAction(n.id, {
    onSuccess: (r, { body }) => {
      setReview(null);
      toast(body.status === 'VERIFIED' ? 'Document verified' : 'Review saved. Use “Ask for correction” or “Reject” above to notify the nurse.');
    },
  });
  const save = (docId, status, note) => act.mutate({ path: `/documents/${docId}/review`, body: { status, note } });

  return (
    <div className="panel">
      <h2>Documents</h2>
      {d.missingDocs.length > 0 && <div className="banner warn">Missing: {d.missingDocs.map(m => meta.docTypes[m].label).join(', ')}</div>}
      {docs.length ? docs.map(doc => (
        <div className="doc" key={doc.id}>
          <div>
            <b>{meta.docTypes[doc.type]?.label || doc.type}</b> <span className={`pill d-${doc.status}`}>{doc.status.toLowerCase()}</span>
            <div className="small muted">{doc.filename} · {kb(doc.size)} · {when(doc.uploaded_at)}{doc.reviewer && ` · reviewed by ${doc.reviewer}`}</div>
            {doc.note && <div className="small">{doc.note}</div>}
          </div>
          <div className="actions">
            <a className="btn sm" href={`/api/documents/${doc.id}/file`} target="_blank" rel="noopener noreferrer">View</a>
            {canReview && doc.status === 'SUBMITTED' && <>
              <button className="btn sm" disabled={act.isPending} onClick={() => save(doc.id, 'VERIFIED')}>Verify</button>
              <button className="btn sm" disabled={act.isPending} onClick={() => setReview({ id: doc.id, status: 'CORRECTION' })}>Needs correction</button>
              <button className="btn sm danger" disabled={act.isPending} onClick={() => setReview({ id: doc.id, status: 'REJECTED' })}>Reject</button>
            </>}
          </div>
        </div>
      )) : <div className="muted">No documents uploaded yet.</div>}
      {review && (
        <InlineForm
          key={review.id + review.status}
          label={review.status === 'CORRECTION' ? 'Mark as needing correction' : 'Reject document'}
          placeholder="What needs to change? (sent to the nurse)" submitLabel="Save review" pending={act.isPending}
          onSubmit={note => save(review.id, review.status, note)} onCancel={() => setReview(null)}
        />
      )}
    </div>
  );
}

// Registration-form fields; staff can correct them (bank details stay nurse-only). Every edit is in the history.
const EDIT_FIELDS = [
  ['email', 'Email'], ['address', 'Address'], ['taluk', 'Taluk'], ['block', 'Block'], ['qualification', 'Qualification'],
  ['council_reg_no', 'Council reg. no.'], ['current_employment', 'Current employment'], ['experience_years', 'Experience (yrs)'],
  ['work_preference', 'Work preference'], ['preferred_locations', 'Preferred locations'], ['service_interests', 'Service interests'],
];

export function RegistrationPanel({ n }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => Object.fromEntries(EDIT_FIELDS.map(([k]) => [k, n[k] ?? ''])));
  const act = useNurseAction(n.id, { onSuccess: () => { setEditing(false); toast('Saved'); } });
  const reg = [['Email', n.email], ['Address', n.address], ['Taluk / Block', [n.taluk, n.block].filter(Boolean).join(' / ')], ['Qualification', n.qualification],
    ['Council reg. no.', n.council_reg_no], ['Current employment', n.current_employment], ['Experience (yrs)', n.experience_years], ['Work preference', n.work_preference],
    ['Preferred locations', n.preferred_locations], ['Service interests', n.service_interests], ['Mobile verified', when(n.mobile_verified_at)], ['Registered', when(n.registered_at)],
    ['Bank details', n.payout_added_at
      ? `${n.payout_account_holder} · a/c ••••${n.payout_account_last4} · ${n.payout_ifsc}${n.payout_upi ? ' · UPI ' + n.payout_upi : ''}`
      : n.status === 'VERIFIED' ? 'Pending — nurse adds these through their link' : '—'],
    ['Follows Uyir (Instagram, Facebook, YouTube)', n.social_followed_at
      ? `Confirmed ${when(n.social_followed_at)}`
      : n.social_opened?.length ? `Opened: ${n.social_opened.join(', ')} (not confirmed yet)` : '—']];
  const filled = n.registered_at || EDIT_FIELDS.some(([k]) => n[k] != null && n[k] !== '');
  return (
    <div className="panel">
      <h2>Registration details {!editing && <button className="btn sm" style={{ float: 'right' }} onClick={() => setEditing(true)}>Edit</button>}</h2>
      {editing ? (
        <form onSubmit={e => { e.preventDefault(); act.mutate({ method: 'patch', body: form }); }}>
          {EDIT_FIELDS.map(([k, label]) => (
            <label key={k} className="f"><span>{label}</span>
              {k === 'experience_years'
                ? <input type="number" min="0" max="60" step="0.5" value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
                : <input type={k === 'email' ? 'email' : 'text'} value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} maxLength={1000} />}
            </label>
          ))}
          <div className="small muted" style={{ margin: '6px 0' }}>Bank details can only be entered by the nurse. Changes are recorded in the history.</div>
          <div className="actions">
            <button className="btn primary" disabled={act.isPending}>{act.isPending ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      ) : filled
        ? <dl className="kv">{reg.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v === 0 ? 0 : v || '—'}</dd></div>)}</dl>
        : <div className="muted">The nurse has not filled in the registration form yet.</div>}
    </div>
  );
}

/** Super Admin: delete the record (personal data and documents erased; the ID and history stay). */
export function DeletePanel({ n }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const act = useNurseAction(n.id, {
    onSuccess: r => {
      setOpen(false);
      toast(r.files_pending ? 'Record deleted, but the documents could not be erased yet. Press Delete again to retry.' : 'Record deleted', !!r.files_pending);
    },
  });
  const deleted = !!n.deleted_at;
  return (
    <div className="panel">
      <h2>{deleted ? 'Retry erasing documents' : 'Delete record'}</h2>
      {!open ? (
        <>
          <div className="small muted" style={{ marginBottom: 6 }}>
            {deleted
              ? 'Only needed if erasing the documents failed when the record was deleted (shown in the history).'
              : 'Erases the personal details, registration answers, bank details, messages and uploaded documents of this nurse. The nurse ID and an entry saying who deleted it and why are kept. This cannot be undone.'}
          </div>
          <button className="btn sm danger" onClick={() => setOpen(true)}>{deleted ? 'Erase documents again…' : 'Delete this record…'}</button>
        </>
      ) : (
        <form className="inline-form" onSubmit={e => { e.preventDefault(); act.mutate({ path: '/delete', body: { reason: reason || n.deletion_reason, confirm } }); }}>
          {!deleted && (
            <label className="f"><span>Reason *</span>
              <input type="text" value={reason} onChange={e => setReason(e.target.value)} required maxLength={500} placeholder="e.g. Nurse asked for their data to be deleted (call on 13 Nov)" autoFocus />
            </label>
          )}
          <label className="f"><span>Type <b className="mono">{n.id}</b> to confirm *</span>
            <input type="text" value={confirm} onChange={e => setConfirm(e.target.value)} required autoComplete="off" />
          </label>
          <div className="actions">
            <button className="btn danger" disabled={act.isPending || confirm.trim().toUpperCase() !== n.id}>{act.isPending ? 'Working…' : deleted ? 'Erase documents' : 'Delete permanently'}</button>
            <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

export function ContactPanel({ d }) {
  const toast = useToast();
  const qc = useQueryClient();
  const n = d.nurse, c = d.contact;
  // Log the tap (keepalive, so it survives the switch to the phone app), then let the link open the dialer / SMS app.
  const logContact = channel => {
    fetch(`/api/nurses/${encodeURIComponent(n.id)}/contact`, {
      method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel }),
    }).catch(() => {}).finally(() => setTimeout(() => qc.invalidateQueries({ queryKey: ['nurse', n.id] }), 1000));
  };
  return (
    <div className="panel">
      <h2>Contact</h2>
      <div className="actions">
        {c.tel
          ? <a className="btn primary" href={c.tel} onClick={() => { logContact('call'); toast('After the call, choose its status under “Call log”.'); document.getElementById('call-outcome')?.focus(); }}>📞 Call {n.mobile}</a>
          : <button className="btn" disabled title={c.blocked}>📞 Call</button>}
        {c.sms
          ? <a className="btn" href={c.sms} onClick={() => logContact('sms')}>💬 SMS WhatsApp link</a>
          : <button className="btn" disabled title={c.sms_blocked}>💬 SMS</button>}
      </div>
      <div className="small muted" style={{ marginTop: 6 }}>
        {c.blocked ? `Calls and SMS are blocked: ${c.blocked}.`
          : 'Opens your phone’s dialer / SMS app.' + (c.sms_blocked ? ` SMS unavailable: ${c.sms_blocked}.` : ' The SMS contains our WhatsApp chat link with the nurse’s code; when they message us they get their registration link on WhatsApp. Sending it marks the nurse as Invited.')}
      </div>
    </div>
  );
}

export function CallLogPanel({ d }) {
  const { meta } = useAuth();
  const toast = useToast();
  const n = d.nurse;
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const act = useNurseAction(n.id, { onSuccess: () => { setOutcome(''); setNote(''); toast('Call logged'); } });
  const calls = d.events.filter(e => e.type === 'call');
  return (
    <div className="panel">
      <h2>Call log</h2>
      <form onSubmit={e => { e.preventDefault(); act.mutate({ path: '/call-log', body: { outcome, note } }); }}>
        <div className="toolbar" style={{ marginBottom: 6 }}>
          <select id="call-outcome" aria-label="Call status" value={outcome} onChange={e => setOutcome(e.target.value)} required>
            <option value="">Call status…</option>
            {Object.entries(meta.callOutcomes).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <button className="btn" disabled={act.isPending}>Log call</button>
        </div>
        <textarea aria-label="Call notes" value={note} onChange={e => setNote(e.target.value)} placeholder="What was discussed? (optional, internal)" />
      </form>
      {calls.length
        ? <ul className="timeline" style={{ marginTop: 10 }}>{calls.map(e => <li key={e.id} className="t-call"><div>{e.note}</div><div className="when">{when(e.at)} · {e.actor}</div></li>)}</ul>
        : <div className="muted small" style={{ marginTop: 8 }}>No calls logged yet.</div>}
    </div>
  );
}

export function BasicDetailsPanel({ n }) {
  const { user, meta } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ name: n.name, mobile: n.mobile, district: n.district || '', source: n.source || '' });
  const act = useNurseAction(n.id, { onSuccess: () => toast('Saved') });
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const body = isSuper(user) ? form : { name: form.name, mobile: form.mobile, source: form.source };
  return (
    <div className="panel">
      <h2>Basic details</h2>
      <form className="toolbar" onSubmit={e => { e.preventDefault(); act.mutate({ method: 'patch', body }); }}>
        <input type="text" aria-label="Name" value={form.name} onChange={set('name')} placeholder="Name" />
        <input type="tel" aria-label="Mobile" value={form.mobile} onChange={set('mobile')} placeholder="Mobile" />
        {isSuper(user) && (
          <select aria-label="District" title="Move to another district" value={form.district} onChange={set('district')}>
            {!n.district && <option value="">No district yet</option>}{meta.districts.map(x => <option key={x}>{x}</option>)}
          </select>
        )}
        <input type="text" aria-label="Source" value={form.source} onChange={set('source')} placeholder="Source" />
        <button className="btn" disabled={act.isPending}>Save</button>
      </form>
      {isSuper(user) && <div className="small muted">Changing the district moves this nurse to that District Admin.</div>}
    </div>
  );
}

export function ConsentPanel({ n }) {
  const toast = useToast();
  const [sms, setSms] = useState(n.consent_sms);
  const [wa, setWa] = useState(n.consent_whatsapp);
  const [dncTo, setDncTo] = useState(null);   // true = mark DNC, false = lift it
  const act = useNurseAction(n.id, { onSuccess: () => { setDncTo(null); toast('Saved'); } });
  return (
    <div className="panel">
      <h2>Consent</h2>
      <form onSubmit={e => { e.preventDefault(); act.mutate({ path: '/consent', body: { consent_sms: sms, consent_whatsapp: wa } }); }}>
        <label><input type="checkbox" checked={sms} onChange={e => setSms(e.target.checked)} /> SMS invite</label><br />
        <label><input type="checkbox" checked={wa} onChange={e => setWa(e.target.checked)} /> WhatsApp updates <span className="small muted">(set automatically when the nurse messages us)</span></label>
        <div className="small muted" style={{ margin: '6px 0' }}>
          Data-processing consent: {n.consent_data_processing_at ? 'given ' + when(n.consent_data_processing_at) : 'not yet (given in the registration form)'}
        </div>
        <div className="actions">
          <button className="btn sm" disabled={act.isPending}>Save</button>
          {n.dnc
            ? <button type="button" className="btn sm" onClick={() => setDncTo(false)}>Lift Do Not Contact…</button>
            : <button type="button" className="btn sm danger" onClick={() => setDncTo(true)}>Mark Do Not Contact…</button>}
        </div>
      </form>
      {dncTo !== null && (
        <InlineForm
          key={String(dncTo)} multiline={false} pending={act.isPending}
          label={dncTo ? 'Reason for Do Not Contact' : 'How was fresh consent obtained?'}
          placeholder={dncTo ? 'e.g. Asked not to be contacted' : 'e.g. Nurse called the helpline on 9 Nov and asked to register'}
          onSubmit={reason => act.mutate({ path: '/consent', body: { dnc: dncTo, reason } })} onCancel={() => setDncTo(null)}
        />
      )}
    </div>
  );
}

export function NotePanel({ n }) {
  const toast = useToast();
  const ref = useRef();
  const act = useNurseAction(n.id, { onSuccess: () => { ref.current.value = ''; toast('Note added'); } });
  return (
    <div className="panel">
      <h2>Add a note</h2>
      <form onSubmit={e => { e.preventDefault(); act.mutate({ path: '/note', body: { note: ref.current.value } }); }}>
        <textarea ref={ref} aria-label="Note" placeholder="Internal note (not sent to the nurse)" required />
        <div className="actions" style={{ marginTop: 6 }}><button className="btn" disabled={act.isPending}>Add note</button></div>
      </form>
    </div>
  );
}

export function HistoryPanel({ events }) {
  return (
    <div className="panel">
      <h2>History</h2>
      <ul className="timeline">
        {events.map(e => <li key={e.id} className={`t-${e.type}`}><div><EventText e={e} /></div><div className="when">{when(e.at)} · {e.actor}</div></li>)}
      </ul>
    </div>
  );
}

export function MessagesPanel({ messages }) {
  return (
    <div className="panel">
      <h2>Messages sent</h2>
      {messages.length ? messages.map(m => (
        <div className="doc" key={m.id}>
          <div>
            <span className={`pill ch-${m.channel}`}>{m.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}</span> <b>{m.template}</b>{' '}
            <span className={`pill m-${m.status}`}>{m.status}</span> <span className="small muted">{when(m.created_at)}</span>
            {m.error && <div className="small" style={{ color: 'var(--danger)' }}>{m.error}</div>}
            <div className="small">{m.body}</div>
          </div>
        </div>
      )) : <div className="muted">None</div>}
    </div>
  );
}
