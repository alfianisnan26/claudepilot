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
import { isLastKnownStatus, workspaceDisplayName, type AccountPool, type DeliveryStatus, type RepoWorkspaceSummary, type Workspace, type WorkspaceStatus, type WorkspaceTarget, type WorkspaceUsage } from '@portal/contracts';
import { AppWindow, Box, Boxes, Check, ChevronRight, ListChecks, Play, Plus, ShieldCheck, SlidersHorizontal, Square, SquareTerminal, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { ReposChip, REPOS_CHIP_ATTR, reposLabel, useReposOverview } from '@/features/repos';
import { api, errorText } from '@/lib/api';
import { useLive, useLiveConnected } from '@/lib/live';
import { formatBytes, formatDateTime, timeAgo } from '@/lib/format';
import { BulkAssignDialog } from './BulkAssignDialog';
import { ConfigurationSheet } from './ConfigurationSheet';
import { unavailableNote } from './lastKnown';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';
import { usageFractions } from './usage';
import { WorkspaceSheet, type SheetTab } from './WorkspaceSheet';
import { VersionChip } from '@/features/claudeversion/VersionChip';

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
  unreachable: { label: 'Unreachable', tone: 'warning' },
  unavailable: { label: 'Unavailable', tone: 'warning' },
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
  // By ID: the sheet shows the workspace as the live list has it now.
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  // Bulk assignment: pick workspaces, then "Assign pool…".
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [bulk, setBulk] = useState(false);
  useEffect(() => {
    api.accounts.pools().then(setPools, () => undefined);
  }, []);

  const adopt = async (w: Workspace) => {
    try {
      await api.accounts.adopt(w.id);
      await loadList();
      toast(`${workspaceDisplayName(w)} adopted`);
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
  // How many repositories of each workspace need a look: the chip on its row.
  const repos = useReposOverview();

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
      toast(action === 'start' ? `Starting ${workspaceDisplayName(w)}` : `Stopping ${workspaceDisplayName(w)}`);
    } catch (e) {
      toast(errorText(e, `Could not ${action} ${workspaceDisplayName(w)}.`), 'error');
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
      toast(`${workspaceDisplayName(removing)} removed`);
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
          {ordered.length > 0 && (
            <SelectionBar
              total={ordered.length}
              selected={selected}
              onStart={() => setSelected(new Set())}
              onAll={() => setSelected(new Set(ordered.map((w) => w.id)))}
              onAssign={() => setBulk(true)}
              onCancel={() => setSelected(null)}
            />
          )}
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
                : 'No target is reachable. Check them on the Targets page.'}
            </EmptyState>
          ) : (
            <Card>
              <ul className="divide-y divide-line">
                {ordered.map((w) => (
                  <WorkspaceRow
                    key={w.id}
                    w={w}
                    targetLabel={targetLabel(w.target)}
                    removable={!['local'].includes(targets.find((t) => t.id === w.target)?.kind ?? '') && targets.find((t) => t.id === w.target)?.role !== 'single'}
                    usage={usage.get(w.id)}
                    repos={repos.byWorkspace.get(w.id)}
                    reposTab={targets.find((t) => t.id === w.target)?.kind !== 'kubernetes'}
                    resources={targets.find((t) => t.id === w.target)?.kind === 'kubernetes'}
                    busy={busy.has(w.id)}
                    onStart={() => void act(w, 'start')}
                    onStop={() => void act(w, 'stop')}
                    onRemove={() => setRemoving(w)}
                    onConfigure={() => setConfiguringId(w.id)}
                    selected={selected ? selected.has(w.id) : null}
                    onToggle={() =>
                      setSelected((s) => {
                        const next = new Set(s);
                        if (!next.delete(w.id)) next.add(w.id);
                        return next;
                      })
                    }
                    onAdopt={() => void adopt(w)}
                  />
                ))}
              </ul>
            </Card>
          )}

          <TargetStrip targets={targets} />
        </div>
      )}

      <ConfigurationSheet
        workspace={list?.find((w) => w.id === configuringId) ?? null}
        accountPools={pools}
        onClose={() => setConfiguringId(null)}
        onChanged={() => void loadList().catch(() => undefined)}
      />
      <BulkAssignDialog
        workspaces={bulk ? (list ?? []).filter((w) => selected?.has(w.id)) : null}
        accountPools={pools}
        onClose={() => setBulk(false)}
        onDone={(message) => {
          setBulk(false);
          setSelected(null);
          toast(message);
          void loadList().catch(() => undefined);
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
          toast(`Creating ${workspaceDisplayName(w)}`);
        }}
      />
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing ? workspaceDisplayName(removing) : ''}?`}
        description="The container and its home folder are deleted, with everything in them. This can’t be undone."
        confirmLabel="Remove"
        loading={removeBusy}
        onConfirm={() => void remove()}
        onClose={() => !removeBusy && setRemoving(null)}
      />
    </>
  );
}

/** Where workspaces can run: one line to the Targets page, which has the list, the checks and Add. */
function TargetStrip({ targets }: { targets: WorkspaceTarget[] }) {
  const reachable = targets.filter((t) => t.available).length;
  return (
    <Link to="/admin/targets" className="press flex min-h-11 items-center gap-3 rounded-2xl border border-line px-3.5 py-2.5 text-sm">
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${reachable ? 'bg-accent' : 'bg-danger'}`} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold">Targets</span>
        <span className="text-muted"> · {reachable} of {targets.length} reachable</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden="true" />
    </Link>
  );
}

