import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';

export function Login() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ username: '', password: '' });
  const login = useMutation({
    mutationFn: body => api.post('/api/login', body, { scope: 'login' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <div className="login panel">
      <h1>Uyir Nurse Registration</h1>
      <p className="muted">Staff sign-in (District Admin / Super Admin).</p>
      <form onSubmit={e => { e.preventDefault(); login.mutate(form); }}>
        <label className="f"><span>Username</span>
          <input type="text" value={form.username} onChange={set('username')} autoComplete="username" required autoFocus />
        </label>
        <label className="f"><span>Password</span>
          <input type="password" value={form.password} onChange={set('password')} autoComplete="current-password" required />
        </label>
        {login.isError && <div className="banner dnc" role="alert">{login.error.message}</div>}
        <button className="btn primary" style={{ width: '100%' }} disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
