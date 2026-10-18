import type { ChatSession } from '@portal/contracts';
import { cn } from '@isnanme/ui';
import { MessagesSquare } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { useChatList } from './useChatSocket';

const DOT: Record<string, string> = { working: 'bg-accent', waiting: 'bg-flame', idle: 'bg-muted', interrupted: 'bg-danger' };

/**
 * The session list beside a session (owner, 2026-10-17: "add right sidebar on session chat to navigate between sessions"; T-947): the live
 * sessions, the ones waiting for you first, then the newest activity; the open one is marked. Wide screens only; a phone keeps Back.
 */
export function SessionsSidebar({ currentId }: { currentId: string }) {
  const { sessions } = useChatList();
  const live = useMemo(() => {
    const list = (sessions ?? []).filter((s: ChatSession) => s.state !== 'ended');
    const rank = (s: ChatSession) => (s.waiting ? 0 : s.state === 'working' ? 1 : 2);
    return list.sort((a, b) => rank(a) - rank(b) || (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  }, [sessions]);
  return (
    <nav aria-label="Sessions" data-sessions-sidebar="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[60px] shrink-0 items-center gap-2 px-4">
        <MessagesSquare className="size-4 text-muted" aria-hidden="true" />
        <Link to="/admin/sessions" className="text-[13px] font-semibold text-muted hover:text-ink">
          Sessions
        </Link>
        <span className="text-[12px] text-muted tabular-nums">{live.length}</span>
      </div>
      {sessions === null ? (
        <div className="skeleton mx-3 h-10 rounded-xl" />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-[var(--safe-bottom)]">
          {live.map((s) => (
            <li key={s.id}>
              <Link
                to={`/admin/sessions/${s.id}`}
                aria-current={s.id === currentId ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 items-center gap-2.5 rounded-xl px-2.5 py-1.5 hover:bg-surface-2',
                  s.id === currentId && 'bg-accent-soft hover:bg-accent-soft',
                )}
              >
                <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', s.waiting ? 'bg-flame' : (DOT[s.state] ?? 'bg-muted'))} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium" title={s.title}>
                    {s.title}
                  </span>
                  <span className="block truncate text-[11.5px] text-muted">
                    {s.waiting ? `Needs you · ${s.waiting}` : s.state}
                    {s.workspaceId ? ` · ${s.workspaceId.split('/')[1]}` : ''}
                  </span>
                </span>
              </Link>
            </li>
          ))}
          {live.length === 0 && <li className="px-2.5 py-3 text-sm text-muted">No live sessions.</li>}
        </ul>
      )}
    </nav>
  );
}
