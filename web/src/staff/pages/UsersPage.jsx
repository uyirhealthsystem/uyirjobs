import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.jsx';
import { Loading, ErrorPanel } from '../../components/Loading.jsx';
import { useAuth } from '../auth.jsx';

const EMPTY = { name: '', username: '', role: 'district_admin', district: '', password: '' };

export function UsersPage() {
  const { meta } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get('/api/users') });
  const [form, setForm] = useState(EMPTY);
  const [reset, setReset] = useState(null);   // user row whose password is being reset

  const done = msg => () => { toast(msg); qc.invalidateQueries({ queryKey: ['users'] }); };
  const create = useMutation({ mutationFn: body => api.post('/api/users', body), onSuccess: () => { setForm(EMPTY); done('Account created')(); }, onError: e => toast(e.message, true) });
  const update = useMutation({
    mutationFn: ({ id, body }) => api.patch('/api/users/' + id, body),
    onSuccess: (r, { msg }) => { setReset(null); done(msg)(); },
    onError: e => toast(e.message, true),
  });
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
              {users.data.rows.map(u => <UserRow key={`${u.id}-${u.role}-${u.district}-${u.active}`} u={u} roleOpts={roleOpts} distOpts={distOpts}
                busy={update.isPending} onUpdate={(body, msg) => update.mutate({ id: u.id, body, msg })} onReset={() => setReset(u)} />)}
            </tbody>
          </table></div>
        )}
        {reset && <ResetPassword u={reset} busy={update.isPending} onCancel={() => setReset(null)}
          onSubmit={password => update.mutate({ id: reset.id, body: { password }, msg: 'Password updated' })} />}
      </div>
    </>
  );
}

function UserRow({ u, roleOpts, distOpts, busy, onUpdate, onReset }) {
  const [role, setRole] = useState(u.role);
  const [district, setDistrict] = useState(u.district || '');
  return (
    <tr>
      <td>{u.name}</td>
      <td className="mono">{u.username}</td>
      <td><select aria-label="Role" value={role} onChange={e => setRole(e.target.value)}>{roleOpts}</select></td>
      <td><select aria-label="District" value={district} onChange={e => setDistrict(e.target.value)}>{distOpts}</select></td>
      <td>{u.active ? <span className="pill g-done">active</span> : <span className="pill">inactive</span>}</td>
      <td className="actions">
        <button className="btn sm" disabled={busy} onClick={() => onUpdate({ role, district: district || null }, 'Role updated; the user must sign in again')}>Save role</button>
        <button className="btn sm" disabled={busy} onClick={() => onUpdate({ active: !u.active }, u.active ? 'Account deactivated' : 'Account activated')}>{u.active ? 'Deactivate' : 'Activate'}</button>
        <button className="btn sm" onClick={onReset}>Reset password</button>
      </td>
    </tr>
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
