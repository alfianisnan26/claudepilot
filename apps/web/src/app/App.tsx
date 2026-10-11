import { ActivityBar, initViewportFix, ThemeProvider, ToastProvider, UiStringsProvider } from '@isnanme/ui';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { AppShell } from '@/components/AppShell';
import { AccessPage } from '@/features/admin/AccessPage';
import { SessionsPage } from '@/features/chat/SessionsPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { PoolsHub } from '@/features/pools/PoolsHub';
import { POOL_TABS } from '@/features/pools/registry';
import { WorkspacesPage } from '@/features/workspaces/WorkspacesPage';
import { AuthProvider, useAuth } from '@/lib/auth';
import { LiveProvider } from '@/lib/live';
import { HOME } from './nav';
import { uiStrings } from './strings';

// The full-screen views load on first use, in chunks of their own: the chat (markdown and all) and
// the terminal (xterm) stay out of the bundle every other page waits for.
const SessionPage = lazy(() => import('@/features/chat/SessionPage').then((m) => ({ default: m.SessionPage })));
const ShellPage = lazy(() => import('@/features/workspaces/ShellPage').then((m) => ({ default: m.ShellPage })));

export function App() {
  useEffect(() => initViewportFix(), []);
  return (
    <ThemeProvider>
      <UiStringsProvider value={uiStrings}>
        <ToastProvider>
          <ActivityBar />
          <AuthProvider>
            <LiveProvider>
              <BrowserRouter>
                <AppRoutes />
              </BrowserRouter>
            </LiveProvider>
          </AuthProvider>
        </ToastProvider>
      </UiStringsProvider>
    </ThemeProvider>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <SignedOutOnly>
            <LoginPage />
          </SignedOutOnly>
        }
      />
      <Route
        path="/admin"
        element={
          <SignedInOnly>
            <AppShell />
          </SignedInOnly>
        }
      >
        <Route index element={<Navigate to={HOME} replace />} />
        <Route path="workspaces" element={<WorkspacesPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="pools" element={<PoolsHub />} />
        {/* Each pool type's own pages (library, catalog, review, page editors) are routes, not nested tabs. */}
        {POOL_TABS.flatMap((t) => (t.routes ?? []).map((r) => <Route key={`${t.id}/${r.path}`} path={`pools/${t.id}/${r.path}`} element={r.element} />))}
        <Route path="accounts" element={<Navigate to="/admin/pools?tab=accounts" replace />} />
        <Route path="access" element={<AccessPage />} />
      </Route>
      {/* Full screen, outside the app frame: the chat view owns the viewport (composer pinned, no tab bar). */}
      <Route
        path="/admin/sessions/:id"
        element={
          <SignedInOnly>
            <Suspense fallback={<Splash />}>
              <SessionPage />
            </Suspense>
          </SignedInOnly>
        }
      />
      {/* Full screen, outside the app frame: the terminal wants every pixel. */}
      <Route
        path="/admin/workspaces/:target/:name/shell"
        element={
          <SignedInOnly>
            <Suspense fallback={<Splash />}>
              <ShellPage />
            </Suspense>
          </SignedInOnly>
        }
      />
      <Route path="*" element={<Navigate to={HOME} replace />} />
    </Routes>
  );
}

function Splash() {
  return <div className="min-h-dvh" aria-busy="true" />;
}

function SignedInOnly({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <Splash />;
  if (state.status === 'out') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

function SignedOutOnly({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <Splash />;
  if (state.status === 'in') {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from?.startsWith('/admin') ? from : HOME} replace />;
  }
  return children;
}