function WorkspaceRow({
  w,
  targetLabel,
  removable,
  usage,
  repos,
  reposTab,
  resources,
  busy,
  onStart,
  onStop,
  onRemove,
  onConfigure,
  selected,
  onToggle,
  onAdopt,
}: {
  w: Workspace;
  targetLabel: string;
  /** False for this machine: it is switched off, not removed. */
  removable: boolean;
  usage?: WorkspaceUsage;
  /** What the last scan found in its repositories (none: never scanned). */
  repos?: RepoWorkspaceSummary;
  /** Its sheet has a Repos tab (not for Kubernetes). */
  reposTab: boolean;
  /** Its sheet has the Resources row (Kubernetes, T-98). */
  resources: boolean;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRemove: () => void;
  onConfigure: () => void;
  /** Null outside selection mode; then whether this row is picked. */
  selected: boolean | null;
  onToggle: () => void;
  onAdopt: () => void;
}) {
  const status = STATUS[w.status];
  const running = w.status === 'running';
  const picking = selected !== null;
  // Its target's tunnel is down, or its API did not answer (T-515): what needs the target waits (the row and its sheet say since when).
  const unreachable = isLastKnownStatus(w.status);
  const note = unavailableNote(w);
  const limits = [w.cpus && `${w.cpus} CPU`, w.memoryMb && formatBytes(w.memoryMb * 1024 * 1024)].filter(Boolean).join(' · ');
  const navigate = useNavigate();
  const items: MenuItem[] = [
    running || w.status === 'starting'
      ? { label: 'Stop', icon: <Square className="size-4" />, onSelect: onStop, disabled: busy || unreachable }
      : { label: 'Start', icon: <Play className="size-4" />, onSelect: onStart, disabled: busy || unreachable || w.status !== 'stopped' },
    // Every pool type in one place, the account pool included (foundation PRD §10).
    // Owner, 2026-10-18 ("where?"): the browser page (Remote, and App mode: an app of this workspace opened inside the portal) was reachable
    // only from a link in Configuration's browser tab.
    { label: 'Browser', icon: <AppWindow className="size-4" />, onSelect: () => navigate(`/admin/workspaces/${w.id}/browser`), disabled: !running },
    { label: 'Configuration…', icon: <SlidersHorizontal className="size-4" />, onSelect: onConfigure, disabled: w.status === 'creating' || unreachable },
    ...(w.delivery?.status === 'frozen' ? [{ label: 'Adopt workspace', icon: <ShieldCheck className="size-4" />, onSelect: onAdopt }] : []),
    { label: 'Remove', icon: <Trash2 className="size-4" />, onSelect: onRemove, danger: true, disabled: w.status === 'creating' || unreachable || !removable },
  ];
  const delivery = w.delivery ? DELIVERY[w.delivery.status] : undefined;
  const account = w.account;
  // Progress while creating or starting, and errors; a running or stopped one needs no words; an unavailable one's reason is in its InfoTip.
  const showDetail = w.status !== 'running' && w.status !== 'stopped' && !note && w.detail;
  // One short line: where and how old, the pool when one is assigned; how busy shows as bars beside it.
  const meta = [
    targetLabel,
    account && (account.state === 'waiting' ? `${account.poolName} · waiting` : account.state === 'removing' ? `removing ${account.poolName}` : account.poolName),
    limits,
    unreachable && w.lastSeenAt ? `Last seen ${timeAgo(w.lastSeenAt)}` : timeAgo(w.createdAt),
  ].filter(Boolean);
  // Running and stopped show in the icon and the action (Shell or Start); other states get a badge.
  const settled = (w.status === 'running' || w.status === 'stopped') && !busy;
  const [open, setOpen] = useState(false);
  // The tab the sheet opens on: Details from the row, Repos from the repositories chip.
  const [tab, setTab] = useState<SheetTab>('details');

  return (
    <li className="flex items-center gap-3 p-4 sm:px-5">
      {/* The icon and text open the details; the buttons beside them keep their own jobs. */}
      {/* While picking for bulk assignment the whole row toggles the selection instead. */}
      <button
        type="button"
        onClick={picking ? onToggle : (e) => (setTab((e.target as HTMLElement).closest(`[${REPOS_CHIP_ATTR}]`) ? 'repos' : 'details'), setOpen(true))}
        role={picking ? 'checkbox' : undefined}
        aria-checked={picking ? !!selected : undefined}
        aria-label={picking ? `Select ${workspaceDisplayName(w)}` : `Details for ${workspaceDisplayName(w)}${reposTab && reposLabel(repos) ? `, ${reposLabel(repos)}` : ''}`}
        className={`press flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left ${picking ? 'select-none' : ''}`}
      >
        {picking ? (
          <span
            className={`flex size-10 shrink-0 items-center justify-center rounded-xl border-2 ${selected ? 'border-primary bg-primary text-primary-ink' : 'border-line-strong text-transparent'}`}
          >
            <Check className="size-5" strokeWidth={3} />
          </span>
        ) : (
          <span
            className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${running ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-soft'}`}
          >
            <Box className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate font-semibold">{workspaceDisplayName(w)}</p>
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
            {reposTab && <ReposChip summary={repos} />}
            <VersionChip claude={w.claude} />
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
      <div className={`flex shrink-0 items-center gap-1 ${picking ? 'hidden' : ''}`}>
        {note && (
          <InfoTip label={`Why ${workspaceDisplayName(w)} is unavailable`} className="sm:mr-1">
            {note}. Start, Stop, Remove and terminals wait until it answers.
          </InfoTip>
        )}
        {running ? (
          <Link
            to={`/admin/workspaces/${w.id}/shell`}
            className={buttonClass('secondary', 'sm')}
            aria-label={`Open shell in ${workspaceDisplayName(w)}`}
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
        <Menu label={`Actions for ${workspaceDisplayName(w)}`} items={items} />
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
        reposTab={reposTab}
        resources={resources}
        initialTab={tab}
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

/**
 * Above the list: "Select" starts picking workspaces for bulk assignment (foundation PRD §10); while
 * picking it counts them and offers "Assign pool…".
 */
function SelectionBar({
  total,
  selected,
  onStart,
  onAll,
  onAssign,
  onCancel,
}: {
  total: number;
  selected: Set<string> | null;
  onStart: () => void;
  onAll: () => void;
  onAssign: () => void;
  onCancel: () => void;
}) {
  if (!selected)
    return (
      <div className="-mb-6 flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">{total === 1 ? '1 workspace' : `${total} workspaces`}</h2>
        <Button variant="ghost" size="sm" icon={<ListChecks className="size-3.5" />} onClick={onStart}>
          Select
        </Button>
      </div>
    );
  return (
    <div className="sticky top-16 z-20 -mx-4 -mb-6 flex items-center gap-2 border-b border-line bg-bg/90 px-4 py-2 backdrop-blur-md sm:top-0 sm:mx-0 sm:rounded-2xl sm:border sm:px-3">
      <p className="min-w-0 flex-1 truncate text-sm font-semibold">{selected.size === 0 ? 'Pick workspaces' : `${selected.size} selected`}</p>
      {selected.size < total && (
        <Button variant="ghost" size="sm" onClick={onAll}>
          All
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" onClick={onAssign} disabled={selected.size === 0}>
        Assign pool…
      </Button>
    </div>
  );
}
