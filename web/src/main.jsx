import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { ToastProvider } from './components/Toast.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { Loading } from './components/Loading.jsx';
import './styles.css';

// The nurse portal and the staff app are separate bundles: nurses on slow mobile data only
// download what the registration page needs.
const StaffApp = lazy(() => import('./staff/StaffApp.jsx'));
const RegisterApp = lazy(() => import('./register/RegisterApp.jsx'));

// A 401 from any staff request means the session ended (expired, or access changed): show sign-in.
const onUnauthorized = err => {
  if (err?.status === 401 && err.scope === 'staff') queryClient.setQueryData(['me'], null);
};
const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onUnauthorized }),
  mutationCache: new MutationCache({ onError: onUnauthorized }),
  defaultOptions: {
    queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: (n, err) => n < 2 && !(err?.status >= 400 && err?.status < 500) },
  },
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <BrowserRouter>
            <Suspense fallback={<Loading full />}>
              <Routes>
                <Route path="/register" element={<RegisterApp />} />
                <Route path="/*" element={<StaffApp />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
