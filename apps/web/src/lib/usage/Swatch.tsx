import { cn } from '@isnanme/ui';
import type { PaletteKind, PaletteSlot } from '@portal/contracts';
import { useId } from 'react';
import { PatternDefs, patternFill, usePatterns } from './patterns';
import { slotColor } from './palette';
import { useSlot } from './usePalette';

/**
 * A small square in a Claude's or model's colour: a legend entry, a chip, a row's marker. It carries no meaning alone (the name sits
 * beside it), and wears the slot's hatch pattern when patterns are on. `slot` undefined or null draws the neutral grey. `hollow`: an outline,
 * for an entry switched off.
 */
export function Swatch({ slot, className, patterned, hollow }: { slot: PaletteSlot | undefined; className?: string; patterned?: boolean; hollow?: boolean }) {
  const id = `uu-sw-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [patternsOn] = usePatterns();
  const fill = patternFill(id, slot);
  const hatched = !hollow && (patterned ?? patternsOn) && fill !== null;
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className={cn('size-3 shrink-0', className)}>
      {hatched && (
        <defs>
          <PatternDefs prefix={id} />
        </defs>
      )}
      {hollow ? <rect x="0.75" y="0.75" width="10.5" height="10.5" rx="2.5" fill="none" stroke={slotColor(slot)} strokeWidth="1.5" /> : <rect width="12" height="12" rx="3" fill={slotColor(slot)} />}
      {hatched && <rect width="12" height="12" rx="3" fill={fill} />}
    </svg>
  );
}

/** The swatch of one Claude, by id (`default:<workspaceId>` for requests recorded without one). Loads the palette on first use. */
export function ClaudeSwatch({ claudeId, className }: { claudeId: string; className?: string }) {
  return <Swatch slot={useSlot('claude', claudeId)} className={className} />;
}

/** The swatch of one model, by id (`claude-opus-4-5`). */
export function ModelSwatch({ model, className }: { model: string; className?: string }) {
  return <Swatch slot={useSlot('model', model)} className={className} />;
}
