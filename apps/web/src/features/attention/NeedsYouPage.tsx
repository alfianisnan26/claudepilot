import { Badge, buttonClass, chipClass, cn, EmptyState, LoadError, RowsSkeleton, Segmented } from '@isnanme/ui';
import { ATTENTION_KIND_LABEL, ATTENTION_WHY_LABEL, type AttentionItem, type AttentionKind } from '@portal/contracts';
import { ArrowRight, CheckCheck, ChevronRight, Clock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { WindowedList } from '@/components/WindowedList';
import { InfoTip } from '@/components/InfoTip';
import { useEngaged, useSteadyRows } from '@/features/glance/widgets/shared/steady';
import { useNow } from '@/features/glance/widgets/shared/useNow';
import { SwipeDeck } from './SwipeDeck';
import { isLater, untilText } from './deck';
import { KIND_ICON, WHY_ABOUT, WHY_TONE } from './look';
import { groupByWhy, kindChoices, refusalsOf, refusedTitle, waited } from './model';
import { useAttention } from './store';

type View = 'deck' | 'list';
const VIEWS: { value: View; label: string }[] = [
  { value: 'deck', label: 'Deck' },
  { value: 'list', label: 'List' },
];

const itemKey = (i: AttentionItem) => `${i.kind}:${i.id}`;

/** One line of the windowed list: a "why" heading, the refused calls' toggle, or a row. */
type Line =
  | { kind: 'head'; key: string; why: AttentionItem['why']; label: string; count: number; first: boolean }
  | { kind: 'refused'; key: string }
  | { kind: 'row'; key: string; item: AttentionItem };

/**
 * Needs you (docs/prd/attention.md): every thing that waits for a person, from every module, in one list. Grouped by why a person is
 * required, the oldest first; each row opens the exact item (the version preselected), where it is decided with that module's own checks.
 * The list holds still under the pointer or focus (QA A9): a row resolved meanwhile stays in place, dimmed, until you let go.
 */
export function NeedsYouPage() {
  const { list, failed, reload } = useAttention();
  // The deck is the way in (`?item=kind:id` opens it at that card: a push, the Home widget); the list is the overview (`?view=list`).
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'list' ? 'list' : 'deck';
  const setView = (v: View) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v === 'list') n.set('view', 'list');
        else n.delete('view');
        return n;
      },
      { replace: true },
    );
  const [kind, setKind] = useState<AttentionKind | 'all'>('all');
  const now = useNow();
  const { engaged, bind } = useEngaged();
  const chosen = useMemo(() => (list ? (kind === 'all' ? list.items : list.items.filter((i) => i.kind === kind)) : []), [list, kind]);
  const rows = useSteadyRows(chosen, itemKey, engaged);
  const gone = useMemo(() => new Set(rows.filter((r) => r.gone).map((r) => itemKey(r.row))), [rows]);
  const groups = useMemo(() => groupByWhy(rows.map((r) => r.row)), [rows]);
  const refused = useMemo(() => refusalsOf(rows.map((r) => r.row)), [rows]);
  const choices = kindChoices(list, ATTENTION_KIND_LABEL);
  const [refusedOpen, setRefusedOpen] = useState(false);
  const lines = useMemo(() => {
    const out: Line[] = [];
    groups.forEach((g, gi) => {
      out.push({ kind: 'head', key: `why:${g.why}`, why: g.why, label: g.label, count: g.items.length, first: gi === 0 });
      for (const i of g.items) out.push({ kind: 'row', key: itemKey(i), item: i });
    });
    if (refused.items.length > 0) {
      out.push({ kind: 'refused', key: 'refused' });
      if (refusedOpen) for (const i of refused.items) out.push({ kind: 'row', key: itemKey(i), item: i });
    }
    return out;
  }, [groups, refused, refusedOpen]);

  return (
    <div>
      <PageHeader
        title="Needs you"
        description="Only what a person must decide: deploys to production, code from outside (MCP servers, skills), agents stuck on an approval, questions an agent asked you. Each card or row opens the exact item; you decide it there."
      />
      <div className="mb-4 max-w-xs [&_button]:min-h-11" data-attention-view="">
        <Segmented<View> label="View" value={view} options={VIEWS} onChange={setView} />
      </div>
      {!list && failed && <LoadError onRetry={reload} message="Could not read what needs you." />}
      {!list && !failed && <RowsSkeleton rows={3} lines={2} card label="Loading what needs you" />}
      {list && view === 'deck' && <SwipeDeck items={list.items} now={now} openKey={params.get('item')} />}
      {list && view === 'list' && (
        // THE windowed list (components/WindowedList.tsx): the groups flattened into headings and rows, only those in view drawn; it fills the
        // pane on a desktop (the kind chips above it), and scrolls with the page on a phone (the chips stick).
        <div {...bind}>
          <WindowedList
            label="Needs you"
            items={lines}
            itemKey={(l) => l.key}
            estimate={92}
            gap={8}
            header={
              (choices.length > 2 || list.unavailable.length > 0) && (
                <>
                  {choices.length > 2 && (
                    <div role="group" aria-label="Kind" className="mb-4 flex flex-wrap gap-2">
                      {choices.map((c) => (
                        <button
                          key={c.value}
                          type="button"
                          aria-pressed={kind === c.value}
                          onClick={() => setKind(c.value)}
                          className={cn(chipClass(kind === c.value), 'min-h-11')}
                        >
                          {c.label}
                          <span className="ml-1.5 tabular-nums opacity-70">{c.count ?? '–'}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {list.unavailable.length > 0 && (
                    <p role="status" className="mb-3 text-[13px] text-muted">
                      Unavailable: {list.unavailable.map((k) => ATTENTION_KIND_LABEL[k]).join(', ')}
                    </p>
                  )}
                </>
              )
            }
            empty={<EmptyState icon={<CheckCheck className="size-6" />} title="Nothing needs you" />}
            footer={
              list.total > list.items.length && (
                <p className="text-center text-[13px] text-muted">
                  {list.items.length} of {list.total} shown
                </p>
              )
            }
            renderItem={(l) =>
              l.kind === 'row' ? (
                <Row item={l.item} now={now} gone={gone.has(itemKey(l.item))} />
              ) : l.kind === 'refused' ? (
                // T-3114: refused calls are the guard working, not asks: one collapsed group below the real ones.
                <div data-attention-refusals="" className="flex items-center gap-1.5 pt-4">
                  <button
                    type="button"
                    aria-expanded={refusedOpen}
                    onClick={() => setRefusedOpen((v) => !v)}
                    className="flex min-h-11 items-center gap-1.5 rounded-lg text-[13px] font-semibold text-ink-soft outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <ChevronRight className={cn('size-4 shrink-0 transition-transform', refusedOpen && 'rotate-90')} aria-hidden="true" />
                    {refusedTitle(refused.calls)}
                    <span className="tabular-nums text-muted">{refused.items.length}</span>
                  </button>
                  <InfoTip label="About refused calls">
                    The rule guard refused these tool calls. Most need nothing: the agent goes on. Allow one only if that exact call should run
                    once. A card leaves after 30 minutes, or when its session ends; the same call again adds to its count.
                  </InfoTip>
                </div>
              ) : (
                <h2 id={`why-${l.why}`} className={cn('flex items-center gap-1.5 text-[13px] font-semibold text-ink-soft', !l.first && 'pt-4')}>
                  {l.label}
                  <span className="tabular-nums text-muted">{l.count}</span>
                  <InfoTip label={`About ${l.label}`}>{WHY_ABOUT[l.why]}</InfoTip>
                </h2>
              )
            }
          />
        </div>
      )}
    </div>
  );
}

/** One row: what (the title opens it), why as a chip, who asked, how long it waited, the risk in one line, and the primary action. */
function Row({ item: i, now, gone }: { item: AttentionItem; now: number; gone: boolean }) {
  const Icon = KIND_ICON[i.kind];
  return (
    <div
      data-attention-item={`${i.kind}:${i.id}`}
      aria-disabled={gone || undefined}
      className={cn('flex min-w-0 items-start gap-3 rounded-2xl border border-line bg-surface px-3.5 py-3', gone && 'pointer-events-none opacity-50')}
    >
      <Icon className="mt-0.5 size-5 shrink-0 text-muted" aria-label={ATTENTION_KIND_LABEL[i.kind]} />
      <div className="min-w-0 flex-1">
        <Link to={i.link} className="line-clamp-2 text-[14.5px] font-semibold [overflow-wrap:anywhere] hover:underline" tabIndex={gone ? -1 : undefined}>
          {i.title}
        </Link>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
          <Badge tone={WHY_TONE[i.why]}>{ATTENTION_WHY_LABEL[i.why]}</Badge>
          {i.who.map((w, n) =>
            w.link ? (
              <Link key={n} to={w.link} className="max-w-full truncate hover:text-ink hover:underline">
                {w.label}
              </Link>
            ) : (
              <span key={n} className="max-w-full truncate">
                {w.label}
              </span>
            ),
          )}
          <span aria-hidden="true">·</span>
          <time dateTime={i.since} title={i.since} className="tabular-nums">
            {waited(i.since, now)}
          </time>
          {isLater(i, now) && (
            <span data-attention-snoozed="" className="inline-flex items-center gap-1 text-ink-soft">
              <Clock className="size-3.5" aria-hidden="true" />
              Later, until {untilText(i.snoozedUntil!, now)}
            </span>
          )}
        </div>
        {i.risk && <p className="mt-1 text-[12.5px] text-ink-soft [overflow-wrap:anywhere]">{i.risk}</p>}
      </div>
      <Link
        to={i.link}
        aria-label={`${i.action.label}: ${i.title}`}
        title={i.action.label}
        tabIndex={gone ? -1 : undefined}
        className={cn(buttonClass('secondary', 'sm'), 'min-h-11 min-w-11 shrink-0 gap-1.5 px-3')}
      >
        <span className="hidden sm:inline">{i.action.label}</span>
        <ArrowRight className="size-4" aria-hidden="true" />
      </Link>
    </div>
  );
}
