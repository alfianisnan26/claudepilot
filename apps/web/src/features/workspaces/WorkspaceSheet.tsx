import { Badge, Button, buttonClass, cn, Dialog, FormDialog, Segmented, Spinner, TextField, useToast, type BadgeTone, type MenuItem } from '@isnanme/ui';
import { WORKSPACE_LABEL_MAX, workspaceDisplayName, workspaceLabelProblem, type Workspace, type WorkspaceUsage } from '@portal/contracts';
import { Copy, Pencil, Play, Square, SquareTerminal } from 'lucide-react';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { TreeSkeleton } from '@/features/repos';
import { api, errorText } from '@/lib/api';
import { formatBytes, formatDateTime, formatUntil, timeAgo } from '@/lib/format';
import { ClaudesSection } from './ClaudesSection';
import { ResourcesRow } from './ResourcesRow';
import { VersionChip } from '@/features/claudeversion/VersionChip';
import { usageFractions } from './usage';

// The Repos tab (and the repo sheet, the timeline, the dialogs) load when the tab is first opened, not with the page.
const ReposTab = lazy(() => import('@/features/repos/ReposTab').then((m) => ({ default: m.ReposTab })));

export interface SheetBadge {
  label: string;
  tone: BadgeTone;
  busy?: boolean;
}

export type SheetTab = 'details' | 'repos';

/**
 * Everything about one workspace that the row leaves out: a bottom sheet on phones, a dialog on
 * desktop. Start/Stop and the shell sit in the footer; the row menu's other actions are listed.
 */
