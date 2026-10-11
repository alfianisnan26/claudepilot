import {
  Badge,
  Button,
  buttonClass,
  ConfirmDialog,
  EmptyState,
  LoadError,
  Menu,
  RowsSkeleton,
  Spinner,
  useToast,
  type BadgeTone,
  type MenuItem,
} from '@isnanme/ui';
import type { AccountPool, DeliveryStatus, Workspace, WorkspaceStatus, WorkspaceTarget, WorkspaceUsage } from '@portal/contracts';
import { Box, Boxes, ChevronDown, KeySquare, Play, Plus, RefreshCw, ShieldCheck, Square, SquareTerminal, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { api, errorText } from '@/lib/api';
import { useLive, useLiveConnected } from '@/lib/live';
import { formatBytes, formatDateTime, timeAgo } from '@/lib/format';
import { AssignPoolDialog } from './AssignPoolDialog';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';
import { usageFractions } from './usage';
import { WorkspaceSheet } from './WorkspaceSheet';

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
  // This machine can't be created, so New only makes sense with another target to create on.
  const canCreate = !!targets?.some((t) => t.available && t.kind !== 'local');
  // Running ones first; otherwise the order the server gives (newest first).
  const ordered = list ? [...list].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running')) : null;

  return (
    <>
      <PageHeader
        title="Workspaces"
        description="Shell boxes with Claude Code."
        action={
          list &&
          list.length > 0 &&
          canCreate && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              <span className="hidden sm:inline">New workspace</span>
              <span className="sm:hidden">New</span>
            </Button>
          )
        }
      />

      {loadFailed && <LoadError onRetry={load} />}
      {!list && !loadFailed && <RowsSkeleton rows={3} lines={2} trailing icon="rounded-2xl" />}

      {ordered && targets && (
        <div className="flex flex-col gap-6">
          {ordered.length === 0 ? (
            <EmptyState
              icon={<Boxes className="size-6" />}
              title="No workspaces yet"
              action={
                <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)} disabled={!canCreate}>
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
                {ordered.map((w) => (
                  <WorkspaceRow
                    key={w.id}
                    w={w}
                    targetLabel={targetLabel(w.target)}
                    removable={targets.find((t) => t.id === w.target)?.kind !== 'local'}
                    usage={usage.get(w.id)}
                    busy={busy.has(w.id)}
                    onStart={() => void act(w, 'start')}
                    onStop={() => void act(w, 'stop')}
                    onRemove={() => setRemoving(w)}
                    onAssign={() => setAssigning(w)}
                    onAdopt={() => void adopt(w)}
                  />
                ))}
              </ul>
            </Card>
          )}

          <TargetStrip
            targets={targets}
            onRefresh={async () => {
              setTargets(await api.workspaces.targets(true));
              await loadList();
            }}
          />
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

/** Where workspaces can run: one line, opened on demand (open from the start when none is reachable). */
function TargetStrip({ targets, onRefresh }: { targets: WorkspaceTarget[]; onRefresh: () => Promise<void> }) {
  const reachable = targets.filter((t) => t.available).length;
  const [open, setOpen] = useState(reachable === 0);
  return (
    <div className="rounded-2xl border border-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 rounded-2xl px-3.5 py-2.5 text-left text-sm"
      >
        <span className={`size-2 shrink-0 rounded-full ${reachable ? 'bg-accent' : 'bg-danger'}`} />
        <span className="font-semibold">Targets</span>
        <span className="min-w-0 flex-1 truncate text-muted">
          {reachable} of {targets.length} reachable
        </span>
        <ChevronDown className={`size-4 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line p-2">
          <div className="grid gap-2 sm:grid-cols-3">
            {targets.map((t) => (
              <div
                key={t.id}
                title={t.problem}
                className="flex min-w-0 items-center gap-3 rounded-xl bg-surface px-3.5 py-2.5"
              >
                <span className={`size-2 shrink-0 rounded-full ${t.available ? 'bg-accent' : 'bg-danger'}`} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{t.label}</p>
                  <p className="truncate text-xs text-muted">{t.available ? t.where : (t.problem ?? 'Unreachable')}</p>
                </div>
              </div>
            ))}
          </div>
          <Button variant="ghost" size="sm" className="self-end" icon={<RefreshCw className="size-3.5" />} onClick={onRefresh}>
            Check again
          </Button>
        </div>
      )}
    </div>
  );
}

function WorkspaceRow({
  w,
  targetLabel,
  removable,
  usage,
  busy,
  onStart,
  onStop,
  onRemove,
  onAssign,
  onAdopt,
}: {
  w: Workspace;
  targetLabel: string;
  /** False for this machine: it is switched off, not removed. */
  removable: boolean;
  usage?: WorkspaceUsage;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRemove: () => void;
  onAssign: () => void;
  onAdopt: () => void;
}) {
  const status = STATUS[w.status];
  const running = w.status === 'running';
  const limits = [w.cpus && `${w.cpus} CPU`, w.memoryMb && formatBytes(w.memoryMb * 1024 * 1024)].filter(Boolean).join(' · ');
  const items: MenuItem[] = [
    running || w.status === 'starting'
      ? { label: 'Stop', icon: <Square className="size-4" />, onSelect: onStop, disabled: busy }
      : { label: 'Start', icon: <Play className="size-4" />, onSelect: onStart, disabled: busy || w.status !== 'stopped' },
    { label: 'Account pool…', icon: <KeySquare className="size-4" />, onSelect: onAssign, disabled: w.status === 'creating' },
    ...(w.delivery?.status === 'frozen' ? [{ label: 'Adopt workspace', icon: <ShieldCheck className="size-4" />, onSelect: onAdopt }] : []),
    { label: 'Remove', icon: <Trash2 className="size-4" />, onSelect: onRemove, danger: true, disabled: w.status === 'creating' || !removable },
  ];
  const delivery = w.delivery ? DELIVERY[w.delivery.status] : undefined;
  const account = w.account;
  // Progress while creating or starting, and errors; a running or stopped one needs no words.
  const showDetail = w.status !== 'running' && w.status !== 'stopped' && w.detail;
  // One short line: where and how old, the pool when one is assigned; how busy shows as bars beside it.
  const meta = [
    targetLabel,
    account && (account.state === 'waiting' ? `${account.poolName} · waiting` : account.state === 'removing' ? `removing ${account.poolName}` : account.poolName),
    limits,
    timeAgo(w.createdAt),
  ].filter(Boolean);
  // Running and stopped show in the icon and the action (Shell or Start); other states get a badge.
  const settled = (w.status === 'running' || w.status === 'stopped') && !busy;
  const [open, setOpen] = useState(false);

  return (
    <li className="flex items-center gap-3 p-4 sm:px-5">
      {/* The icon and text open the details; the buttons beside them keep their own jobs. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Details for ${w.name}`}
        className="press flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left"
      >
        <span
          className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${running ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-soft'}`}
        >
          <Box className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate font-semibold">{w.name}</p>
            {!settled && (
              <span className="shrink-0">
                <Badge tone={status.tone}>
                  {(status.busy || busy) && <Spinner className="size-3" />}
                  {status.label}
                </Badge>
              </span>
            )}
            {delivery && (
              <span title={w.delivery?.reason ?? undefined} className="shrink-0">
                <Badge tone={delivery.tone}>
                  {delivery.busy && <Spinner className="size-3" />}
                  {delivery.label}
                </Badge>
              </span>
            )}
          </div>
          {/* Running: how busy it is, as two bars. Otherwise where and how old (both are in the details too). */}
          {running && usageFractions(usage, w.cpus, w.memoryMb).cpu !== undefined ? (
            <UsageBars usage={usage} cpus={w.cpus} memoryMb={w.memoryMb} />
          ) : (
            <p className="mt-0.5 truncate text-[13px] text-muted" title={formatDateTime(w.createdAt)}>
              {meta.join(' · ')}
            </p>
          )}
          {showDetail && (
            <p className={`mt-1 line-clamp-2 text-[13px] ${w.status === 'error' ? 'text-danger' : 'text-ink-soft'}`}>{w.detail}</p>
          )}
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-1">
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
      <WorkspaceSheet
        open={open}
        onClose={() => setOpen(false)}
        w={w}
        status={status}
        delivery={delivery}
        targetLabel={targetLabel}
        usage={usage}
        busy={busy}
        items={items.slice(1)}
        onStart={onStart}
        onStop={onStop}
      />
    </li>
  );
}

/** Two small bars, CPU and memory; the figures are in the title and in the details sheet. */
function UsageBars({ usage, cpus, memoryMb }: { usage?: WorkspaceUsage; cpus?: number; memoryMb?: number }) {
  const { cpu, memory } = usageFractions(usage, cpus, memoryMb);
  if (cpu === undefined && memory === undefined) return null;
  const pct = (f?: number) => (f === undefined ? '–' : `${Math.round(f * 100)}%`);
  return (
    <span className="mt-1.5 flex items-center gap-4" title={`CPU ${pct(cpu)} · Memory ${pct(memory)}`}>
      <MiniBar label="CPU" fraction={cpu} />
      <MiniBar label="RAM" fraction={memory} />
    </span>
  );
}

function MiniBar({ label, fraction }: { label: string; fraction?: number }) {
  if (fraction === undefined) return null;
  const width = `${Math.min(100, Math.max(4, fraction * 100))}%`;
  return (
    <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-muted">
      {label}
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-2">
        <span className={`block h-full rounded-full ${fraction > 0.9 ? 'bg-danger' : 'bg-accent'}`} style={{ width }} />
      </span>
    </span>
  );
}
