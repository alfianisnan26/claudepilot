import {
  Badge,
  Button,
  buttonClass,
  ConfirmDialog,
  EmptyState,
  LoadError,
  Menu,
  RowsSkeleton,
  Section,
  Spinner,
  useToast,
  type BadgeTone,
  type MenuItem,
} from '@isnanme/ui';
import type { AccountPool, ClaudeAuthStatus, DeliveryStatus, Workspace, WorkspaceStatus, WorkspaceTarget, WorkspaceUsage } from '@portal/contracts';
import { Box, Boxes, KeySquare, LogIn, LogOut, Play, Plus, RefreshCw, ShieldCheck, Square, SquareTerminal, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { api, errorText } from '@/lib/api';
import { useLive, useLiveConnected } from '@/lib/live';
import { formatBytes, formatDateTime, formatUntil, timeAgo } from '@/lib/format';
import { AssignPoolDialog } from './AssignPoolDialog';
import { ClaudeLoginDialog } from './ClaudeLoginDialog';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';

/** Delivery states worth showing on the row; synced and none stay quiet. */
const DELIVERY: Partial<Record<DeliveryStatus, { label: string; tone: BadgeTone; busy?: boolean }>> = {
  pending: { label: 'Delivering', tone: 'neutral', busy: true },
  failed: { label: 'Delivery failed', tone: 'danger' },
  frozen: { label: 'Frozen', tone: 'danger' },
  locked: { label: 'Locked', tone: 'warning' },
  drifted: { label: 'Drifted', tone: 'warning' },
  unsupported: { label: 'No delivery yet', tone: 'neutral' },
};

const STATUS: Record<WorkspaceStatus, { label: string; tone: BadgeTone; busy?: boolean }> = {
  creating: { label: 'Creating', tone: 'neutral', busy: true },
  starting: { label: 'Starting', tone: 'neutral', busy: true },
  running: { label: 'Running', tone: 'success' },
  stopping: { label: 'Stopping', tone: 'neutral', busy: true },
  stopped: { label: 'Stopped', tone: 'neutral' },
  error: { label: 'Error', tone: 'danger' },
};

/** Only while the live socket is down: faster while something is changing, so progress still shows. */
const POLL_BUSY_MS = 2_000;
const POLL_IDLE_MS = 10_000;
const USAGE_MS = 5_000;

export function WorkspacesPage() {
  const toast = useToast();
  const [targets, setTargets] = useState<WorkspaceTarget[] | null>(null);
  const [list, setList] = useState<Workspace[] | null>(null);
  const [usage, setUsage] = useState<Map<string, WorkspaceUsage>>(new Map());
  const [loadFailed, setLoadFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Workspace | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [removeBusy, setRemoveBusy] = useState(false);
  const [pools, setPools] = useState<AccountPool[]>([]);
  const [assigning, setAssigning] = useState<Workspace | null>(null);
  const [signingIn, setSigningIn] = useState<Workspace | null>(null);
  const [signingOut, setSigningOut] = useState<Workspace | null>(null);
  const [signOutBusy, setSignOutBusy] = useState(false);
  // Claude sign-in state per workspace (running, pool-less ones), read through `claude auth status`.
  const [claudeAuth, setClaudeAuth] = useState<Map<string, ClaudeAuthStatus | 'loading'>>(new Map());
  const authWatched = useRef<Set<string>>(new Set());

  const refreshAuth = useCallback(async (id: string) => {
    setClaudeAuth((m) => new Map(m).set(id, 'loading'));
    try {
      const status = await api.workspaces.claudeAuthStatus(id);
      setClaudeAuth((m) => new Map(m).set(id, status));
    } catch {
      setClaudeAuth((m) => {
        const next = new Map(m);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const signOut = async () => {
    if (!signingOut) return;
    setSignOutBusy(true);
    try {
      await api.workspaces.claudeLogout(signingOut.id);
      toast(`Signed out of Claude in ${signingOut.name}`);
      const id = signingOut.id;
      setSigningOut(null);
      void refreshAuth(id);
    } catch (e) {
      toast(errorText(e, 'Could not sign out.'), 'error');
    } finally {
      setSignOutBusy(false);
    }
  };

  // Check sign-in state once per eligible workspace; forget it when it stops or gets a pool.
  useEffect(() => {
    if (!list) return;
    const eligible = new Set(list.filter((w) => w.status === 'running' && !w.account).map((w) => w.id));
    for (const id of eligible)
      if (!authWatched.current.has(id)) {
        authWatched.current.add(id);
        void refreshAuth(id);
      }
    for (const id of [...authWatched.current])
      if (!eligible.has(id)) {
        authWatched.current.delete(id);
        setClaudeAuth((m) => {
          const next = new Map(m);
          next.delete(id);
          return next;
        });
      }
  }, [list, refreshAuth]);

  useEffect(() => {
    api.accounts.pools().then(setPools, () => undefined);
  }, []);

  const adopt = async (w: Workspace) => {
    try {
      await api.accounts.adopt(w.id);
      await loadList();
      toast(`${w.name} adopted`);
    } catch (e) {
      toast(errorText(e, 'Could not adopt it.'), 'error');
    }
  };

  const loadList = useCallback(async () => {
    const next = await api.workspaces.list();
    setList(next);
    return next;
  }, []);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const [t] = await Promise.all([api.workspaces.targets(), loadList()]);
      setTargets(t);
    } catch {
      setLoadFailed(true);
    }
  }, [loadList]);

  useEffect(() => void load(), [load]);

  // The portal pushes the list when it changes, and usage while something runs.
  const live = useLiveConnected();
  const anyRunning = !!list?.some((w) => w.status === 'running');
  useLive('workspaces', (msg) => setList(msg.data));
  useLive('usage', (msg) => setUsage(new Map(msg.data.map((x) => [x.id, x]))), anyRunning);
  useLive('accounts', () => void api.accounts.pools().then(setPools, () => undefined));

  // Without the live socket (reconnecting), poll: quickly while anything is mid-change, slowly otherwise.
  const anyBusy = !!list?.some((w) => STATUS[w.status].busy || w.delivery?.status === 'pending' || w.account?.state === 'removing');
  useEffect(() => {
    if (live || !list) return;
    const t = setTimeout(() => void loadList().catch(() => undefined), anyBusy ? POLL_BUSY_MS : POLL_IDLE_MS);
    return () => clearTimeout(t);
  }, [live, list, anyBusy, loadList]);

  useEffect(() => {
    if (live || !anyRunning) return;
    let stop = false;
    const tick = async () => {
      try {
        const u = await api.workspaces.usage();
        if (!stop) setUsage(new Map(u.map((x) => [x.id, x])));
      } catch {
        // keep the last numbers
      }
    };
    void tick();
    const t = setInterval(() => void tick(), USAGE_MS);
    return () => ((stop = true), clearInterval(t));
  }, [live, anyRunning]);

  const act = async (w: Workspace, action: 'start' | 'stop') => {
    setBusy((s) => new Set(s).add(w.id));
    try {
      await api.workspaces[action](w.id);
      await loadList();
      toast(action === 'start' ? `Starting ${w.name}` : `Stopping ${w.name}`);
    } catch (e) {
      toast(errorText(e, `Could not ${action} ${w.name}.`), 'error');
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(w.id);
        return next;
      });
    }
  };

  const remove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    try {
      await api.workspaces.remove(removing.id);
      await loadList();
      toast(`${removing.name} removed`);
      setRemoving(null);
    } catch (e) {
      toast(errorText(e, 'Could not remove it.'), 'error');
    } finally {
      setRemoveBusy(false);
    }
  };

  const targetLabel = (id: string) => targets?.find((t) => t.id === id)?.label ?? id;
  const anyAvailable = !!targets?.some((t) => t.available);

  return (
    <>
      <PageHeader
        title="Workspaces"
        description="Shell boxes with Claude Code, on Docker or Kubernetes."
        action={
          list &&
          list.length > 0 && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)} disabled={!anyAvailable}>
              <span className="hidden sm:inline">New workspace</span>
              <span className="sm:hidden">New</span>
            </Button>
          )
        }
      />

      {loadFailed && <LoadError onRetry={load} />}
      {!list && !loadFailed && <RowsSkeleton rows={3} lines={2} trailing icon="rounded-2xl" />}

      {list && targets && (
        <div className="flex flex-col gap-8">
          <TargetStrip
            targets={targets}
            onRefresh={async () => {
              setTargets(await api.workspaces.targets(true));
              await loadList();
            }}
          />

          {list.length === 0 ? (
            <EmptyState
              icon={<Boxes className="size-6" />}
              title="No workspaces yet"
              action={
                <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)} disabled={!anyAvailable}>
                  New workspace
                </Button>
              }
            >
              {anyAvailable
                ? 'Each one is a container with Claude Code, git and gh, and a home folder that persists.'
                : 'No target is reachable. Check the Docker sockets or the kubeconfig.'}
            </EmptyState>
          ) : (
            <Card>
              <ul className="divide-y divide-line">
                {list.map((w) => (
                  <WorkspaceRow
                    key={w.id}
                    w={w}
                    targetLabel={targetLabel(w.target)}
                    usage={usage.get(w.id)}
                    busy={busy.has(w.id)}
                    onStart={() => void act(w, 'start')}
                    onStop={() => void act(w, 'stop')}
                    onRemove={() => setRemoving(w)}
                    onAssign={() => setAssigning(w)}
                    onAdopt={() => void adopt(w)}
                    onSignIn={() => setSigningIn(w)}
                    onSignOut={() => setSigningOut(w)}
                    claudeAuth={claudeAuth.get(w.id)}
                  />
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      <AssignPoolDialog
        workspace={assigning}
        pools={pools}
        onClose={() => setAssigning(null)}
        onDone={(message) => {
          setAssigning(null);
          toast(message);
          void loadList();
        }}
      />
      <NewWorkspaceDialog
        open={creating}
        targets={targets ?? []}
        pools={pools}
        onClose={() => setCreating(false)}
        onCreate={async (body) => {
          const w = await api.workspaces.create(body);
          setCreating(false);
          setList((l) => (l ? [w, ...l.filter((x) => x.id !== w.id)] : [w]));
          toast(`Creating ${w.name}`);
        }}
      />
      <ClaudeLoginDialog
        workspace={signingIn}
        onClose={() => setSigningIn(null)}
        onDone={() => {
          toast(`Signed in to Claude in ${signingIn?.name ?? 'the workspace'}`);
          if (signingIn) void refreshAuth(signingIn.id);
          setSigningIn(null);
        }}
      />
      <ConfirmDialog
        open={!!signingOut}
        tone="primary"
        title={`Sign out of Claude in ${signingOut?.name ?? ''}?`}
        description="Claude Code there forgets your Claude sign-in and asks you to sign in again."
        confirmLabel="Sign out"
        loading={signOutBusy}
        onConfirm={() => void signOut()}
        onClose={() => !signOutBusy && setSigningOut(null)}
      />
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.name ?? ''}?`}
        description="The container and its home folder are deleted, with everything in them. This can’t be undone."
        confirmLabel="Remove"
        loading={removeBusy}
        onConfirm={() => void remove()}
        onClose={() => !removeBusy && setRemoving(null)}
      />
    </>
  );
}

function TargetStrip({ targets, onRefresh }: { targets: WorkspaceTarget[]; onRefresh: () => Promise<void> }) {
  return (
    <Section
      title="Targets"
      action={
        <Button variant="ghost" size="sm" icon={<RefreshCw className="size-3.5" />} onClick={onRefresh}>
          Check
        </Button>
      }
    >
      <div className="grid gap-2 sm:grid-cols-3">
        {targets.map((t) => (
          <div
            key={t.id}
            title={t.problem}
            className="flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface px-3.5 py-2.5"
          >
            <span className={`size-2 shrink-0 rounded-full ${t.available ? 'bg-accent' : 'bg-danger'}`} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{t.label}</p>
              <p className="truncate text-xs text-muted">{t.available ? t.where : (t.problem ?? 'Unreachable')}</p>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function WorkspaceRow({
  w,
  targetLabel,
  usage,
  busy,
  onStart,
  onStop,
  onRemove,
  onAssign,
  onAdopt,
  onSignIn,
  onSignOut,
  claudeAuth,
}: {
  w: Workspace;
  targetLabel: string;
  usage?: WorkspaceUsage;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRemove: () => void;
  onAssign: () => void;
  onAdopt: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  claudeAuth?: ClaudeAuthStatus | 'loading';
}) {
  const status = STATUS[w.status];
  const running = w.status === 'running';
  const authKnown = claudeAuth && claudeAuth !== 'loading' ? claudeAuth : null;
  const signedInToClaude = !!authKnown?.loggedIn;
  const limits = [w.cpus && `${w.cpus} CPU`, w.memoryMb && formatBytes(w.memoryMb * 1024 * 1024)].filter(Boolean).join(' · ');
  const items: MenuItem[] = [
    running || w.status === 'starting'
      ? { label: 'Stop', icon: <Square className="size-4" />, onSelect: onStop, disabled: busy }
      : { label: 'Start', icon: <Play className="size-4" />, onSelect: onStart, disabled: busy || w.status !== 'stopped' },
    { label: 'Account pool…', icon: <KeySquare className="size-4" />, onSelect: onAssign, disabled: w.status === 'creating' },
    // Your own Claude account, for workspaces without a pool (a pool's keys would take precedence).
    ...(running && !w.account
      ? [
          { label: signedInToClaude ? 'Switch Claude account…' : 'Sign in to Claude…', icon: <LogIn className="size-4" />, onSelect: onSignIn },
          ...(signedInToClaude ? [{ label: 'Sign out of Claude', icon: <LogOut className="size-4" />, onSelect: onSignOut }] : []),
        ]
      : []),
    ...(w.delivery?.status === 'frozen' ? [{ label: 'Adopt workspace', icon: <ShieldCheck className="size-4" />, onSelect: onAdopt }] : []),
    { label: 'Remove', icon: <Trash2 className="size-4" />, onSelect: onRemove, danger: true, disabled: w.status === 'creating' },
  ];
  const delivery = w.delivery ? DELIVERY[w.delivery.status] : undefined;
  const account = w.account;
  // A shell is the point of a workspace: link straight to it once it's running.
  const showDetail = w.status !== 'running' && w.status !== 'stopped' && w.detail;

  return (
    <li className="flex items-start gap-3 p-4 sm:items-center sm:px-5">
      <span
        className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${running ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-soft'}`}
      >
        <Box className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="truncate font-semibold">{w.name}</p>
          <Badge tone={status.tone}>
            {status.busy || busy ? <Spinner className="size-3" /> : running && <span className="size-1.5 rounded-full bg-accent" />}
            {status.label}
          </Badge>
          {delivery && (
            <Badge tone={delivery.tone}>
              {delivery.busy && <Spinner className="size-3" />}
              {delivery.label}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-[13px] text-muted">
          {targetLabel}
          {limits && ` · ${limits}`}
          {' · '}
          <span title={formatDateTime(w.createdAt)}>created {timeAgo(w.createdAt)}</span>
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-[13px] text-muted">
          <KeySquare className="size-3.5 shrink-0" />
          {!account
            ? !running
              ? 'Own sign-in'
              : claudeAuth === undefined || claudeAuth === 'loading'
                ? 'Claude sign-in: checking…'
                : claudeAuth.loggedIn
                  ? claudeAuth.method === 'console'
                    ? 'Signed in to Claude · Console key'
                    : 'Signed in to Claude'
                  : 'Not signed in to Claude'
            : account.state === 'removing'
              ? `Removing ${account.poolName}…`
              : account.state === 'waiting'
                ? `${account.poolName} · ${account.waitingUntil ? `waiting for quota until ${formatUntil(account.waitingUntil)}` : 'waiting for a usable account'}`
                : `${account.poolName} · ${account.accountName}`}
        </p>
        {w.delivery?.reason && delivery && <p className="mt-1 line-clamp-2 text-[13px] text-ink-soft">{w.delivery.reason}</p>}
        {showDetail && (
          <p className={`mt-1 line-clamp-2 text-[13px] ${w.status === 'error' ? 'text-danger' : 'text-ink-soft'}`}>{w.detail}</p>
        )}
        {running && <UsageLine usage={usage} memoryMb={w.memoryMb} cpus={w.cpus} />}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {running && !account && authKnown && !signedInToClaude && (
          <Button variant="secondary" size="sm" icon={<LogIn className="size-4" />} onClick={onSignIn}>
            <span className="hidden sm:inline">Sign in</span>
          </Button>
        )}
        {running ? (
          <Link
            to={`/admin/workspaces/${w.id}/shell`}
            className={buttonClass('secondary', 'sm')}
            aria-label={`Open shell in ${w.name}`}
          >
            <SquareTerminal className="size-4" />
            <span className="hidden sm:inline">Shell</span>
          </Link>
        ) : (
          w.status === 'stopped' && (
            <Button variant="secondary" size="sm" icon={<Play className="size-4" />} loading={busy} onClick={onStart}>
              <span className="hidden sm:inline">Start</span>
            </Button>
          )
        )}
        <Menu label={`Actions for ${w.name}`} items={items} />
      </div>
    </li>
  );
}

function UsageLine({ usage, memoryMb, cpus }: { usage?: WorkspaceUsage; memoryMb?: number; cpus?: number }) {
  const cpu = usage?.cpuPercent;
  const mem = usage?.memoryBytes;
  const memLimit = memoryMb ? memoryMb * 1024 * 1024 : undefined;
  return (
    <div className="mt-2 grid max-w-md grid-cols-2 gap-3 text-[12px] text-muted">
      <Meter
        label="CPU"
        value={cpu == null ? '–' : `${cpu.toFixed(cpu < 10 ? 1 : 0)}%`}
        fraction={cpu == null ? undefined : cpu / 100 / (cpus ?? 1)}
      />
      <Meter
        label="Memory"
        value={mem == null ? '–' : memLimit ? `${formatBytes(mem)} / ${formatBytes(memLimit)}` : formatBytes(mem)}
        fraction={mem == null || !memLimit ? undefined : mem / memLimit}
      />
    </div>
  );
}

function Meter({ label, value, fraction }: { label: string; value: string; fraction?: number }) {
  const pct = fraction === undefined ? 0 : Math.min(100, Math.max(2, fraction * 100));
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span>{label}</span>
        <span className="truncate font-medium tabular-nums text-ink-soft">{value}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
        {fraction !== undefined && (
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${fraction > 0.9 ? 'bg-danger' : 'bg-accent'}`}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}
