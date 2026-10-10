import { ActivityBar, initViewportFix, ThemeProvider, ToastProvider, UiStringsProvider } from '@isnanme/ui';
import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { AppShell } from '@/components/AppShell';
import { AccountsPage } from '@/features/accounts/AccountsPage';
import { AccessPage } from '@/features/admin/AccessPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { ShellPage } from '@/features/workspaces/ShellPage';
import { WorkspacesPage } from '@/features/workspaces/WorkspacesPage';
import { AuthProvider, useAuth } from '@/lib/auth';
import { LiveProvider } from '@/lib/live';
import { HOME } from './nav';
import { uiStrings } from './strings';

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
        <Route path="accounts" element={<AccountsPage />} />
        <Route path="access" element={<AccessPage />} />
      </Route>
      {/* Full screen, outside the app frame: the terminal wants every pixel. */}
      <Route
        path="/admin/workspaces/:target/:name/shell"
        element={
          <SignedInOnly>
            <ShellPage />
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
