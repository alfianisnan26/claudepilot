import { Badge } from '@isnanme/ui';
import type { ChatSession } from '@portal/contracts';
import { IdCard } from 'lucide-react';
import { roleOf } from './crewLimits';

/**
 * The role a session runs as (T-294, `ChatSession.agent`: `claude --agent <name>`), as a small badge: an icon and the name, cut short with
 * the full name in its tip. Nothing when it runs as Claude Code's default.
 */
export function RoleBadge({ session }: { session: Pick<ChatSession, 'agent'> }) {
  const role = roleOf(session);
  if (!role) return null;
  return (
    <span title={`Role: ${role}`} data-role-badge="" className="inline-flex max-w-full min-w-0">
      <Badge className="max-w-full min-w-0">
        <IdCard className="size-3 shrink-0" aria-hidden="true" />
        <span className="sr-only">Role </span>
        <span className="min-w-0 truncate">{role}</span>
      </Badge>
    </span>
  );
}

/**
 * The role in the session header: the badge from 640 px; on a phone its icon alone (the title keeps its room). Either opens Session info,
 * which names it in full, like Keep going's chip; a 44 px target.
 */
export function RoleChip({ session, onOpen }: { session: ChatSession | null | undefined; onOpen: () => void }) {
  const role = roleOf(session);
  if (!role) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`Role: ${role}, session info`}
      title={`Role: ${role}`}
      data-role-chip=""
      className="press inline-flex size-11 min-w-0 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-ink/[0.07] sm:w-auto sm:max-w-40 sm:px-1 sm:hover:bg-transparent"
    >
      <IdCard className="size-[18px] sm:hidden" aria-hidden="true" />
      <span className="hidden max-w-full min-w-0 sm:inline-flex">
        <Badge className="max-w-full min-w-0">
          <IdCard className="size-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{role}</span>
        </Badge>
      </span>
    </button>
  );
}
