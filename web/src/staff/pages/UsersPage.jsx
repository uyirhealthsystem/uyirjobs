import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.jsx';
import { Loading, ErrorPanel } from '../../components/Loading.jsx';
import { useAuth } from '../auth.jsx';

const EMPTY = { name: '', username: '', role: 'district_admin', district: '', password: '' };

export function UsersPage() {
  const { meta, user: me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get('/api/users') });
  const [form, setForm] = useState(EMPTY);
  const [reset, setReset] = useState(null);       // user row whose password is being reset
  const [editing, setEditing] = useState(null);   // user row being edited
  const [deleting, setDeleting] = useState(null); // user row awaiting delete confirmation

  const closeAll = () => { setReset(null); setEditing(null); setDeleting(null); };
  const open = (setter, u) => { closeAll(); setter(u); };
  const done = msg => () => { toast(msg); qc.invalidateQueries({ queryKey: ['users'] }); };
  const create = useMutation({ mutationFn: body => api.post('/api/users', body), onSuccess: () => { setForm(EMPTY); done('Account created')(); }, onError: e => toast(e.message, true) });
  const update = useMutation({
    mutationFn: ({ id, body }) => api.patch('/api/users/' + id, body),
    onSuccess: (r, { msg }) => { closeAll(); done(msg)(); },
    onError: e => toast(e.message, true),
  });
  const remove = useMutation({
    mutationFn: id => api.del('/api/users/' + id),
    onSuccess: () => { closeAll(); done('Account deleted')(); },
    onError: e => toast(e.message, true),
  });
  const busy = update.isPending || remove.isPending;
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const roleOpts = Object.entries(meta.roles).map(([k, r]) => <option key={k} value={k}>{r.label}</option>);
  const distOpts = [<option key="" value="">— none (Super Admin) —</option>, ...meta.districts.map(x => <option key={x}>{x}</option>)];

  return (
    <>
      <div className="pagehead"><div><h1>Staff accounts</h1><div className="muted">One account per District Admin; each sees only their district.</div></div></div>
      <div className="grid2">
        <div className="panel">
          <h2>Add staff account</h2>
          <form onSubmit={e => { e.preventDefault(); create.mutate({ ...form, district: form.district || null }); }}>
            <label className="f"><span>Full name</span><input type="text" value={form.name} onChange={set('name')} required /></label>
            <label className="f"><span>Username</span><input type="text" value={form.username} onChange={set('username')} required pattern="[a-zA-Z0-9._\-]{3,32}" /></label>
            <label className="f"><span>Role</span><select value={form.role} onChange={set('role')}>{roleOpts}</select></label>
            <label className="f"><span>District (required for District Admin)</span><select value={form.district} onChange={set('district')}>{distOpts}</select></label>
            <label className="f"><span>Initial password (min 8 chars)</span><input type="password" value={form.password} onChange={set('password')} minLength={8} required autoComplete="new-password" /></label>
            <button className="btn primary" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create'}</button>
          </form>
        </div>
        <div className="panel">
          <h2>Roles</h2>
          <dl className="kv">{Object.values(meta.roles).map(r => <div key={r.label} style={{ display: 'contents' }}><dt>{r.label}</dt><dd>{r.hint}</dd></div>)}</dl>
        </div>
      </div>

      <div className="panel">
        {users.isPending ? <Loading /> : users.isError ? <ErrorPanel error={users.error} onRetry={users.refetch} /> : (
          <div className="tablewrap"><table>
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>District</th><th>Status</th><th /></tr></thead>
            <tbody>
              {users.data.rows.map(u => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td className="mono">{u.username}</td>
                  <td>{meta.roles[u.role]?.label || u.role}</td>
                  <td>{u.district || '—'}</td>
                  <td>{u.active ? <span className="pill g-done">active</span> : <span className="pill">inactive</span>}</td>
                  <td className="actions">
                    <button className="btn sm" onClick={() => open(setEditing, u)}>Edit</button>
                    {u.id !== me.id && <button className="btn sm" disabled={busy} onClick={() => update.mutate({ id: u.id, body: { active: !u.active }, msg: u.active ? 'Account deactivated' : 'Account activated' })}>{u.active ? 'Deactivate' : 'Activate'}</button>}
                    <button className="btn sm" onClick={() => open(setReset, u)}>Reset password</button>
                    {u.id !== me.id && <button className="btn sm danger" onClick={() => open(setDeleting, u)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {editing && <EditUser key={editing.id} u={editing} self={editing.id === me.id} roleOpts={roleOpts} distOpts={distOpts} busy={busy} onCancel={closeAll}
          onSubmit={body => update.mutate({ id: editing.id, body, msg: 'Account updated' })} />}
        {reset && <ResetPassword u={reset} busy={busy} onCancel={closeAll}
          onSubmit={password => update.mutate({ id: reset.id, body: { password }, msg: 'Password updated' })} />}
        {deleting && (
          <div className="inline-form toolbar">
            <span>Delete <b>{deleting.name}</b> ({deleting.username})? They are signed out and can no longer log in, and their nurses become unassigned. Their past actions stay in the history.</span>
            <button className="btn danger" disabled={busy} onClick={() => remove.mutate(deleting.id)}>{remove.isPending ? 'Deleting…' : 'Delete account'}</button>
            <button type="button" className="btn" onClick={closeAll}>Cancel</button>
          </div>
        )}
      </div>
    </>
  );
}

function EditUser({ u, self, roleOpts, distOpts, busy, onSubmit, onCancel }) {
  const [f, setF] = useState({ name: u.name, username: u.username, role: u.role, district: u.district || '' });
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }));
  const accessChanged = f.role !== u.role || (f.district || null) !== (u.district || null);
  return (
    <form className="inline-form" onSubmit={e => { e.preventDefault(); onSubmit({ ...f, district: f.district || null }); }}>
      <h2>Edit {u.name}</h2>
      <div className="grid2">
        <label className="f"><span>Full name</span><input type="text" value={f.name} onChange={set('name')} required autoFocus /></label>
        <label className="f"><span>Username</span><input type="text" value={f.username} onChange={set('username')} required pattern="[a-zA-Z0-9._\-]{3,32}" /></label>
        <label className="f"><span>Role</span><select value={f.role} onChange={set('role')} disabled={self}>{roleOpts}</select></label>
        <label className="f"><span>District (required for District Admin)</span><select value={f.district} onChange={set('district')}>{distOpts}</select></label>
      </div>
      {accessChanged && <p className="muted">Changing role or district signs this user out; they must sign in again.</p>}
      <div className="toolbar">
        <button className="btn primary" disabled={busy}>Save</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ResetPassword({ u, busy, onSubmit, onCancel }) {
  const [password, setPassword] = useState('');
  return (
    <form className="inline-form toolbar" onSubmit={e => { e.preventDefault(); onSubmit(password); }}>
      <span>New password for {u.name}</span>
      <input type="password" aria-label="New password" value={password} onChange={e => setPassword(e.target.value)} minLength={8} placeholder="New password" required autoComplete="new-password" autoFocus />
      <button className="btn primary" disabled={busy}>Set</button>
      <button type="button" className="btn" onClick={onCancel}>Cancel</button>
    </form>
  );
}
