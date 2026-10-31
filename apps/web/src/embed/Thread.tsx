import type { ReporterTicketComment } from '@portal/contracts';
import { memo, useMemo, useRef, useState, type ReactNode } from 'react';
import { THREAD_FIRST, THREAD_STEP, groupComments, needsClamp, relTime, type CommentGroup } from './chatModel';
import { useBottomList } from './hooks';
import { Icon } from './icons';
import { Md } from './markdown';

/**
 * A ticket's comments, compact (owner, 2026-10-31): author and relative time on one line, consecutive comments by one author grouped, a long
 * body clamped to four lines with "more", an agent marked by a small icon and a tint, newest at the bottom with "jump to latest", older
 * groups revealed on scroll up. Each body is parsed once (memoised by its text), not on every update.
 */
export function Thread({ comments, className = '', header, footer, startAtTop = false, jumpRef }: { comments: ReporterTicketComment[] | null; className?: string; header?: ReactNode; footer?: ReactNode; startAtTop?: boolean; jumpRef?: { current: (() => void) | null } }) {
  const groups = useMemo(() => groupComments(comments ?? []), [comments]);
  const [shown, setShown] = useState(THREAD_FIRST);
  const ref = useRef<HTMLDivElement>(null);
  const start = Math.max(0, groups.length - shown);
  const { atBottom, jump, older } = useBottomList(
    ref,
    groups.length - start + (comments?.length ?? 0),
    () => {
      // Older groups only when the thread itself is at the top (a card's header above it scrolls first).
      if (start === 0 || header) return;
      older();
      setShown((n) => n + THREAD_STEP);
    },
    { startAtTop },
  );
  if (jumpRef) jumpRef.current = jump;
  return (
    <div ref={ref} className={`relative min-h-0 overflow-y-auto overscroll-contain ${className}`}>
      {header}
      {start > 0 &&
        (header ? (
          <button type="button" onClick={() => setShown((n) => n + THREAD_STEP)} className="mx-auto flex min-h-11 items-center text-[12.5px] font-semibold text-accent">
            Older comments
          </button>
        ) : (
          <p className="py-2 text-center text-[12px] text-muted">Scroll up for older</p>
        ))}
      {comments === null && <div className="skeleton h-16 rounded-xl" aria-busy="true" />}
      {comments && !groups.length && <p className="py-6 text-center text-[13px] text-muted">No comments yet.</p>}
      <ol className="flex flex-col gap-2.5 py-1">
        {groups.slice(start).map((g) => (
          <Group key={g.id} g={g} />
        ))}
      </ol>
      {footer}
      {!atBottom && groups.length > 0 && (
        <button
          type="button"
          onClick={jump}
          className="sticky bottom-2 mx-auto mt-1 flex min-h-11 items-center gap-1 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-ink shadow-md focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
        >
          <Icon name="arrowDown" className="size-4" />
          Latest
        </button>
      )}
    </div>
  );
}

const Group = memo(function Group({ g }: { g: CommentGroup }) {
  const agent = g.authorKind === 'agent';
  const mine = g.authorKind === 'reporter';
  return (
    <li className={`rounded-xl px-2.5 py-1.5 ${agent ? 'border-l-2 border-accent bg-surface-2/60' : mine ? 'bg-accent-soft/60' : ''}`}>
      <p className="flex min-w-0 items-center gap-1 text-[12px] text-muted">
        {agent && <Icon name="bot" className="size-3.5 shrink-0 text-accent" />}
        <span className="min-w-0 truncate font-semibold text-ink-soft">{g.author}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={g.createdAt} title={g.createdAt} className="shrink-0 tabular-nums">
          {relTime(g.createdAt)}
        </time>
      </p>
      <div className="flex flex-col gap-1.5">
        {g.items.map((c) => (
          <Body key={c.id} body={c.body} />
        ))}
      </div>
    </li>
  );
});

const Body = memo(function Body({ body }: { body: string }) {
  const long = needsClamp(body);
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[13.5px]">
      <div className={long && !open ? 'max-h-[5.25rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]' : ''}>
        <Md text={body} />
      </div>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="min-h-11 min-w-11 text-left text-[12.5px] font-semibold text-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden">
          {open ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
});
