import { cn, Spinner } from '@isnanme/ui';
import type { AccountPool, AccountsOverview, Workspace } from '@portal/contracts';
import { Check, KeyRound, Layers, Lock, Send, SquareTerminal } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';

/** One thing a session needs; `go` is what the dialog's main button does for it. */
export interface SetupStep {
  id: string;
  label: string;
  icon: ReactNode;
  done: boolean;
  /** Shown under the next step only: what's in the way, briefly. */
  hint?: string;
  go?: { label: string; to?: string; run?: () => Promise<void> };
}

/**
 * What stands between this portal and a first session, in order (sessions run only on an account
 * pool's keys, chat PRD §6 rule 1): encryption on, a key, a pool, a running workspace, the pool
 * assigned to it, and its delivery landed. Loaded only while the dialog needs it.
 */
export function useSessionSetup(active: boolean, workspaces: Workspace[] | null, reloadWorkspaces: () => Promise<void>) {
  const [overview, setOverview] = useState<AccountsOverview | null>(null);
  const [pools, setPools] = useState<AccountPool[] | null>(null);

  useEffect(() => {
    if (!active) return;
    let current = true;
    Promise.all([api.accounts.overview(), api.accounts.pools()]).then(
      ([o, p]) => current && (setOverview(o), setPools(p)),
      () => current && (setOverview(null), setPools([])),
    );
    return () => {
      current = false;
    };
  }, [active]);

  if (!active || !workspaces || !pools) return { loading: active, steps: [] as SetupStep[], next: undefined };

  const usable = (overview?.accounts ?? []).filter((a) => a.enabled && a.hasSecret);
  const poolWithKey = pools.find((p) => p.members.some((m) => m.enabled && usable.some((a) => a.id === m.accountId)));
  const running = workspaces.filter((w) => w.status === 'running');
  const stopped = workspaces.find((w) => w.status === 'stopped');
  const assigned = running.find((w) => w.account && w.account.state !== 'removing');

  const steps: SetupStep[] = [
    {
      id: 'unlock',
      label: 'Encryption on',
      icon: <Lock className="size-4" />,
      done: !!overview && !overview.locked,
      hint: overview?.locked ? 'Keys can’t be stored until it is.' : undefined,
      go: { label: 'Set up encryption', to: '/admin/access' },
    },
    {
      id: 'key',
      label: 'An API key',
      icon: <KeyRound className="size-4" />,
      done: usable.length > 0,
      go: { label: 'Add a key', to: '/admin/accounts' },
    },
    {
      id: 'pool',
      label: 'A pool with that key',
      icon: <Layers className="size-4" />,
      done: !!poolWithKey,
      go: { label: 'Make a pool', to: '/admin/accounts' },
    },
    {
      id: 'running',
      label: 'A running workspace',
      icon: <SquareTerminal className="size-4" />,
      done: running.length > 0,
      go: stopped
        ? {
            label: `Start ${stopped.name}`,
            run: async () => {
              await api.workspaces.start(stopped.id);
              await reloadWorkspaces();
            },
          }
        : { label: 'Create a workspace', to: '/admin/workspaces' },
    },
    {
      id: 'assign',
      label: 'The pool on that workspace',
      icon: <Layers className="size-4" />,
      done: !!assigned,
      hint: running.length ? `Workspaces → ${running[0]!.name} → Account pool.` : undefined,
      go: { label: 'Assign the pool', to: '/admin/workspaces' },
    },
    {
      id: 'delivered',
      label: 'Keys delivered',
      icon: <Send className="size-4" />,
      done: false,
      hint:
        assigned?.account?.state === 'waiting'
          ? 'The pool has no usable key right now.'
          : (assigned?.delivery?.reason ?? 'Usually takes a few seconds after assigning.'),
    },
  ];
  return { loading: false, steps, next: steps.find((s) => !s.done) };
}

/** The steps as a checklist: done ones ticked, the next one highlighted, the rest dimmed. */
export function SessionSetup({ steps, next, loading }: { steps: SetupStep[]; next?: SetupStep; loading: boolean }) {
  if (loading)
    return (
      <p className="flex items-center gap-2 text-sm text-muted" aria-busy="true">
        <Spinner className="size-4" /> Checking what’s set up…
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-1">
        {steps.map((s, i) => {
          const isNext = s === next;
          return (
            <li
              key={s.id}
              className={cn(
                'flex items-center gap-3 rounded-xl px-3 py-2 text-sm',
                isNext && 'bg-surface-2',
                !s.done && !isNext && 'opacity-45',
              )}
            >
              <span
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full',
                  s.done ? 'bg-accent-soft text-accent' : isNext ? 'bg-ink text-bg' : 'bg-surface-2 text-muted',
                )}
                aria-hidden="true"
              >
                {s.done ? <Check className="size-4" /> : s.icon}
              </span>
              <div className="min-w-0">
                <p className={cn('font-medium', s.done && 'text-muted')}>
                  <span className="sr-only">{s.done ? 'Done: ' : isNext ? 'Next: ' : `Step ${i + 1}: `}</span>
                  {s.label}
                </p>
                {isNext && s.hint && <p className="text-[13px] text-muted">{s.hint}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted">Sessions use a pool’s API keys. Your own Claude sign-in works in the workspace’s shell.</p>
    </div>
  );
}
