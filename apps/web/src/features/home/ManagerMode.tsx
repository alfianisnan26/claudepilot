import { cn } from '@isnanme/ui';
import type { ChatSession } from '@portal/contracts';
import { Bot, LayoutDashboard } from 'lucide-react';
import { lazy, Suspense, useMemo } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { useChatList } from '@/features/chat/useChatSocket';

const SessionPage = lazy(() => import('@/features/chat/SessionPage').then((m) => ({ default: m.SessionPage })));

export type HomeMode = 'dashboard' | 'manager';
const MODE_KEY = 'home.mode';
const MANAGER_KEY = 'home.managerSession';

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    // storage unavailable: the choice lasts this page only
  }
};

export const readHomeMode = (): HomeMode => (read(MODE_KEY) === 'manager' ? 'manager' : 'dashboard');
export const saveHomeMode = (m: HomeMode) => write(MODE_KEY, m);
export const readManagerSession = (): string | null => read(MANAGER_KEY);
export const saveManagerSession = (id: string | null) => write(MANAGER_KEY, id);

/** The Dashboard | Manager switch (D-80, T-968 S3): icon-only on a phone, 44 px. */
export function HomeModeSwitch({ mode, onMode }: { mode: HomeMode; onMode: (m: HomeMode) => void }) {
  return (
    <div role="group" aria-label="Home mode" className="flex rounded-full border border-line p-0.5">
      {(
        [
          ['dashboard', 'Dashboard', LayoutDashboard],
          ['manager', 'Manager', Bot],
        ] as const
      ).map(([m, label, Icon]) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          aria-label={label}
          onClick={() => onMode(m)}
          className={cn('press flex min-h-10 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold', mode === m ? 'bg-ink text-bg' : 'text-ink-soft hover:text-ink')}
        >
          <Icon className="size-4" aria-hidden="true" />
          <span className="max-sm:sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Manager mode (owner, 2026-10-18: "implement the general manager session on home"; D-80, T-968 S3): the manager chat at full height, the
 * session chat itself, Back returns to the dashboard. Until the portal makes the dedicated manager session (T-968 S1 and S4, being built),
 * the person picks which of their sessions acts as their manager here; that grants nothing new (it is their own session, shown on Home).
 */
export function ManagerMode({ sessionId, onPick, onBack }: { sessionId: string | null; onPick: (id: string | null) => void; onBack: () => void }) {
  const { sessions } = useChatList();
  const live = useMemo(
    () =>
      (sessions ?? [])
        .filter((s: ChatSession) => s.state !== 'ended')
        .sort((a, b) => Number(/manager|orchestrator|lead/i.test(b.title)) - Number(/manager|orchestrator|lead/i.test(a.title)) || (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '')),
    [sessions],
  );
  const chosen = sessionId && sessions?.some((s) => s.id === sessionId && s.state !== 'ended') ? sessionId : null;
  if (chosen)
    return (
      <Suspense fallback={<div className="skeleton h-28 rounded-[24px]" />}>
        <SessionPage sessionId={chosen} onBack={onBack} />
      </Suspense>
    );
  return (
    <Card className="p-4 sm:p-5" data-manager-pick="">
      <h2 className="mb-1 flex items-center gap-1 text-[15px] font-semibold">
        Choose your manager
        <InfoTip label="About the manager">
          The General Manager is the one chat you talk to for the whole pilot: crews, tickets, CI and deploys. Its own session, which works only
          through the portal’s tools, is being built (T-968). Until it is live, pick the session that manages for you, such as an orchestrator.
        </InfoTip>
      </h2>
      {sessions === null ? (
        <div className="skeleton mt-2 h-10 rounded-xl" />
      ) : live.length === 0 ? (
        <p className="text-sm text-muted">No live session yet. Start one under Sessions.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {live.slice(0, 12).map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => onPick(s.id)} className="press flex min-h-12 w-full items-center gap-3 py-2 text-left hover:text-accent">
                <Bot className="size-4 shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium [overflow-wrap:anywhere]">{s.title}</span>
                  <span className="block text-[12.5px] text-muted">
                    {s.state}
                    {s.workspaceId ? ` · ${s.workspaceId.split('/')[1]}` : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
