import { cn } from '@isnanme/ui';
import type { ReactNode } from 'react';
import type { GlanceCompact, GlanceLevel } from './types';

/** The colour a level is drawn in (the app's own tokens, so light and dark both work). `idle` and `unknown` stay quiet. */
export const LEVEL_TEXT: Record<GlanceLevel, string> = {
  ok: 'text-accent',
  warn: 'text-gold',
  critical: 'text-danger',
  idle: 'text-muted',
  unknown: 'text-muted',
};

/** What a level is called when a title or a screen reader says it. */
export const LEVEL_WORD: Record<GlanceLevel, string> = { ok: 'fine', warn: 'low', critical: 'critical', idle: 'idle', unknown: 'unknown' };

/**
 * The status dot: a filled circle for ok, a diamond for warn, a larger rounded square for critical, a small faint circle for idle
 * and a hollow ring for unknown. The shape adds to the colour (it is never the only signal), and the chip's `title` says the level in words.
 */
export function LevelDot({ level, className }: { level: GlanceLevel; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block shrink-0 bg-current',
        LEVEL_TEXT[level],
        level === 'ok' && 'size-2 rounded-full',
        level === 'warn' && 'size-[7px] rotate-45 rounded-[1.5px]',
        level === 'critical' && 'size-2.5 rounded-[3px]',
        level === 'idle' && 'size-1.5 rounded-full opacity-60',
        level === 'unknown' && 'size-2 rounded-full border-[1.5px] border-current bg-transparent',
        className,
      )}
    />
  );
}

/**
 * What a chip draws for a compact state. The number: the widget's `value`, a quiet placeholder while it loads, or nothing when the
 * widget has none. The dot: always, except for an idle widget with no number (Shortcuts): then the icon stands alone, with no dot
 * and no empty slot where a number would go.
 */
export function chipShape(state: Pick<GlanceCompact, 'value' | 'level' | 'loading'>): { number: 'value' | 'loading' | null; dot: boolean } {
  const number = state.loading ? 'loading' : state.value ? 'value' : null;
  return { number, dot: !(state.level === 'idle' && number === null) };
}

/** The shared look of a row inside a full form: content on the left, a trailing action on the right, a quiet divider between rows. */
export function GlanceList({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-line">
      {children}
    </ul>
  );
}

export function GlanceRow({ children, className }: { children: ReactNode; className?: string }) {
  return <li className={cn('flex min-h-11 items-center gap-3 py-2', className)}>{children}</li>;
}

/** An empty full form: one short line (text diet). */
export function GlanceEmpty({ children }: { children: ReactNode }) {
  return <p className="py-3 text-center text-[13.5px] text-muted">{children}</p>;
}
