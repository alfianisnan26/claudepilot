import { cn } from '@isnanme/ui';
import { BTW_REASON_TEXT, type ChatBtw } from '@portal/contracts';
import { Pin, RotateCcw, Square, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { Markdown } from '../Markdown';
import './btw.css';
import { shortCount } from './state';

export type BtwVariant = 'card' | 'panel' | 'sheet';

/** The card's buttons: 36 px, 44 px on touch screens. */
const BTN = 'press inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-[13px] font-semibold select-none tap:h-11 tap:min-w-11 disabled:pointer-events-none disabled:opacity-40';
const GHOST = 'text-ink-soft hover:bg-surface-2 hover:text-ink';

/** What the estimate says, kept short; the InfoTip carries the explanation. */
export function estimateText(btw: ChatBtw): string | null {
  const u = btw.usage;
  if (!u) return null;
  const tokens = u.input + u.output;
  const cost = u.costUsd == null ? '' : ` · ≈ $${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(3)}`;
  return `≈ ${shortCount(tokens)} tokens${cost}`;
}

/** The seconds left of a retry wait, counting down. */
function useCountdown(ms: number | undefined, since: string | undefined): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!ms) return setLeft(0);
    const end = (since ? Date.parse(since) : Date.now()) + ms;
    const tick = () => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [ms, since]);
  return left;
}

/**
 * One side question: the question on one line (clamped; opens whole when it is cut), the answer in its own scroll area (a polite live region),
 * and Pin / Ask again / Close. Its height does not follow the answer (a streaming answer must never move the composer or the transcript):
 * the body keeps a fixed size and scrolls. The same card sits above the composer, in the side panel and in the phone sheet.
 */
