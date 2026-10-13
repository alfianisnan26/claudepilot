import { cn } from '@isnanme/ui';
import type { ChatSession } from '@portal/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { formatTokens } from './shared';

/** The ring's geometry: a 26 px circle with a 2.5 px stroke. */
const R = 11;
const C = 2 * Math.PI * R;

/**
 * How full the context window was after the last turn (Claude Code's own usage report, chat PRD FR19): a small ring by Send, the
 * same at every width. The arc and the number inside carry the percentage in its tint: accent, gold from 80 %, red from 95 %. The
 * token counts show on hover, keyboard focus or tap. Nothing reported yet, or no window size to divide by: a neutral empty ring
 * (never an invented percentage), and the tip says what is known. It is always there, so the composer's row never changes shape.
 */
export function ContextRing({ context }: { context: ChatSession['context'] | undefined }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const tipId = useId();
  const used = context?.usedTokens ?? null;
  const size = context?.windowTokens ?? null;
  const pct = used !== null && size ? Math.min(100, Math.round((used / size) * 100)) : null;
  const tone = pct === null ? 'none' : pct >= 95 ? 'danger' : pct >= 80 ? 'gold' : 'accent';

  // Opened by a tap: closes on a tap elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = pct !== null ? `Context ${pct}% full` : used !== null ? `Context: ${formatTokens(used)} tokens used` : 'Context: not reported yet';
  const tip =
    pct !== null && used !== null && size
      ? `${pct}% · ${formatTokens(used)} of ${formatTokens(size)} tokens`
      : used !== null
        ? `${formatTokens(used)} tokens · window size not reported`
        : 'Not reported yet: shows after the first turn';

  return (
    <div ref={ref} className="relative shrink-0" data-context-ring={tone}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        aria-label={label}
        aria-describedby={tipId}
        className={cn(
          'peer press inline-flex size-10 items-center justify-center rounded-full transition-colors tap:size-11',
          tone === 'danger' ? 'text-danger hover:bg-danger-soft' : tone === 'gold' ? 'text-gold hover:bg-gold-soft' : tone === 'accent' ? 'text-accent hover:bg-ink/[0.07]' : 'text-muted hover:bg-ink/[0.07]',
        )}
      >
        <span className="relative flex size-[26px] items-center justify-center" aria-hidden="true">
          <svg viewBox="0 0 26 26" className="absolute inset-0 size-full -rotate-90">
            <circle cx="13" cy="13" r={R} fill="none" strokeWidth="2.5" className={tone === 'none' ? 'stroke-ink/15' : 'stroke-current opacity-20'} />
            {pct !== null && (
              <circle
                cx="13"
                cy="13"
                r={R}
                fill="none"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - Math.max(pct, 3) / 100)}
                className="stroke-current motion-safe:transition-[stroke-dashoffset] motion-safe:duration-300"
              />
            )}
          </svg>
          {pct !== null && <span className="relative text-[9px] leading-none font-bold tracking-tight tabular-nums">{pct}</span>}
        </span>
      </button>
      <span
        id={tipId}
        role="tooltip"
        className={cn(
          // Centred over the ring (it sits mid-row), at most 15rem wide: it never runs off a 320 px screen.
          'pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-max max-w-[15rem] -translate-x-1/2 rounded-xl bg-primary px-3 py-2 text-center text-[12px] font-medium text-primary-ink tabular-nums opacity-0 shadow-lift transition-opacity peer-hover:opacity-100 peer-focus-visible:opacity-100',
          open && 'opacity-100',
        )}
      >
        <span className="font-semibold">Context</span> {tip}
      </span>
    </div>
  );
}
