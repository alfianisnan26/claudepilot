import { Badge, cn } from '@isnanme/ui';
import {
  TICKET_PRIORITY_LABEL,
  TICKET_STATUS_LABEL,
  TICKET_TYPE_LABEL,
  type TicketCheck,
  type TicketCheckState,
  type TicketItem,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
} from '@portal/contracts';
import { Ban, Bot, ChevronDown, ChevronsUp, ChevronUp, CircleCheck, CircleX, Clock, GitBranch, Loader2, Minus, User, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { timeAgo } from '@/lib/format';
import { ORPHAN_BADGE, PRIORITY_TONE, SESSION_STATE_LABEL, STATUS_TONE, TYPE_TONE, ageShort } from './labels';

/** Shape and colour, not colour alone (tickets PRD §13): chevrons up for urgent and high, a dash for normal, down for low. */
export function PriorityMark({ priority, className }: { priority: TicketPriority; className?: string }) {
  const Icon = { urgent: ChevronsUp, high: ChevronUp, normal: Minus, low: ChevronDown }[priority];
  const tone = { urgent: 'text-danger', high: 'text-gold', normal: 'text-muted', low: 'text-muted' }[priority];
  return (
    <span title={`${TICKET_PRIORITY_LABEL[priority]} priority`} className={cn('inline-flex size-5 shrink-0 items-center justify-center', tone, className)}>
      <Icon className="size-[18px]" aria-hidden="true" />
      <span className="sr-only">{TICKET_PRIORITY_LABEL[priority]} priority</span>
    </span>
  );
}

export const StatusBadge = ({ status }: { status: TicketStatus }) => <Badge tone={STATUS_TONE[status]}>{TICKET_STATUS_LABEL[status]}</Badge>;
export const TypeBadge = ({ type }: { type: TicketType }) => <Badge tone={TYPE_TONE[type]}>{TICKET_TYPE_LABEL[type]}</Badge>;

export function TagList({ tags, className }: { tags: string[]; className?: string }) {
  if (!tags.length) return null;
  return (
    <span className={cn('inline-flex flex-wrap gap-1', className)}>
      {tags.map((t) => (
        <span key={t} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11.5px] font-medium text-ink-soft">
          {t}
        </span>
      ))}
    </span>
  );
}

/** Who has it: a session (with its state), a person, or the agents' queue. */
export function AssigneeChip({ ticket: t }: { ticket: TicketItem }) {
  if (!t.assignee)
    return (
      <span className="inline-flex items-center gap-1 text-[12.5px] text-muted">
        <Bot className="size-3.5" aria-hidden="true" />
        Unassigned
      </span>
    );
  if (t.assignee.kind === 'user')
    return (
      <span className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-gold">
        <User className="size-3.5" aria-hidden="true" />
        {t.assignee.name === 'admin' ? 'You' : t.assignee.name}
      </span>
    );
  const s = t.assigneeSession;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-[12.5px] text-ink-soft">
      <Bot className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{s ? s.title : 'Session gone'}</span>
      {s && <span className="shrink-0 text-muted">· {SESSION_STATE_LABEL[s.state]}</span>}
    </span>
  );
}

/** The flags a row carries: waiting for a person, its session ended, a worktree. */
export function TicketFlags({ ticket: t }: { ticket: TicketItem }) {
  return (
    <>
      {t.assignee?.kind === 'user' && t.status !== 'done' && t.status !== 'wont_do' && <Badge tone="warning">Needs you</Badge>}
      {t.orphan ? <Badge tone="danger">{ORPHAN_BADGE[t.orphan.why]}</Badge> : t.sessionEnded && <Badge tone="danger">Session ended</Badge>}
      {t.worktree && (
        <span className="inline-flex items-center gap-1 text-[12px] text-muted" title={t.worktree.path}>
          <GitBranch className="size-3.5" aria-hidden="true" />
          {t.worktree.branch}
        </span>
      )}
    </>
  );
}

export { ageShort };

const CHECK_LOOK: Record<TicketCheckState, { Icon: LucideIcon; tone: string }> = {
  queued: { Icon: Clock, tone: 'text-muted' },
  running: { Icon: Loader2, tone: 'text-gold' },
  passed: { Icon: CircleCheck, tone: 'text-accent' },
  failed: { Icon: CircleX, tone: 'text-danger' },
  cancelled: { Icon: Ban, tone: 'text-muted' },
};

/** What CI says about the ticket: one chip per pipeline with its latest state; a tap opens the run (in the app, or the address it gave). */
export function CheckChips({ checks }: { checks: TicketCheck[] }) {
  if (!checks.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Checks">
      {checks.map((c) => {
        const { Icon, tone } = CHECK_LOOK[c.state];
        const title = `${c.name}: ${c.state}${c.commit ? ` · ${c.commit.slice(0, 7)}` : ''} · ${timeAgo(c.updatedAt)}`;
        const body = (
          <>
            <Icon className={cn('size-3.5', tone, c.state === 'running' && 'motion-safe:animate-spin')} aria-hidden="true" />
            {c.name}
            <span className="sr-only">{c.state}</span>
          </>
        );
        const cls = 'inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[12.5px] font-semibold text-ink-soft';
        return (
          <li key={c.name}>
            {!c.link ? (
              <span className={cls} title={title}>
                {body}
              </span>
            ) : c.link.startsWith('/') ? (
              <Link to={c.link} className={cn(cls, 'hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none')} title={title}>
                {body}
              </Link>
            ) : (
              <a href={c.link} target="_blank" rel="noreferrer noopener" className={cn(cls, 'hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none')} title={title}>
                {body}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