export function BtwCard({
  ref,
  btw,
  variant,
  pinned,
  onClose,
  onAskAgain,
  onCancel,
  onPin,
  extra,
}: {
  ref?: Ref<HTMLElement>;
  btw: ChatBtw;
  variant: BtwVariant;
  pinned: boolean;
  onClose: () => void;
  onAskAgain: () => void;
  onCancel: () => void;
  onPin: () => void;
  /** Header buttons that depend on where the card is (expand to the side panel, back to the card). */
  extra?: ReactNode;
}) {
  const running = btw.status === 'running';
  const waitLeft = useCountdown(btw.retryAfterMs, btw.settledAt);
  const [asked, setAsked] = useState(false);
  const [cut, setCut] = useState(false);
  const [wholeQuestion, setWholeQuestion] = useState(false);
  const line = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = line.current;
    if (!el) return;
    const measure = () => setCut(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [btw.question, cut, wholeQuestion]);

  // The answer follows its own end while it streams, until the reader scrolls up in it.
  useLayoutEffect(() => {
    const el = body.current;
    if (el && running && stick.current) el.scrollTop = el.scrollHeight;
  }, [btw.answer, running]);
  useEffect(() => {
    stick.current = true;
    setWholeQuestion(false);
    setAsked(false);
  }, [btw.id]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.stopPropagation();
    onClose();
  };

  const estimate = estimateText(btw);
  const reason = btw.status === 'failed' ? (btw.reason ? BTW_REASON_TEXT[btw.reason] : BTW_REASON_TEXT.error) : null;
  const wait = waitLeft > 0 ? `Try again in ${waitLeft} s.` : null;
  const question = (
    <>
      <span className="shrink-0 text-[12px] font-semibold text-muted">btw</span>
      {cut || wholeQuestion ? (
        <button
          type="button"
          ref={line as React.RefObject<HTMLButtonElement>}
          aria-expanded={wholeQuestion}
          aria-label={`Question: ${btw.question}`}
          title={btw.question}
          onClick={() => setWholeQuestion((v) => !v)}
          className="min-w-0 flex-1 truncate rounded-md text-left text-[14px] font-semibold text-ink"
        >
          {btw.question}
        </button>
      ) : (
        <p ref={line as React.RefObject<HTMLParagraphElement>} title={btw.question} className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">
          {btw.question}
        </p>
      )}
    </>
  );

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label="btw"
      data-btw={variant}
      onKeyDown={onKey}
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden border border-line bg-surface outline-hidden focus-visible:ring-2 focus-visible:ring-accent',
        variant === 'card' && 'btw-rise rounded-2xl',
        variant === 'panel' && 'h-full border-0',
        variant === 'sheet' && 'h-full border-0',
      )}
    >
      <header className="flex min-h-11 items-center gap-1.5 pr-1.5 pl-3.5">
        {question}
        {extra}
        <button type="button" aria-label="Close btw" title="Close" onClick={onClose} className={cn(BTN, GHOST, 'w-9 px-0 tap:w-11')}>
          <X className="size-[18px]" aria-hidden="true" />
        </button>
      </header>
      <div
        ref={body}
        aria-live="polite"
        aria-busy={running}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        // A fixed size in the card, so a streaming answer never changes the card's height; the panel and the sheet fill what they are given.
        className={cn(
          'min-h-0 min-w-0 overflow-y-auto overscroll-contain px-3.5 pb-1 [overflow-wrap:anywhere]',
          variant === 'card' ? 'h-[clamp(4.5rem,18vh,9rem)]' : 'flex-1',
        )}
      >
        {wholeQuestion && <p className="mb-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[13px] whitespace-pre-wrap text-ink-soft">{btw.question}</p>}
        {reason ? (
          <p className="text-[14px] text-ink-soft">
            {reason}
            {(btw.note || wait) && <span className="text-muted"> {[btw.note, wait].filter(Boolean).join(' ')}</span>}
          </p>
        ) : running && !btw.answer ? (
          <div role="status" aria-label="Answering" className="space-y-2 pt-1">
            <div className="h-3 w-11/12 rounded bg-surface-2 motion-safe:animate-pulse" />
            <div className="h-3 w-9/12 rounded bg-surface-2 motion-safe:animate-pulse" />
            <div className="h-3 w-6/12 rounded bg-surface-2 motion-safe:animate-pulse" />
          </div>
        ) : btw.status === 'cancelled' && !btw.answer ? (
          <p className="text-[14px] text-muted">Stopped.</p>
        ) : (
          <>
            <Markdown text={btw.answer} className="text-[14px] leading-relaxed text-ink [&_pre]:max-w-full [&_pre]:overflow-x-auto" />
            {btw.status === 'cancelled' && <p className="pt-1 text-[12.5px] text-muted">Stopped.</p>}
          </>
        )}
      </div>
      <footer className="flex min-h-11 items-center gap-1 pr-1.5 pl-3.5">
        <span className="flex min-w-0 flex-1 items-center gap-1 text-[12px] text-muted">
          <span className="min-w-0 truncate">{estimate ?? (running ? 'Answering…' : '')}</span>
          <InfoTip label="About this answer">
            Estimates, not the bill. Answered from {btw.context ? `the last ${btw.context.messages} messages of this chat` : 'this chat up to now'}
            {btw.context?.truncated ? ' (older ones left out)' : ''}, with no tools. Nothing is added to the chat unless you pin it.
          </InfoTip>
        </span>
        {running ? (
          <button type="button" onClick={onCancel} className={cn(BTN, GHOST)}>
            <Square className="size-3.5 fill-current" aria-hidden="true" />
            Stop
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={btw.status !== 'answered' || pinned}
              aria-label={pinned ? 'Pinned to transcript' : 'Pin to transcript'}
              title={pinned ? 'Pinned to transcript' : 'Pin to transcript'}
              onClick={onPin}
              className={cn(BTN, GHOST)}
            >
              <Pin className={cn('size-4', pinned && 'fill-current')} aria-hidden="true" />
              {pinned ? 'Pinned' : 'Pin'}
            </button>
            <button
              type="button"
              disabled={waitLeft > 0 || asked}
              aria-label="Ask again"
              title="Ask again"
              onClick={() => {
                setAsked(true);
                onAskAgain();
              }}
              className={cn(BTN, GHOST)}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              <span className="max-sm:sr-only">Ask again</span>
            </button>
          </>
        )}
      </footer>
    </section>
  );
}
