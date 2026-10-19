import { Button, buttonClass, cn } from '@isnanme/ui';
import type { Workspace } from '@portal/contracts';
import { Box, Layers, Play, SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

/** Why a workspace can't host a session, and the way out (chat PRD FR1 and §11's state table). */
function wayOut(w: Workspace): { reason: string; to?: { label: string; href: string }; start?: boolean; shell: boolean } {
  const shell = w.status === 'running';
  if (w.status === 'stopped') return { reason: 'Stopped', start: true, shell };
  if (w.status !== 'running') return { reason: w.status === 'error' ? 'Error' : 'Not ready yet', shell };
  if (!w.account) return { reason: 'Ready', shell }; // runs on its Claudes' own sign-in
  if (w.account.state === 'removing') return { reason: 'Pool change in progress', shell };
  if (w.account.state === 'waiting') return { reason: 'Pool has no usable key', to: { label: 'Accounts', href: '/admin/accounts' }, shell };
  if (w.delivery?.status === 'locked') return { reason: 'Keys locked', to: { label: 'Access', href: '/admin/access' }, shell };
  return { reason: 'Delivery not up to date', shell };
}

const shellHref = (w: Workspace) => `/admin/workspaces/${w.id}/shell`;

/**
 * No workspace can host a session (US8): each one says why, with its way out, Start, Accounts or
 * Open shell. A running workspace without a pool can always host one, on a Claude's own sign-in (§6),
 * so what's listed here is stopped, or waiting on its pool.
 */
export function NoSessionWorkspace({
  workspaces,
  onStart,
  onLeave,
}: {
  workspaces: Workspace[];
  onStart: (w: Workspace) => Promise<void>;
  /** Closes the dialog before a link takes the person elsewhere. */
  onLeave: () => void;
}) {
  const [starting, setStarting] = useState<string | null>(null);
  const shown = [...workspaces].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));

  if (shown.length === 0)
    return (
      <p className="text-sm text-muted">
        Start a workspace first.{' '}
        <Link to="/admin/workspaces" onClick={onLeave} className="font-semibold text-ink underline underline-offset-2">
          Workspaces
        </Link>
      </p>
    );

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line">
        {shown.map((w) => {
          const way = wayOut(w);
          return (
            <li key={w.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <span
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-lg',
                  w.status === 'running' ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-soft',
                )}
              >
                <Box className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{w.name}</p>
                <p className="truncate text-[12.5px] text-muted">{way.reason}</p>
              </div>
              {way.start && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Play className="size-4" />}
                  loading={starting === w.id}
                  onClick={() => {
                    setStarting(w.id);
                    void onStart(w).finally(() => setStarting(null));
                  }}
                >
                  Start
                </Button>
              )}
              {way.to && (
                <Link to={way.to.href} onClick={onLeave} className={buttonClass('ghost', 'sm')}>
                  {way.to.label === 'Assign' && <Layers className="size-4" />}
                  {way.to.label}
                </Link>
              )}
              {way.shell && (
                <Link to={shellHref(w)} onClick={onLeave} className={buttonClass('secondary', 'sm')} aria-label={`Open shell in ${w.name}`}>
                  <SquareTerminal className="size-4" />
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-[13px] text-muted">
        Agents run on a Claude’s own sign-in, or on the workspace’s account pool.
      </p>
    </div>
  );
}

/** Where the main button goes when no workspace can host a session: the first running one's shell. */
export function firstShell(workspaces: Workspace[]): string | null {
  const running = workspaces.find((w) => w.status === 'running');
  return running ? shellHref(running) : null;
}
