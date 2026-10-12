import { cn } from '@isnanme/ui';
import { reasonText, type ClaudeUsage, type Figure, type PaceStatus, type WindowPace } from '@portal/contracts';
import { ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { agoText, leftText, localTime, PROBLEM_WORDS, pctText, TONE_TEXT, type Tone } from '@/features/usage/claude/format';
import { Bar } from '@/features/usage/claude/Meter';
import { useClaudeUsage, useNow } from '@/features/usage/claude/useClaudeUsage';
import { Swatch } from '@/lib/usage';
import { useGlanceSettings } from '../../settings';
import type { GlanceFullProps, GlanceLevel } from '../../types';
import { GlanceEmpty } from '../../ui';
import { leadClaude, leadWindowKey, leftText100, readClaude, windowViews, type Thresholds, type WindowView } from './quota';
import { useRecentClaudeId } from './recent';

const TONE: Record<GlanceLevel, Tone> = { ok: 'ok', warn: 'gold', critical: 'danger', idle: 'quiet', unknown: 'quiet' };
/** Text colours: the bar carries a warning's yellow, but yellow text is under 4.5:1 on a light surface, so a warning's number stays ink. */
const TEXT: Record<Tone, string> = { ...TONE_TEXT, gold: 'text-ink' };

/**
 * The Quota widget's full form (PRD glance-widgets §6): the active Claude with a meter per window and, tapped open, when the
 * window resets, how fast it is filling and where that is heading. Every derived figure carries its basis (PLAN-4 P1): measured
 * values stand as they are, estimates say "est." with the formula in an ⓘ, and what cannot be known is "-" with the reason in an ⓘ.
 * The other Claudes follow, one line each (open in all-Claudes mode, behind "Others" otherwise).
 */
export function QuotaFull({ ctx }: GlanceFullProps) {
  const { report, failed, reload } = useClaudeUsage();
  const { quotaMode, thresholds } = useGlanceSettings();
  const nowMs = useNow(30_000);
  const recent = useRecentClaudeId(!ctx.focus.claudeId);
  const [others, setOthers] = useState(false);
  if (!report) {
    return failed ? (
      <GlanceEmpty>
        Could not load.{' '}
        <button type="button" onClick={() => void reload()} className="font-semibold text-ink underline underline-offset-2">
          Retry
        </button>
      </GlanceEmpty>
    ) : (
      <div className="skeleton h-28 rounded-2xl" aria-busy="true" />
    );
  }
  // The same Claude the chip is about: the active one, or in all-Claudes mode the one with the least left.
  const mode = ctx.placement === 'composer' ? 'active' : quotaMode;
  const lead = leadClaude({ claudes: report.claudes, focusClaudeId: ctx.focus.claudeId, recentClaudeId: recent, mode, nowMs, thresholds })?.reading.claude;
  if (!lead) return <GlanceEmpty>No Claudes.</GlanceEmpty>;
  const rest = ctx.placement === 'composer' ? [] : report.claudes.filter((c) => c.claudeId !== lead.claudeId);
  const showRest = mode === 'all' || others;
  return (
    <div className="flex flex-col gap-3">
      <ClaudeBlock claude={lead} nowMs={nowMs} thresholds={thresholds} startOpen />
      {rest.length > 0 && (
        <div className="flex flex-col gap-1">
          {mode !== 'all' && (
            <button type="button" aria-expanded={others} onClick={() => setOthers((o) => !o)} className="press -mx-1 flex min-h-9 items-center gap-1.5 rounded-lg px-1 text-[13px] font-semibold text-muted hover:text-ink">
              <ChevronDown className={cn('size-4 transition-transform', others && 'rotate-180')} aria-hidden="true" />
              Others
              <span className="tabular-nums">{rest.length}</span>
            </button>
          )}
          {showRest && (
            <ul className="flex flex-col divide-y divide-line border-t border-line">
              {rest.map((c) => (
                <li key={c.claudeId}>
                  <ClaudeBlock claude={c} nowMs={nowMs} thresholds={thresholds} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** One Claude: its name and, for a plan, a meter per window; a pool, a key, a signed-out or unread Claude says that in one line. */
function ClaudeBlock({ claude, nowMs, thresholds, startOpen = false }: { claude: ClaudeUsage; nowMs: number; thresholds: Thresholds; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const reading = readClaude(claude, nowMs, thresholds);
  const views = windowViews(claude, nowMs, thresholds);
  const lead = leadWindowKey(claude, views);
  const plan = reading.headroom.kind === 'plan';
  // A Claude listed below the active one is one line until tapped: its name, its fullest window's bar and what is left.
  const collapsible = !startOpen;
  const showWindows = plan && (!collapsible || open);
  return (
    <div className={cn('flex flex-col', collapsible && 'py-0.5')}>
      <div className={cn('flex min-h-9 items-center gap-2', collapsible && 'min-h-11')}>
        {collapsible && plan ? (
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="press flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left">
            <ChevronDown className={cn('size-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden="true" />
            <Name claude={claude} />
            {!open && reading.leftPct !== null && (
              <>
                <Bar pct={reading.headroom.exhausted ? 100 : (reading.headroom.limiting?.usedPct ?? null)} tone={TONE[reading.level]} className="w-14 shrink-0" />
                <span className={cn('w-10 shrink-0 text-right text-[13px] font-semibold tabular-nums', TEXT[TONE[reading.level]])}>{leftText100(reading)}</span>
              </>
            )}
          </button>
        ) : (
          <Name claude={claude} />
        )}
        {claude.stale && claude.checkedAt && plan && (
          <span className="flex shrink-0 items-center text-[12px] text-muted">
            {agoText(claude.checkedAt, nowMs)}
            <InfoTip label="About this reading">The reading is old, or its workspace is stopped.</InfoTip>
          </span>
        )}
      </div>
      {!plan && <NoPlan kind={reading.headroom.kind} claude={claude} />}
      {showWindows && (
        <ul aria-label={`${claude.claudeName} windows`} className="flex flex-col">
          {views.map((v) => (
            <WindowRow key={v.key} v={v} nowMs={nowMs} startOpen={v.key === lead} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** A Claude's name in the colour it keeps on every page (the Usage page's palette; its slot rides on the snapshot row), then its plan. */
function Name({ claude }: { claude: ClaudeUsage }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <Swatch slot={claude.slot} />
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-[14px] font-semibold">{claude.claudeName}</span>
        {claude.plan && <span className="shrink-0 text-[12px] text-muted">{claude.plan.charAt(0).toUpperCase() + claude.plan.slice(1)}</span>}
      </span>
    </span>
  );
}

/** A Claude without plan numbers: one line, with what it means behind an ⓘ. */
function NoPlan({ kind, claude }: { kind: 'no_limits' | 'signed_out' | 'unknown' | 'plan'; claude: ClaudeUsage }) {
  const line = kind === 'no_limits' ? 'No plan limits' : kind === 'signed_out' ? 'Not signed in' : 'Not read yet';
  const why =
    kind === 'no_limits'
      ? reasonText('no_limits')
      : kind === 'signed_out'
        ? 'Its plan limits show once it is signed in.'
        : claude.problem
          ? PROBLEM_WORDS[claude.problem]
          : 'The portal has not read its limits yet.';
  return (
    <p className="flex items-center gap-1 pb-1 text-[13px] text-muted">
      {line}
      <InfoTip label={`About ${line.toLowerCase()}`}>{why}</InfoTip>
    </p>
  );
}

/** One window: label, bar, percent used, time to reset. Tapped, it opens its reset time, speed and pace. */
function WindowRow({ v, nowMs, startOpen }: { v: WindowView; nowMs: number; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const tone = TONE[v.level];
  const detail = v.resetsAt || v.pace;
  return (
    <li>
      <button
        type="button"
        aria-expanded={detail ? open : undefined}
        disabled={!detail}
        onClick={() => setOpen((o) => !o)}
        className="press grid min-h-10 w-full grid-cols-[3.75rem_minmax(0,1fr)_2.75rem_4.25rem] items-center gap-2 rounded-lg text-left text-[13px] disabled:pointer-events-none"
      >
        <span className="truncate text-ink-soft">{v.label}</span>
        <Bar pct={v.reset ? 0 : v.usedPct} tone={tone} />
        <span className={cn('text-right font-semibold tabular-nums', TEXT[tone])}>{v.reset || v.usedPct === null ? '-' : pctText(v.usedPct)}</span>
        <span className="text-right whitespace-nowrap text-muted tabular-nums">{v.reset ? 'reset' : v.resetsAt ? leftText(v.resetsAt, nowMs) : '-'}</span>
      </button>
      {detail && open && <Detail v={v} nowMs={nowMs} />}
    </li>
  );
}

const EST = 'est.';

/** Where it resets, how fast it fills and where it lands: the estimates labelled, the unavailable ones "-" with the reason. */
function Detail({ v, nowMs }: { v: WindowView; nowMs: number }) {
  const p = v.pace;
  return (
    <dl className="mb-1.5 ml-2 grid grid-cols-[4.25rem_minmax(0,1fr)] gap-x-2 gap-y-1 pr-1 text-[13px] text-ink-soft">
      {v.resetsAt && (
        <Item term="Resets">
          <span className="tabular-nums">{localTime(v.resetsAt, nowMs)}</span>
        </Item>
      )}
      {p && !v.reset && (
        <>
          <Item term="Speed">
            <Fig f={p.speed} label="speed" show={(n) => `${signed(n)} pts/h`} tip={`Percentage points per hour, from this period’s readings (a least-squares line through 3 or more, else first to last). Not from tokens.${p.lowConfidence ? ' Few readings so far: rough.' : ''}`} />
          </Item>
          <Item term="Pace">
            <PaceFig p={p} />
          </Item>
          {p.status.value === 'over' && (
            <Item term="Runs out">
              <Fig f={p.etaAt} label="the time it runs out" show={(iso) => `${localTime(iso, nowMs)} (in ${leftText(iso, nowMs)})`} tip="When it reaches 100 % at this speed: now + (100 − used %) ÷ speed." />
            </Item>
          )}
        </>
      )}
    </dl>
  );
}

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{term}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5">{children}</dd>
    </>
  );
}

const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(Math.round(n * 10) / 10)}`;

const STATUS_WORD: Record<PaceStatus, string> = { under: 'under quota', over: 'over quota', exhausted: 'used up' };

/** Projected percent at the reset, with the under / over verdict in words (colour only adds to it). */
function PaceFig({ p }: { p: WindowPace }) {
  const status = p.status;
  return (
    <>
      <Fig f={p.projectedPct} label="pace" show={(n) => `${Math.round(n)} % at reset`} tip="Where it should stand at its reset if it keeps this speed: used % + speed × time left. Above 100 % it runs out first." />
      {status.basis !== 'unavailable' && <span className={cn('text-[12px] font-semibold', status.value === 'under' ? 'text-accent' : 'text-danger')}>{STATUS_WORD[status.value]}</span>}
    </>
  );
}

/** A derived figure: measured stands as it is, an estimate says "est." with its formula, unavailable is "-" with the reason. */
function Fig<T>({ f, show, label, tip }: { f: Figure<T>; show: (v: T) => ReactNode; label: string; tip: string }) {
  if (f.basis === 'unavailable')
    return (
      <span className="inline-flex items-center text-muted">
        -<InfoTip label={`Why ${label} is not available`}>{reasonText(f.reason)}</InfoTip>
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      {show(f.value)}
      {f.basis === 'estimate' && (
        <>
          <span className="text-[11px] text-muted">{EST}</span>
          <InfoTip label={`How ${label} is estimated`}>{tip}</InfoTip>
        </>
      )}
    </span>
  );
}
