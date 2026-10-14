import { Badge, buttonClass, cn, EmptyState, useToast } from '@isnanme/ui';
import { ATTENTION_KIND_LABEL, ATTENTION_WHY_LABEL, attentionItemKey, type AttentionItem } from '@portal/contracts';
import { ArrowRight, CheckCheck, ChevronLeft, ChevronRight, Clock, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { snoozeAttention } from './api';
import { deckOf, keyOutcome, laterOf, nextIndex, startIndex, swipeOutcome, type SwipeOutcome } from './deck';
import { KIND_ICON, WHY_ABOUT, WHY_TONE } from './look';
import { waited } from './model';
import { patchAttentionItem } from './store';

const ABOUT_DECK =
  'One card at a time, the most important first. Swipe right (or →) to open the item where it is decided, with that page’s own checks. Swipe left (or ←) to put it off for an hour: it comes back by itself. The buttons do the same.';

/** How long a card takes to fly out before it acts (the motion is transform and opacity only; none when the person reduces motion). */
const OUT_MS = 180;

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * The swipe deck (docs/prd/attention.md, T-146 slice 2): the page's action surface. One card per item not put off; right opens the item's
 * own page (where its module approves, answers or opens the chat: the deck never approves by itself), left is Later for an hour. Buttons
 * and the arrow keys do the same as the gestures. A card that leaves (resolved elsewhere, put off) hands its place to the next one.
 */
export function Deck({ items, now, openKey }: { items: readonly AttentionItem[]; now: number; openKey: string | null }) {
  const navigate = useNavigate();
  const toast = useToast();
  const deck = useMemo(() => deckOf(items, now), [items, now]);
  const later = useMemo(() => laterOf(items, now), [items, now]);
  // The card shown is held by its key, so a live update never swaps it under the finger; its index is where the next one comes from.
  const [current, setCurrent] = useState<string | null>(() => {
    const d = deckOf(items, now);
    return d.length ? attentionItemKey(d[startIndex(d, openKey)]!) : null;
  });
  const lastIndex = useRef(0);
  let index = current ? deck.findIndex((i) => attentionItemKey(i) === current) : -1;
  if (index < 0) index = nextIndex(lastIndex.current, deck.length);
  lastIndex.current = index;
  const card = deck[index] ?? null;
  const cardKey = card ? attentionItemKey(card) : null;
  useEffect(() => {
    if (cardKey !== current) setCurrent(cardKey);
  }, [cardKey, current]);

  const [leaving, setLeaving] = useState<SwipeOutcome>(null);
  const [busy, setBusy] = useState(false);

  const decide = (what: SwipeOutcome) => {
    if (!card || !what || busy) return;
    const target = card;
    setLeaving(what);
    window.setTimeout(
      () => {
        if (what === 'act') {
          navigate(target.link);
          return;
        }
        setBusy(true);
        snoozeAttention(target.kind, target.id)
          .then((next) => {
            setLeaving(null);
            patchAttentionItem(next); // the card leaves the deck; the next one takes its place
          })
          .catch((e: unknown) => {
            setLeaving(null); // it comes back
            toast(errorText(e, 'Couldn’t put it off.'), 'error');
          })
          .finally(() => setBusy(false));
      },
      reducedMotion() ? 0 : OUT_MS,
    );
  };

  const back = async (i: AttentionItem) => {
    try {
      patchAttentionItem(await snoozeAttention(i.kind, i.id, 0));
      setCurrent(attentionItemKey(i));
    } catch (e) {
      toast(errorText(e, 'Couldn’t bring it back.'), 'error');
    }
  };

  return (
    <section aria-label="Deck" data-attention-deck="" className="flex min-w-0 flex-col gap-4">
      {!card ? (
        <EmptyState icon={<CheckCheck className="size-6" />} title={later.length ? 'All put off' : 'Nothing needs you'} />
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              aria-label="Previous card"
              title="Previous"
              disabled={index <= 0}
              onClick={() => setCurrent(attentionItemKey(deck[index - 1]!))}
              className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full text-ink hover:bg-ink/[0.07] disabled:opacity-30"
            >
              <ChevronLeft className="size-5" aria-hidden="true" />
            </button>
            <p className="flex items-center gap-1 text-[13px] text-muted tabular-nums" aria-live="polite" data-deck-position="">
              {index + 1} of {deck.length}
              <InfoTip label="About the deck">{ABOUT_DECK}</InfoTip>
            </p>
            <button
              type="button"
              aria-label="Next card"
              title="Next"
              disabled={index >= deck.length - 1}
              onClick={() => setCurrent(attentionItemKey(deck[index + 1]!))}
              className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full text-ink hover:bg-ink/[0.07] disabled:opacity-30"
            >
              <ChevronRight className="size-5" aria-hidden="true" />
            </button>
          </div>
          <div className="overflow-x-clip py-1">
            <Card key={cardKey} item={card} now={now} leaving={leaving} onDecide={decide} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              data-deck-later=""
              disabled={busy || !!leaving}
              aria-label={`Later: ${card.title}`}
              onClick={() => decide('later')}
              className={cn(buttonClass('secondary'), 'min-h-12 gap-2')}
            >
              <Clock className="size-[18px]" aria-hidden="true" />
              Later
            </button>
            <button
              type="button"
              data-deck-act=""
              disabled={!!leaving}
              aria-label={`${card.action.label}: ${card.title}`}
              onClick={() => decide('act')}
              className={cn(buttonClass('primary'), 'min-h-12 gap-2')}
            >
              {card.action.label}
              <ArrowRight className="size-[18px]" aria-hidden="true" />
            </button>
          </div>
        </>
      )}
      {later.length > 0 && (
        <section aria-labelledby="deck-later" data-deck-later-list="">
          <h2 id="deck-later" className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink-soft">
            Later
            <span className="tabular-nums text-muted">{later.length}</span>
            <InfoTip label="About Later">Put off by you. Each comes back into the deck by itself at the time shown; it still waits and is still counted.</InfoTip>
          </h2>
          <ul className="flex flex-col gap-2">
            {later.map((i) => (
              <li key={attentionItemKey(i)} data-attention-later={attentionItemKey(i)} className="flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface py-1 pl-3.5 pr-1">
                <Clock className="size-4 shrink-0 text-muted" aria-hidden="true" />
                <div className="min-w-0 flex-1 py-1.5">
                  <Link to={i.link} className="line-clamp-1 text-[14px] font-semibold [overflow-wrap:anywhere] hover:underline">
                    {i.title}
                  </Link>
                  <p className="text-[12.5px] text-muted">
                    Until <time dateTime={i.snoozedUntil}>{new Date(i.snoozedUntil!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                  </p>
                </div>
                <button
                  type="button"
                  data-deck-unsnooze=""
                  aria-label={`Back now: ${i.title}`}
                  title="Back now"
                  onClick={() => void back(i)}
                  className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full text-ink hover:bg-ink/[0.07]"
                >
                  <RotateCcw className="size-[18px]" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

/**
 * One card: what, why (with its InfoTip), who asked, how long it waited, the risk in one line. It follows the finger sideways only
 * (`touch-action: pan-y`: a vertical drag still scrolls the page, the page never moves sideways); a short drag snaps back.
 */
function Card({ item: i, now, leaving, onDecide }: { item: AttentionItem; now: number; leaving: SwipeOutcome; onDecide: (o: SwipeOutcome) => void }) {
  const Icon = KIND_ICON[i.kind];
  const [dx, setDx] = useState(0);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const el = useRef<HTMLElement>(null);

  const down = (e: ReactPointerEvent<HTMLElement>) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || leaving) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const mx = e.clientX - d.x;
    const my = e.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      if (Math.abs(my) > Math.abs(mx)) {
        drag.current = null; // a scroll, not a swipe
        return;
      }
      d.moved = true;
      el.current?.setPointerCapture?.(e.pointerId);
    }
    setDx(mx);
  };
  const up = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId || !d.moved) return;
    const outcome = swipeOutcome(e.clientX - d.x, e.clientY - d.y, el.current?.offsetWidth ?? 390);
    setDx(0);
    if (outcome) onDecide(outcome);
  };
  const cancel = () => {
    drag.current = null;
    setDx(0);
  };

  const out = leaving === 'act' ? 'translateX(110%) rotate(6deg)' : leaving === 'later' ? 'translateX(-110%) rotate(-6deg)' : null;
  const style = out ? { transform: out, opacity: 0 } : dx ? { transform: `translateX(${dx}px) rotate(${dx / 40}deg)` } : undefined;
  const hint = dx > 24 ? 'act' : dx < -24 ? 'later' : null;

  return (
    <article
      ref={el}
      tabIndex={0}
      aria-roledescription="card"
      aria-label={`${ATTENTION_KIND_LABEL[i.kind]}: ${i.title}`}
      aria-keyshortcuts="ArrowRight ArrowLeft"
      data-attention-card={attentionItemKey(i)}
      onKeyDown={(e) => {
        const o = keyOutcome(e.key);
        if (o && e.target === e.currentTarget) {
          e.preventDefault();
          onDecide(o);
        }
      }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onClickCapture={(e) => {
        // A swipe that started on a link is not a tap on it.
        if (dx !== 0) e.preventDefault();
      }}
      style={style}
      className={cn(
        'relative flex min-h-[52svh] min-w-0 touch-pan-y select-none flex-col gap-3 rounded-3xl border border-line bg-surface p-5 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-accent lg:min-h-80',
        dx === 0 && 'transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-5 shrink-0 text-muted" aria-hidden="true" />
        <span className="text-[13px] font-semibold text-ink-soft">{ATTENTION_KIND_LABEL[i.kind]}</span>
        <Badge tone={WHY_TONE[i.why]}>{ATTENTION_WHY_LABEL[i.why]}</Badge>
        <InfoTip label={`About ${ATTENTION_WHY_LABEL[i.why]}`}>{WHY_ABOUT[i.why]}</InfoTip>
        <time dateTime={i.since} title={i.since} className="ml-auto shrink-0 text-[13px] text-muted tabular-nums">
          {waited(i.since, now)}
        </time>
      </div>
      <h2 className="text-[19px] leading-snug font-semibold [overflow-wrap:anywhere]">{i.title}</h2>
      {i.risk && <p className="text-[14px] text-ink-soft [overflow-wrap:anywhere]">{i.risk}</p>}
      {i.who.length > 0 && (
        <p className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[13px] text-muted">
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
        </p>
      )}
      {hint && (
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute top-4 rounded-full px-3 py-1 text-[13px] font-semibold',
            hint === 'act' ? 'left-4 bg-accent/15 text-accent' : 'right-4 bg-ink/10 text-ink-soft',
          )}
        >
          {hint === 'act' ? i.action.label : 'Later'}
        </span>
      )}
    </article>
  );
}
