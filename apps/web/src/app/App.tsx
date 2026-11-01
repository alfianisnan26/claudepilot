import { ActivityBar, initViewportFix, ThemeProvider, ToastProvider, UiStringsProvider } from '@isnanme/ui';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { AppShell } from '@/components/AppShell';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Unreachable } from '@/components/Unreachable';
import { HomePage } from '@/features/home/HomePage';
import { ClaudeUsageWatcher } from '@/features/usage/claude/AlertWatcher';
import { GlanceRoot } from '@/features/glance/Root';
import { NotifyRoot } from '@/features/notify/Root';
import { LoginPage } from '@/features/auth/LoginPage';
import { connectReturnPath } from '@/features/auth/next';
import { useAppUpdate } from '@/lib/appUpdate';
import { profileReturnPath } from '@/features/profile/model';
import { AuthProvider, isAdminState, useAuth } from '@/lib/auth';
import { LiveProvider } from '@/lib/live';
import { Lazy, lazyPage, preloadPages } from './lazyPage';
import { HOME, isAdminOnlyPath } from './nav';
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
// Every other page of the app frame loads on first use too (owner request 2026-11-01, performance): the first load carries Home, the
// shell and the sign-in only; the rest is fetched while the browser is idle after the first paint (preloadPages), so a tap still opens
// a page at once. Each page waits inside the frame (Lazy), so the side panel and tab bar never blank.
const AccessPage = lazyPage(() => import('@/features/admin/AccessPage'), (m) => m.AccessPage);
const NeedsYouPage = lazyPage(() => import('@/features/attention/NeedsYouPage'), (m) => m.NeedsYouPage);
const ApprovalPage = lazyPage(() => import('@/features/approvals/ApprovalPage'), (m) => m.ApprovalPage);
const SessionsPage = lazyPage(() => import('@/features/chat/SessionsPage'), (m) => m.SessionsPage);
const TicketsPage = lazyPage(() => import('@/features/tickets/TicketsPage'), (m) => m.TicketsPage);
const CiPage = lazyPage(() => import('@/features/ci/CiPage'), (m) => m.CiPage);
const RunPage = lazyPage(() => import('@/features/ci/RunPage'), (m) => m.RunPage);
const KnowledgePage = lazyPage(() => import('@/features/knowledge/KnowledgePage'), (m) => m.KnowledgePage);
const NotificationsPage = lazyPage(() => import('@/features/notify/NotificationsPage'), (m) => m.NotificationsPage);
const OrgInvitePage = lazyPage(() => import('@/features/orgs/OrgInvitePage'), (m) => m.OrgInvitePage);
const OrgSettingsPage = lazyPage(() => import('@/features/orgs/OrgSettingsPage'), (m) => m.OrgSettingsPage);
const PoolsHub = lazyPage(() => import('@/features/pools/PoolsHub'), (m) => m.PoolsHub);
const SettingsPage = lazyPage(() => import('@/features/settings/SettingsPage'), (m) => m.SettingsPage);
const TargetsPage = lazyPage(() => import('@/features/targets'), (m) => m.TargetsPage);
const WorkspacesPage = lazyPage(() => import('@/features/workspaces/WorkspacesPage'), (m) => m.WorkspacesPage);
const VscodePage = lazyPage(() => import('@/features/vscode/VscodePage'), (m) => m.VscodePage);
const MemberPage = lazyPage(() => import('@/features/auth/MemberPage'), (m) => m.MemberPage);
const ProfilePage = lazyPage(() => import('@/features/profile/ProfilePage'), (m) => m.ProfilePage);
// A pool type's own pages (library, catalog, review, editors) come with the pool registry, in its own chunk.
const PoolRoutes = lazyPage(() => import('@/features/pools/PoolRoutes'), (m) => m.PoolRoutes);

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
            <AdminUsageWatcher />
          </SignedInOnly>
        }
      >
        <Route index element={<Navigate to={HOME} replace />} />
        <Route path="home" element={<HomePage />} />
        <Route path="attention" element={<Lazy><NeedsYouPage /></Lazy>} />
        {/* An agent's request for the portal to act for it; the deck's card opens this (approvals PRD). */}
        <Route path="approvals/:id" element={<Lazy><ApprovalPage /></Lazy>} />
        <Route path="workspaces" element={<Lazy><WorkspacesPage /></Lazy>} />
        <Route path="sessions" element={<Lazy><SessionsPage /></Lazy>} />
        {/* One page for the queue and an open ticket (a Workbench, T-158): beside the board on a desktop, in its place on a phone. */}
        <Route path="tickets/:id?" element={<Lazy><TicketsPage /></Lazy>} />
        <Route path="ci/:tab?" element={<Lazy><CiPage /></Lazy>} />
        <Route path="ci/runs/:id" element={<Lazy><RunPage /></Lazy>} />
        <Route path="knowledge" element={<Lazy><KnowledgePage /></Lazy>} />
        <Route
          path="usage/:tab?"
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
        <Route path="pools/:tab?" element={<Lazy><PoolsHub /></Lazy>} />
        {/* Each pool type's own pages (library, catalog, review, page editors) are routes, not nested tabs. */}
        <Route path="pools/:type/*" element={<Lazy><PoolRoutes /></Lazy>} />
        <Route path="accounts" element={<Navigate to="/admin/pools" replace />} />
        <Route path="targets" element={<Lazy><TargetsPage /></Lazy>} />
        <Route path="access/:tab?" element={<Lazy><AccessPage /></Lazy>} />
        <Route path="notifications/:tab?" element={<Lazy><NotificationsPage /></Lazy>} />
        <Route path="settings/:tab?" element={<Lazy><SettingsPage /></Lazy>} />
        {/* The person's own account (owner request 2026-11-01), from the account menu; members and admins alike. */}
        <Route path="profile/:tab?" element={<Lazy><ProfilePage /></Lazy>} />
        {/* Org settings (organizations §7): its own page per org, reached from the context switcher. */}
        <Route path="orgs/:id/:tab?" element={<Lazy><OrgSettingsPage /></Lazy>} />
        {/* Accepting an organization invitation (slice 8): the code is in the link's fragment. */}
        <Route path="org-invite" element={<Lazy><OrgInvitePage /></Lazy>} />
        {/* The VS Code extension's sign-in: a person approves the code their editor shows (T-1974). */}
        <Route path="vscode" element={<Lazy><VscodePage /></Lazy>} />
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
      {/* D-82 S1a: a member's sessions shared through the delegation door, their teams, password and sign-out (the former member page). */}
      <Route
        path="/admin/shared"
        element={
          <SignedInOnly>
            <Suspense fallback={<Splash />}>
              <MemberPage />
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
      {/* The server sends a link's return here (`/profile?linked=1`, `?link_error=`): it opens the Sign-in tab, where Linked sign-ins are. */}
      <Route path="/profile" element={<ProfileRedirect />} />
      <Route path="*" element={<Navigate to={HOME} replace />} />
    </Routes>
  );
}