export function WorkspaceSheet({
  open,
  onClose,
  w,
  status,
  delivery,
  targetLabel,
  usage,
  busy,
  items,
  onStart,
  onStop,
  reposTab,
  resources,
  initialTab,
}: {
  open: boolean;
  onClose: () => void;
  w: Workspace;
  status: SheetBadge;
  delivery?: SheetBadge;
  targetLabel: string;
  usage?: WorkspaceUsage;
  busy: boolean;
  /** The row menu, Start/Stop left out (they're in the footer). */
  items: MenuItem[];
  onStart: () => void;
  onStop: () => void;
  /** Show the Repos tab (not for a Kubernetes workspace: its repositories are not scanned). */
  reposTab?: boolean;
  /** Show the Resources row (a Kubernetes workspace: its CPU and memory can be changed, T-98). */
  resources?: boolean;
  /** The tab it opens on (the row's repositories chip opens Repos). */
  initialTab?: SheetTab;
}) {
  // Details, or the workspace's repositories (workspace-git PRD §16).
  const [tab, setTab] = useState<SheetTab>(initialTab ?? 'details');
  useEffect(() => {
    if (open) setTab(initialTab ?? 'details');
  }, [open, initialTab]);
  const onRepos = !!reposTab && tab === 'repos';
  const toast = useToast();
  const name = workspaceDisplayName(w);
  // Rename (T-42): the label only. The field holds the draft; null while the dialog is closed.
  const [draft, setDraft] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string>();
  const rename = async () => {
    if (draft === null) return;
    const problem = workspaceLabelProblem(draft);
    if (problem) return setDraftError(problem);
    try {
      const done = await api.workspaces.rename(w.id, draft);
      setDraft(null);
      toast(done.label === done.previous ? 'No change' : 'Renamed');
    } catch (e) {
      const details = (e as { details?: { label?: string } }).details;
      setDraftError(details?.label ?? errorText(e, 'Couldn’t rename it.'));
    }
  };
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(w.stableId ?? w.id);
      toast('Copied');
    } catch {
      toast('Couldn’t copy. The browser blocked the clipboard.', 'error');
    }
  };
  const running = w.status === 'running';
  const account = w.account;
  const limits = [w.cpus && `${w.cpus} CPU`, w.memoryMb && formatBytes(w.memoryMb * 1024 * 1024)].filter(Boolean).join(' · ');
  const fractions = usageFractions(usage, w.cpus, w.memoryMb);
  const problem = w.status === 'error' || (w.status !== 'running' && w.status !== 'stopped' && w.detail);

  // The pool, when one is assigned; each Claude's own sign-in is in the Claudes list.
  const pool = account
    ? account.state === 'removing'
      ? `Removing ${account.poolName}…`
      : account.state === 'waiting'
        ? `${account.poolName} · ${account.waitingUntil ? `waiting for quota until ${formatUntil(account.waitingUntil)}` : 'waiting for a usable account'}`
        : `${account.poolName} · ${account.accountName ?? '–'}`
    : null;

  const footer = running ? (
    <>
      <Button variant="secondary" icon={<Square className="size-4" />} loading={busy} onClick={onStop}>
        Stop
      </Button>
      <Link to={`/admin/workspaces/${w.id}/shell`} className={buttonClass('primary')}>
        <SquareTerminal className="size-4" />
        Open shell
      </Link>
    </>
  ) : w.status === 'stopped' ? (
    <Button icon={<Play className="size-4" />} loading={busy} onClick={onStart}>
      Start
    </Button>
  ) : undefined;

  return (
    <>
    <Dialog open={open} onClose={onClose} title={name} description={`${targetLabel} · ${status.label}`} footer={footer}>
      <div className="flex flex-col gap-5">
        {reposTab && (
          <Segmented<SheetTab>
            label="Show"
            value={tab}
            options={[
              { value: 'details', label: 'Details' },
              { value: 'repos', label: 'Repos' },
            ]}
            onChange={setTab}
          />
        )}
        {onRepos ? (
          <Suspense fallback={<TreeSkeleton />}>
            <ReposTab workspace={w} />
          </Suspense>
        ) : (
          <>
        {problem && (
          <Notice badge={status} tone={w.status === 'error' ? 'danger' : 'neutral'}>
            {w.detail}
          </Notice>
        )}
        {delivery && (
          <Notice badge={delivery}>
            {w.delivery?.reason}
            {w.delivery?.status === 'locked' && (
              <Link to="/admin/access" className="mt-1 block font-semibold text-ink underline underline-offset-2">
                Open Access
              </Link>
            )}
          </Notice>
        )}

        {running && (
          <div className="grid grid-cols-2 gap-4 text-[13px] text-muted">
            <Meter
              label="CPU"
              value={
                fractions.cpu === undefined
                  ? usage?.cpuPercent == null
                    ? '–'
                    : `${Math.round(usage.cpuPercent)}%`
                  : `${Math.round(fractions.cpu * 100)}% of ${w.cpus ?? usage?.cores} cores`
              }
              // Out of the CPU limit, or else every core on the host.
              fraction={fractions.cpu}
            />
            <Meter
              label="Memory"
              value={
                usage?.memoryBytes == null
                  ? '–'
                  : w.memoryMb || usage.memoryTotalBytes
                    ? `${formatBytes(usage.memoryBytes)} / ${formatBytes(w.memoryMb ? w.memoryMb * 1024 * 1024 : usage.memoryTotalBytes!)}`
                    : formatBytes(usage.memoryBytes)
              }
              fraction={fractions.memory}
            />
          </div>
        )}

        {running && <ClaudesSection workspace={w} onLeave={onClose} />}

        <dl className="divide-y divide-line rounded-2xl border border-line text-sm">
          <Row
            label={
              <span className="inline-flex items-center gap-1">
                Name
                <InfoTip label="About renaming">Renaming changes only the name shown. Nothing running is touched: its container or pod, its files and its sessions stay as they are, and the old name keeps working.</InfoTip>
              </span>
            }
          >
            <span className="inline-flex min-w-0 items-center justify-end gap-1">
              <span className="min-w-0 truncate">{name}</span>
              <button
                type="button"
                aria-label={`Rename ${name}`}
                title="Rename"
                onClick={() => (setDraft(name), setDraftError(undefined))}
                className="press -my-2 -mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink"
              >
                <Pencil className="size-4" />
              </button>
            </span>
          </Row>
          {w.stableId && (
            <Row label="ID">
              <span className="inline-flex min-w-0 items-center justify-end gap-1">
                <span className="min-w-0 truncate font-mono text-[12.5px]" title={`${w.stableId} · ${w.id}`}>
                  {w.stableId}
                </span>
                <button
                  type="button"
                  aria-label="Copy the ID"
                  title="Copy"
                  onClick={() => void copyId()}
                  className="press -my-2 -mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink"
                >
                  <Copy className="size-4" />
                </button>
              </span>
            </Row>
          )}
          {resources && <ResourcesRow w={w} open={open} />}
          <Row label="Runs on">{targetLabel}</Row>
          {w.node && <Row label="Node">{w.node}</Row>}
          {w.status === 'unreachable' && w.lastSeenAt && (
            <Row label="Last seen">
              <span title={formatDateTime(w.lastSeenAt)}>{timeAgo(w.lastSeenAt)}</span>
            </Row>
          )}
          {w.claude && (
            <Row label="Claude Code">
              <VersionChip claude={w.claude} />
            </Row>
          )}
          <Row label="Created">
            <span title={formatDateTime(w.createdAt)}>{timeAgo(w.createdAt)}</span>
          </Row>
          <Row label="Limits">{limits || 'None'}</Row>
          {pool && <Row label="Account pool">{pool}</Row>}
          {w.delivery?.appliedAt && <Row label="Delivered">{timeAgo(w.delivery.appliedAt)}</Row>}
          {w.image && w.target !== 'local' && <Row label="Image">{w.image}</Row>}
        </dl>

        {items.length > 0 && (
          <ul className="-mx-2 flex flex-col">
            {items.map((item) => (
              <li key={item.label}>
                <button
                  type="button"
                  disabled={item.disabled}
                  onClick={() => {
                    onClose();
                    item.onSelect();
                  }}
                  className={cn(
                    'press flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left text-sm font-medium hover:bg-surface-2 disabled:opacity-40',
                    item.danger ? 'text-danger' : 'text-ink',
                  )}
                >
                  <span className={cn('shrink-0', item.danger ? 'text-danger' : 'text-muted')}>{item.icon}</span>
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        )}
          </>
        )}
      </div>
    </Dialog>
    <FormDialog open={draft !== null} onClose={() => setDraft(null)} size="sm" title="Rename" onSubmit={rename} submitLabel="Save">
      <TextField
        label="Name"
        maxLength={WORKSPACE_LABEL_MAX}
        autoComplete="off"
        value={draft ?? ''}
        onChange={(e) => (setDraft(e.target.value), setDraftError(undefined))}
        error={draftError}
      />
    </FormDialog>
    </>
  );
}

function Notice({ badge, tone, children }: { badge: SheetBadge; tone?: BadgeTone; children?: ReactNode }) {
  return (
    <div className={cn('rounded-2xl p-3.5 text-sm', (tone ?? badge.tone) === 'danger' ? 'bg-danger-soft' : 'bg-surface-2')}>
      <Badge tone={badge.tone}>
        {badge.busy && <Spinner className="size-3" />}
        {badge.label}
      </Badge>
      {children && <div className="mt-2 text-ink-soft">{children}</div>}
    </div>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-3.5 py-2.5">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{children}</dd>
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
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
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
