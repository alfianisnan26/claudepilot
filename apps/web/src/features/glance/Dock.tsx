import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useEffect } from 'react';
import { useMediaQuery } from '@isnanme/ui';
import { useGlanceFocusValue } from './focus';
import { FullBody, FullHeader } from './Host';
import { Quiet } from './Quiet';
import { GlanceStrip, useStripWidgets } from './Strip';
import { updateGlanceSettings, useGlanceSettings } from './settings';
import type { GlanceContext, GlanceWidget } from './types';

/** How wide the open dock is; the shell pads its content by it (`--glance-dock-w`), so nothing sits under the panel. */
const DOCK_WIDTH = '20rem';

/**
 * The desktop's side dock (from 1280 px, when the person turned it on in Settings): a slim rail of chips on the right edge, and
 * with the toggle a panel showing every widget's full form, stacked. Opening it makes room instead of covering the page.
 */
export function GlanceDock() {
  const wide = useMediaQuery('(min-width: 1280px)');
  const { dockOpen } = useGlanceSettings();
  const widgets = useStripWidgets('dock');
  const focus = useGlanceFocusValue();
  const ctx: GlanceContext = { focus, placement: 'dock' };
  const panel = wide && dockOpen && widgets.length > 0;

  useEffect(() => {
    if (!panel) return;
    const root = document.documentElement;
    root.style.setProperty('--glance-dock-w', DOCK_WIDTH);
    return () => void root.style.removeProperty('--glance-dock-w');
  }, [panel]);

  if (!wide || !widgets.length) return null;
  if (!panel)
    return (
      <div className="fixed top-1/2 right-0 z-30 flex -translate-y-1/2 flex-col items-center gap-0.5 rounded-l-2xl border border-r-0 border-line bg-surface p-1 shadow-card">
        <GlanceStrip placement="dock" layout="column" side="left" />
        <button
          type="button"
          onClick={() => updateGlanceSettings({ dockOpen: true })}
          aria-label="Open dock"
          title="Open dock"
          className="press mt-0.5 inline-flex size-9 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
        >
          <PanelRightOpen className="size-[18px]" />
        </button>
      </div>
    );
  return (
    <aside aria-label="Dock" style={{ width: DOCK_WIDTH }} className="fixed inset-y-0 right-0 z-30 flex flex-col border-l border-line bg-bg">
      <div className="flex h-14 shrink-0 items-center justify-end px-3">
        <button
          type="button"
          onClick={() => updateGlanceSettings({ dockOpen: false })}
          aria-label="Close dock"
          title="Close dock"
          className="press inline-flex size-9 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
        >
          <PanelRightClose className="size-[18px]" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-6 [scrollbar-width:thin]">
        {widgets.map((w) => (
          <Quiet key={w.id} what={`${w.id} (dock)`}>
            <DockSection widget={w} ctx={ctx} />
          </Quiet>
        ))}
      </div>
    </aside>
  );
}

function DockSection({ widget, ctx }: { widget: GlanceWidget; ctx: GlanceContext }) {
  return (
    <section aria-label={widget.label} className="rounded-[20px] border border-line bg-surface">
      <FullHeader widget={widget} />
      <div className="px-4 pb-4">
        <FullBody widget={widget} ctx={ctx} surface="dock" close={() => undefined} />
      </div>
    </section>
  );
}
