import { Button, Dialog, EmptyState, Switch } from '@isnanme/ui';
import { ArrowDown, ArrowUp, House, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { Suspense, useId, useState, type ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { Quiet } from '@/features/glance/Quiet';
import { GLANCE_WIDGETS } from '@/features/glance/registry';
import { moveInOrder } from '@/features/glance/settings';
import type { GlanceWidget } from '@/features/glance/types';
import { GlanceSkeleton } from '@/features/glance/widgets/shared/states';
import { HomeModeSwitch, ManagerMode, readHomeMode, saveHomeMode, type HomeMode } from './ManagerMode';
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
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2 min-[1700px]:grid-cols-3">
          {cards.map((w) => (
            <HomeCard key={w.id} widget={w} />
          ))}
        </div>
      )}
      <ArrangeDialog open={arranging} onClose={() => setArranging(false)} />
    </>
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
