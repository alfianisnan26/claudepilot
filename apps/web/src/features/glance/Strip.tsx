import { cn } from '@isnanme/ui';
import { useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';
import { GlanceChip, type ChipLayout } from './Chip';
import { useGlanceFocusValue } from './focus';
import { useGlanceHost } from './Host';
import { Quiet } from './Quiet';
import type { PopoverSide } from './Popover';
import { GLANCE_WIDGETS } from './registry';
import { orderWidgets, useGlanceSettings } from './settings';
import type { GlanceContext, GlancePlacement, GlanceWidget } from './types';

/** What a screen reader calls each strip (several can be on screen at once, so they differ). */
const STRIP_LABEL: Record<GlancePlacement, string> = { header: 'At a glance', list: 'At a glance on this page', composer: 'At a glance in this agent', dock: 'Dock' };

/** The widgets a place draws: the ones that fit it, the ones the person left on, in the order they chose; none when the place is off. */
export function useStripWidgets(placement: GlancePlacement): GlanceWidget[] {
  const settings = useGlanceSettings();
  if (!settings.places[placement]) return [];
  return orderWidgets(
    GLANCE_WIDGETS.filter((w) => !w.placements || w.placements.includes(placement)),
    settings,
  );
}

/** Whether a place has anything to draw (a page may then make room for it). */
export const useHasStrip = (placement: GlancePlacement): boolean => useStripWidgets(placement).length > 0;

/**
 * A row (or column) of compact chips for one place; a tap opens the widget's full form: a popover beside the chip from 640 px, a
 * bottom sheet on a phone. Draws nothing when the place is off or no widget fits it.
 */
export function GlanceStrip({ placement, labelled, dense, layout = 'row', side = 'below', className, label = STRIP_LABEL[placement] }: { placement: GlancePlacement; labelled?: boolean; dense?: boolean; layout?: ChipLayout; side?: PopoverSide; className?: string; label?: string }) {
  const widgets = useStripWidgets(placement);
  const { places } = useGlanceSettings();
  const focus = useGlanceFocusValue();
  const ctx: GlanceContext = { focus, placement };
  const host = useGlanceHost(ctx, side);
  if (!widgets.length) return null;
  return (
    <>
      {/* The phone's app bar already shows these: the list does not say it twice there (while that bar's strip is on). */}
      <ul aria-label={label} className={cn('flex items-center gap-0.5', layout === 'column' && 'flex-col', layout === 'rail' && 'flex-col lg:flex-row', placement === 'list' && places.header && 'max-sm:hidden', className)}>
        {widgets.map((w) => (
          <li key={w.id}>
            <Quiet what={`${w.id} (chip)`}>
              <StripChip widget={w} ctx={ctx} open={host.openId === w.id} layout={layout} labelled={labelled} dense={dense} onToggle={host.toggle} />
            </Quiet>
          </li>
        ))}
      </ul>
      {host.element}
    </>
  );
}

/** One widget's chip: it asks the widget for its compact state (a hook, so it lives in a component of its own). */
function StripChip({ widget, ctx, open, layout, labelled, dense, onToggle }: { widget: GlanceWidget; ctx: GlanceContext; open: boolean; layout: ChipLayout; labelled?: boolean; dense?: boolean; onToggle: (w: GlanceWidget, anchor: HTMLElement | null) => void }) {
  const state = widget.useCompact(ctx);
  const navigate = useNavigate();
  const ref = useRef<HTMLButtonElement>(null);
  const press = useCallback(() => {
    const toggle = () => onToggle(widget, ref.current);
    if (widget.activate) widget.activate({ open: toggle, navigate: (to) => navigate(to) });
    else toggle();
  }, [widget, onToggle, navigate]);
  return <GlanceChip ref={ref} widget={widget} state={state} open={open} onPress={press} layout={layout} labelled={labelled} dense={dense} popup={!widget.activate} />;
}
