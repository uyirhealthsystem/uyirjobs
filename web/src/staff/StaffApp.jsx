import { useMemo } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Loading, ErrorPanel } from '../components/Loading.jsx';
import { AuthContext, isSuper } from './auth.jsx';
import { Login } from './Login.jsx';
import { Layout } from './Layout.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { NurseList } from './pages/NurseList.jsx';
import { NurseDetail } from './pages/NurseDetail.jsx';
import { ImportPage } from './pages/ImportPage.jsx';
import { UsersPage } from './pages/UsersPage.jsx';

/** Who is signed in (null = nobody). */
async function fetchMe() {
  try { return await api.get('/api/me'); } catch (e) { if (e.status === 401) return null; throw e; }
}

export default function StaffApp() {
  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: 5 * 60e3 });
  const auth = useMemo(() => (me.data ? { user: me.data.user, meta: me.data.meta } : null), [me.data]);

  if (me.isPending) return <Loading full />;
  if (me.isError) return <div className="login"><ErrorPanel error={me.error} onRetry={() => me.refetch()} /></div>;
  if (!auth) return <Login />;

  return (
    <AuthContext.Provider value={auth}>
      <Layout>
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="nurses" element={<NurseList />} />
          <Route path="nurses/:id" element={<NurseDetail />} />
          <Route path="import" element={<ImportPage />} />
          {isSuper(auth.user) && <Route path="users" element={<UsersPage />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </AuthContext.Provider>
  );
}
