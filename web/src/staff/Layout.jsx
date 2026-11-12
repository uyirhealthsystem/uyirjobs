import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useToast } from '../components/Toast.jsx';
import { useAuth, isSuper } from './auth.jsx';

const QUICK = [['NEW', 'Not invited'], ['INVITED', 'Invited, not registered'], ['REGISTERED', 'Documents pending'],
  ['SUBMITTED', 'To review'], ['CORRECTION_REQUIRED', 'Awaiting correction'], ['VERIFIED', 'Verified']];

export function Layout({ children }) {
  const { user, meta } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const params = new URLSearchParams(loc.search);
  const quickStatus = loc.pathname === '/nurses' && !params.get('q') && !params.get('district') ? params.get('status') : null;
  const scopeLabel = isSuper(user) ? 'All districts' : `${user.district} district`;

  async function logout(e) {
    e.preventDefault();
    try { await api.post('/api/logout'); } catch (err) { toast(err.message, true); }
    qc.clear();
    qc.setQueryData(['me'], null);
  }
  const navClass = on => (on ? 'on' : '');

  return (
    <div className="shell">
      <aside className="side">
        <div className="logo">
          Uyir Nurse Registration<span>{scopeLabel}</span>
          <button className="menu-btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>☰</button>
        </div>
        <nav className={open ? 'open' : ''} onClick={() => setOpen(false)}>
          <NavLink to="/" end className={({ isActive }) => navClass(isActive)}>Overview</NavLink>
          <NavLink to="/nurses" end className={() => navClass(loc.pathname.startsWith('/nurses') && !quickStatus)}>All nurses</NavLink>
          <div className="sec">By status</div>
          {QUICK.map(([s, label]) => (
            <NavLink key={s} to={`/nurses?status=${s}`} className={() => navClass(quickStatus === s)}>{label}</NavLink>
          ))}
          <div className="sec">Admin</div>
          <NavLink to="/import" className={({ isActive }) => navClass(isActive)}>Import nurses</NavLink>
          {isSuper(user) && <NavLink to="/users" className={({ isActive }) => navClass(isActive)}>Staff accounts</NavLink>}
        </nav>
        <div className="me">
          <b>{user.name}</b>{meta.roles[user.role]?.label}{user.district ? ` · ${user.district}` : ''}
          <div style={{ marginTop: 8 }}><a href="/logout" onClick={logout} style={{ color: '#9fcfca' }}>Sign out</a></div>
        </div>
      </aside>
      <main>{children}</main>
    </div>
  );
}