/** Claude usage and spend alerts are the platform's (`platform(usage)`): a member's app does not ask (D-82 S1a). */
function AdminUsageWatcher() {
  const { state } = useAuth();
  return isAdminState(state) ? <ClaudeUsageWatcher /> : null;
}

function Splash() {
  return <div className="min-h-dvh" aria-busy="true" />;
}

function SignedInOnly({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <Splash />;
  if (state.status === 'unreachable') return <Unreachable />;
  // The fragment comes along (kept in router state, never sent to the server): an invitation link opened signed out still works after sign-in.
  if (state.status === 'out') return <Navigate to="/login" replace state={{ from: location.pathname + location.search + location.hash }} />;
  // D-82 S1a: a member account gets the normal app; a platform area (its nav item hidden) sends it home, the server refuses its calls anyway.
  if (!isAdminState(state) && isAdminOnlyPath(location.pathname)) return <Navigate to={HOME} replace />;
  return <PreloadPages>{children}</PreloadPages>;
}

/** Signed in and on a page: the other pages' chunks load while the browser is idle (lazyPage.tsx). */
function PreloadPages({ children }: { children: ReactNode }) {
  useEffect(() => preloadPages(), []);
  return children;
}

/** `/profile` (the server's return address for a link) to the Profile, keeping the query; a link's outcome opens the Sign-in tab. */
function ProfileRedirect() {
  const { search } = useLocation();
  return <Navigate to={`${profileReturnPath(search)}${search}`} replace />;
}

function SignedOutOnly({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <Splash />;
  if (state.status === 'unreachable') return <Unreachable />;
  if (state.status === 'in') {
    // The UI reporter's connect popup sent the person here to sign in: back to it (a server page, so a full load).
    const back = connectReturnPath(new URLSearchParams(location.search).get('next'));
    if (back) {
      window.location.replace(back);
      return <Splash />;
    }
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from?.startsWith('/admin') ? from : HOME} replace />;
  }
  return children;
}
