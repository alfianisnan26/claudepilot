import { ActivityBar, initViewportFix, ThemeProvider, ToastProvider, UiStringsProvider } from '@isnanme/ui';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { AppShell } from '@/components/AppShell';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Unreachable } from '@/components/Unreachable';
import { AccessPage } from '@/features/admin/AccessPage';
import { HomePage } from '@/features/home/HomePage';
import { NeedsYouPage } from '@/features/attention/NeedsYouPage';
import { SessionsPage } from '@/features/chat/SessionsPage';
import { TicketsPage } from '@/features/tickets/TicketsPage';
import { CiPage } from '@/features/ci/CiPage';
import { RunPage } from '@/features/ci/RunPage';
import { KnowledgePage } from '@/features/knowledge/KnowledgePage';
import { ClaudeUsageWatcher } from '@/features/usage/claude/AlertWatcher';
import { GlanceRoot } from '@/features/glance/Root';
import { NotificationsPage } from '@/features/notify/NotificationsPage';
import { NotifyRoot } from '@/features/notify/Root';
import { LoginPage } from '@/features/auth/LoginPage';
import { PoolsHub } from '@/features/pools/PoolsHub';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { POOL_TABS } from '@/features/pools/registry';
import { TargetsPage } from '@/features/targets';
import { WorkspacesPage } from '@/features/workspaces/WorkspacesPage';
import { useAppUpdate } from '@/lib/appUpdate';
import { MemberPage } from '@/features/auth/MemberPage';
import { AuthProvider, useAuth } from '@/lib/auth';
import { LiveProvider } from '@/lib/live';
import { HOME } from './nav';
import { uiStrings } from './strings';

// The full-screen views load on first use, in chunks of their own: the chat (markdown and all) and
// the terminal (xterm) stay out of the bundle every other page waits for.
const SessionPage = lazy(() => import('@/features/chat/SessionPage').then((m) => ({ default: m.SessionPage })));
const ShellPage = lazy(() => import('@/features/workspaces/ShellPage').then((m) => ({ default: m.ShellPage })));
// The browser's live view (browser PRD §15): noVNC loads only here.
const BrowserPage = lazy(() => import('@/features/browser/BrowserPage').then((m) => ({ default: m.BrowserPage })));
// A vault is full screen (list, note, graph), and its markdown and graph code stays out of the first bundle.
const VaultPage = lazy(() => import('@/features/knowledge/VaultPage').then((m) => ({ default: m.VaultPage })));
// The portal-wide graphs (which sessions used which notes; the agents) draw on a canvas, so they load on first use too.
const KnowledgeGraphPage = lazy(() => import('@/features/knowledge/GraphPage').then((m) => ({ default: m.GraphPage })));
// The Usage page (stacked charts, budgets, attribution, spikes) is large and not every visit needs it: it loads on first use, behind a skeleton.
const SchedulesPage = lazy(() => import('@/features/schedules/SchedulesPage').then((m) => ({ default: m.SchedulesPage })));
const UsagePage = lazy(() => import('@/features/usage/UsagePage').then((m) => ({ default: m.UsagePage })));

export function App() {
  useEffect(() => initViewportFix(), []);
  return (
    <ThemeProvider>
      {/* The CSS already stills transitions and animations for people who ask for less motion; this does it for the ones motion drives (page change, menus). */}
      <MotionConfig reducedMotion="user">
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
      </MotionConfig>
    </ThemeProvider>
  );
}

function AppRoutes() {
  useAppUpdate();
  const { pathname } = useLocation();
  // A page that fails (a lazy chunk the new build no longer has) shows a Reload instead of blanking the app.
  return (
    <ErrorBoundary resetKey={pathname}>
      <Pages />
      {/* The glance widgets' global parts, the ?glance= deep link and the app badge: once, over every page. */}
      <GlanceRoot />
      {/* Presence, toasts for what arrives while the tab is in use, and closing notifications that are dealt with. */}
      <NotifyRoot />
    </ErrorBoundary>
  );
}

function Pages() {
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
            <ClaudeUsageWatcher />
          </SignedInOnly>
        }
      >
        <Route index element={<Navigate to={HOME} replace />} />
        <Route path="home" element={<HomePage />} />
        <Route path="attention" element={<NeedsYouPage />} />
        <Route path="workspaces" element={<WorkspacesPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        {/* One page for the queue and an open ticket (a Workbench, T-158): beside the board on a desktop, in its place on a phone. */}
        <Route path="tickets/:id?" element={<TicketsPage />} />
        <Route path="ci" element={<CiPage />} />
        <Route path="ci/runs/:id" element={<RunPage />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route
          path="usage"
          element={
            <Suspense fallback={<div className="skeleton h-28 rounded-[24px]" />}>
              <UsagePage />
            </Suspense>
          }
        />
        <Route
          path="schedules"
          element={
            <Suspense fallback={<div className="skeleton h-28 rounded-[24px]" />}>
              <SchedulesPage />
            </Suspense>
          }
        />
        <Route path="pools" element={<PoolsHub />} />
        {/* Each pool type's own pages (library, catalog, review, page editors) are routes, not nested tabs. */}
        {POOL_TABS.flatMap((t) => (t.routes ?? []).map((r) => <Route key={`${t.id}/${r.path}`} path={`pools/${t.id}/${r.path}`} element={r.element} />))}
        <Route path="accounts" element={<Navigate to="/admin/pools?tab=accounts" replace />} />
        <Route path="targets" element={<TargetsPage />} />
        <Route path="access" element={<AccessPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="settings" element={<SettingsPage />} />
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
      {/* Full screen, outside the app frame: the graphs of the whole portal. */}
      <Route
        path="/admin/knowledge/graph"
        element={
          <SignedInOnly>
            <Suspense fallback={<Splash />}>
              <KnowledgeGraphPage />
            </Suspense>
          </SignedInOnly>
        }
      />
      {/* Full screen, outside the app frame: a vault's list, notes and graph want the width. */}
      <Route
        path="/admin/knowledge/:vault"
        element={
          <SignedInOnly>
            <Suspense fallback={<Splash />}>
              <VaultPage />
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
      {/* Full screen, outside the app frame: the browser wants every pixel too. */}
      <Route
        path="/admin/workspaces/:target/:name/browser"
        element={
          <SignedInOnly>
            <Suspense fallback={<Splash />}>
              <BrowserPage />
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
  if (state.status === 'unreachable') return <Unreachable />;
  if (state.status === 'out') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  // MU2 S1a: a member account has no access to the admin app yet.
  if (state.status === 'member') return <MemberPage />;
  return children;
}

function SignedOutOnly({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <Splash />;
  if (state.status === 'unreachable') return <Unreachable />;
  if (state.status === 'in' || state.status === 'member') {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from?.startsWith('/admin') ? from : HOME} replace />;
  }
  return children;
}
