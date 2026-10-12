import { cn } from '@isnanme/ui';
import { forwardRef } from 'react';
import type { GlanceCompact, GlanceWidget } from './types';
import { chipShape, LEVEL_TEXT, LevelDot } from './ui';

/**
 * `row`: icon and number side by side (header, list, composer). `column`: the number under the icon (the dock's rail).
 * `rail`: a column on the sidebar's narrow rail, a row from the wide sidebar (1024 px).
 */
export type ChipLayout = 'row' | 'column' | 'rail';

/**
 * A widget's compact form: its icon with the status dot on the corner, then its number. On a phone that is all there is; a
 * labelled chip (the Sessions list) adds the one-word name from 640 px. Its accessible name is the widget's own `title`, so
 * the state is in words as well as in colour.
 */
export const GlanceChip = forwardRef<
  HTMLButtonElement,
  { widget: GlanceWidget; state: GlanceCompact; open: boolean; onPress: () => void; labelled?: boolean; layout?: ChipLayout; popup?: boolean; dense?: boolean }
>(function GlanceChip({ widget, state, open, onPress, labelled, layout = 'row', popup = true, dense }, ref) {
  const Icon = widget.icon;
  // Only a critical number is tinted: yellow text is under 4.5:1 on a light surface, so warn is the dot's shape and colour and the title's words.
  const tinted = state.level === 'critical';
  const shape = chipShape(state);
  return (
    <button
      ref={ref}
      type="button"
      aria-haspopup={popup ? 'dialog' : undefined}
      aria-expanded={popup ? open : undefined}
      aria-label={state.title}
      title={state.title}
      onClick={onPress}
      className={cn(
        'press relative inline-flex shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-ink-soft tabular-nums hover:bg-surface-2 hover:text-ink',
        layout === 'row' && (dense ? 'h-8 min-w-8 gap-1 px-1.5 text-[12.5px] tap:h-10 tap:min-w-10' : 'h-10 min-w-10 gap-1 px-2 tap:h-11 tap:min-w-11'),
        layout === 'column' && 'min-h-11 w-11 flex-col gap-0.5 py-1 text-[11.5px] leading-none',
        layout === 'rail' && 'min-h-11 w-11 flex-col gap-0.5 py-1 text-[11.5px] leading-none lg:h-10 lg:min-h-0 lg:w-auto lg:min-w-10 lg:flex-row lg:gap-1 lg:px-2 lg:py-0 lg:text-[13px] lg:leading-normal',
        open && 'bg-surface-2 text-ink',
        state.stale && 'opacity-60',
      )}
    >
      <span className="relative inline-flex">
        <Icon className={layout === 'row' ? 'size-[19px]' : layout === 'column' ? 'size-[18px]' : 'size-[18px] lg:size-[19px]'} strokeWidth={2} aria-hidden="true" />
        {shape.dot && <LevelDot level={state.level} className="absolute -top-1 -right-1.5 ring-2 ring-bg" />}
      </span>
      {shape.number === 'loading' && <span className="skeleton h-3 w-5 rounded" aria-hidden="true" />}
      {shape.number === 'value' && <span className={cn('whitespace-nowrap', tinted && LEVEL_TEXT[state.level])}>{state.value}</span>}
      {labelled && <span className="hidden font-medium text-muted sm:inline">{widget.label}</span>}
    </button>
  );
});
