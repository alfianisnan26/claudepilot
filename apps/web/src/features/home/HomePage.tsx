import { Button, Dialog, EmptyState, Switch } from '@isnanme/ui';
import { ArrowDown, ArrowUp, House, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { Suspense, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { Quiet } from '@/features/glance/Quiet';
import { GLANCE_WIDGETS } from '@/features/glance/registry';
import { moveInOrder } from '@/features/glance/settings';
import type { GlanceWidget } from '@/features/glance/types';
import { GlanceSkeleton } from '@/features/glance/widgets/shared/states';
import { HomeModeSwitch, ManagerMode, readHomeMode, saveHomeMode, type HomeMode } from './ManagerMode';
import { packColumns } from './masonry';
import { DEFAULT_HOME, orderCards, resetHomeSettings, updateHomeSettings, useHomeSettings } from './settings';

/** The widgets that have a Home card. */
const CARDS = GLANCE_WIDGETS.filter((w): w is GlanceWidget & { Card: NonNullable<GlanceWidget['Card']> } => !!w.Card);
const titleOf = (w: GlanceWidget) => w.cardLabel ?? w.label;

/**
 * The first page (docs/prd/glance-widgets.md §18): what needs you, what runs, what is left of each plan, the workspaces, the tickets, CI
 * and what was spent, each a card that is also a glance widget. One column on a phone, a grid from 1024 px. The person hides and orders
 * the cards (Arrange), kept on this device. Every card reads a shared store kept fresh by the live socket: the page asks nothing on a timer.
 */
export function HomePage() {
  const s = useHomeSettings();
  const cards = orderCards(CARDS, s);
  const [arranging, setArranging] = useState(false);
  // D-80 / T-968 S3: Dashboard | Manager, remembered on this device.
  const [mode, setModeState] = useState<HomeMode>(readHomeMode);
  const setMode = (m: HomeMode) => (setModeState(m), saveHomeMode(m));
  const header = (
    <PageHeader
      title={mode === 'manager' ? 'Manager' : 'Home'}
      description={
        mode === 'manager'
          ? 'Your General Manager: the one chat for the whole pilot. Switch back to the dashboard at any time.'
          : 'What needs you and how things stand, at a glance. Arrange hides and orders the cards on this device.'
      }
      action={
        <div className="flex items-center gap-2">
          <HomeModeSwitch mode={mode} onMode={setMode} />
          {mode === 'dashboard' && (
            <Button variant="ghost" size="sm" icon={<SlidersHorizontal className="size-4" />} onClick={() => setArranging(true)} aria-label="Arrange cards" title="Arrange cards">
              <span className="max-sm:sr-only">Arrange</span>
            </Button>
          )}
        </div>
      }
    />
  );
  if (mode === 'manager')
    return (
      <>
        {header}
        <ManagerMode onBack={() => setMode('dashboard')} />
      </>
    );
  return (
    <>
      {header}
      {cards.length === 0 ? (
        <EmptyState
          icon={<House className="size-6" />}
          title="All cards hidden"
          action={
            <Button onClick={() => setArranging(true)} icon={<SlidersHorizontal className="size-4" />}>
              Arrange
            </Button>
          }
        />
      ) : (
        <Columns ids={cards.map((w) => w.id)}>{(i) => <HomeCard widget={cards[i]!} />}</Columns>
      )}
      <ArrangeDialog open={arranging} onClose={() => setArranging(false)} />
    </>
  );
}

/** 1 column on a phone, 2 from 1024 px, 3 from 1700 px (as the grid was). */
function useColumnCount(): number {
  const read = () => (typeof window === 'undefined' ? 1 : window.matchMedia('(min-width: 1700px)').matches ? 3 : window.matchMedia('(min-width: 1024px)').matches ? 2 : 1);
  const [n, setN] = useState(read);
  useEffect(() => {
    const qs = ['(min-width: 1024px)', '(min-width: 1700px)'].map((q) => window.matchMedia(q));
    const on = () => setN(read());
    qs.forEach((q) => q.addEventListener('change', on));
    return () => qs.forEach((q) => q.removeEventListener('change', on));
  }, []);
  return n;
}

/** A height change re-packs after the cards have been still this long (a list that grows row by row moves the layout once). */
const SETTLE_MS = 1500;

/**
 * The cards in independent column stacks (masonry.ts): no row makes a short card leave a hole. Each card's height is watched. The packing
 * is made fresh when the cards or the column count change; on a height change, once heights settle, the good packing that moves the
 * fewest cards is taken (masonry.ts SETTLE_PX), so a packing that is still good stays as it is.
 */
function Columns({ ids, children }: { ids: string[]; children: (i: number) => ReactNode }) {
  const n = useColumnCount();
  const heights = useRef(new Map<string, number>());
  const nodes = useRef(new Map<string, HTMLElement>());
  const key = `${n}|${ids.join(',')}`;
  const [packing, setPacking] = useState<{ key: string; cols: number[][] }>(() => ({ key, cols: packColumns(ids.map(() => 0), n) }));
  const repack = () => {
    const h = ids.map((id) => heights.current.get(id) ?? 0);
    setPacking((cur) => {
      const next = packColumns(h, n, 16, cur.key === key ? cur.cols : undefined);
      return cur.key === key && JSON.stringify(cur.cols) === JSON.stringify(next) ? cur : { key, cols: next };
    });
  };
  const repackRef = useRef(repack);
  repackRef.current = repack;
  // The key whose heights have all been measured once (its first full packing is taken at once, later ones after SETTLE_MS).
  const settled = useRef('');
  useLayoutEffect(() => {
    setPacking({ key, cols: packColumns(ids.map((id) => heights.current.get(id) ?? 0), n) });
  }, [key]); // ids and n are in key
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.col ?? '';
        const h = Math.round(e.contentRect.height);
        if (heights.current.get(id) !== h) (heights.current.set(id, h), (changed = true));
      }
      if (!changed) return;
      clearTimeout(timer);
      // The first time every height is known, at once (the first paint was round robin); later, once they settle.
      const known = ids.every((id) => (heights.current.get(id) ?? 0) > 0);
      timer = setTimeout(() => repackRef.current(), known && settled.current === key ? SETTLE_MS : 0);
      if (known) settled.current = key;
    });
    nodes.current.forEach((el) => ro.observe(el));
    return () => (clearTimeout(timer), ro.disconnect());
  }, [key, packing]);
  const cols = packing.key === key ? packing.cols : packColumns(ids.map(() => 0), n);
  const ref = (id: string) => (el: HTMLElement | null) => void (el ? nodes.current.set(id, el) : nodes.current.delete(id));
  return (
    <div className="flex items-start gap-4" data-home-columns={cols.length}>
      {cols.map((col, c) => (
        <div key={c} className="flex min-w-0 flex-1 flex-col gap-4">
          {col.map((i) => (
            <div key={ids[i]} ref={ref(ids[i]!)} data-col={ids[i]} className="min-w-0">
              {children(i)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function HomeCard({ widget }: { widget: GlanceWidget & { Card: NonNullable<GlanceWidget['Card']> } }) {
  const id = useId();
  const Icon = widget.icon;
  const title = titleOf(widget);
  const Body = widget.Card;
  return (
    <section aria-labelledby={id} data-home-card={widget.id} className="min-w-0 rounded-[24px] border border-line bg-surface">
      <header className="flex min-h-12 items-center gap-2 px-4 pt-2 sm:px-5">
        <Icon className="size-[18px] shrink-0 text-muted" aria-hidden="true" />
        <h2 id={id} className="min-w-0 truncate text-[15px] font-semibold">
          {title}
        </h2>
        <InfoTip label={`About ${title}`}>{widget.cardAbout ?? widget.about}</InfoTip>
      </header>
      <div className="min-w-0 px-4 pb-3 sm:px-5">
        <Quiet what={`${widget.id} (home)`} fallback={<p className="py-3 text-center text-sm text-muted">Could not show this.</p>}>
          <Suspense fallback={<GlanceSkeleton />}>
            <Body />
          </Suspense>
        </Quiet>
      </div>
    </section>
  );
}

/** Which cards show and in what order: a switch and a move up and down per card (touch-friendly, no dragging), and a reset. */
function ArrangeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useHomeSettings();
  const all = orderCards(CARDS, s, true);
  const ids = all.map((w) => w.id);
  const changed = JSON.stringify(s) !== JSON.stringify(DEFAULT_HOME);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Arrange"
      size="sm"
      footer={
        <>
          {changed && (
            <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={resetHomeSettings}>
              Reset
            </Button>
          )}
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <ul aria-label="Cards" className="-mx-1 flex flex-col divide-y divide-line">
        {all.map((w, i) => {
          const Icon = w.icon;
          const title = titleOf(w);
          const on = !s.hidden.includes(w.id);
          return (
            <li key={w.id} className="flex min-h-14 items-center gap-2 px-1 py-1.5">
              <Icon className="size-[18px] shrink-0 text-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-semibold">{title}</span>
              <MoveButton label={`Move ${title} up`} disabled={i === 0} onClick={() => updateHomeSettings({ order: moveInOrder(ids, w.id, -1) })}>
                <ArrowUp className="size-4" />
              </MoveButton>
              <MoveButton label={`Move ${title} down`} disabled={i === all.length - 1} onClick={() => updateHomeSettings({ order: moveInOrder(ids, w.id, 1) })}>
                <ArrowDown className="size-4" />
              </MoveButton>
              <Switch label={`Show ${title}`} checked={on} onChange={(v) => updateHomeSettings({ hidden: v ? s.hidden.filter((h) => h !== w.id) : [...s.hidden, w.id] })} />
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}

function MoveButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink disabled:pointer-events-none disabled:opacity-30">
      {children}
    </button>
  );
}
