import { cn, Menu, Segmented, Spinner, useToast } from '@isnanme/ui';
import { USAGE_RANGES, type ClaudeUsage, type ClaudeUsageHistory, type SnoozeKind, type SnoozeUntil, type UsageRange } from '@portal/contracts';
import { BellOff, ChevronDown, CircleCheck, CircleQuestionMark, CircleX, Infinity as NoLimit, RefreshCw, TriangleAlert, UserX, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { FigureValue } from '../figure';
import { claudeUsageApi } from './api';
import { agoText, localTime, pctText, planText, PROBLEM_WORDS, STATE_WORDS, stateTone, TONE_TEXT, toneOf } from './format';
import { aheadText, paceRows, projectionRisk, riskWords } from './pace';
import { WindowLine } from './Meter';
import { Spark } from './Spark';
import { limitReportWords, unavailableWords } from './unknownWords';
import { headroomOfClaude, replaceClaude, windowAt } from './useClaudeUsage';

const ICON: Record<ClaudeUsage['state'], LucideIcon> = {
  ok: CircleCheck,
  near: TriangleAlert,
  exhausted: CircleX,
  unknown: CircleQuestionMark,
  signed_out: UserX,
  no_limits: NoLimit,
};

const DAY = 86_400_000;
const RANGE_MS: Record<UsageRange, number> = { '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY };

/** The state as an icon that says it in words to a screen reader and on hover. */
function StateIcon({ c }: { c: ClaudeUsage }) {
  const Icon = ICON[c.state];
  return (
    <span role="img" aria-label={STATE_WORDS[c.state]} title={STATE_WORDS[c.state]} className={cn('shrink-0', TONE_TEXT[stateTone(c)])}>
      <Icon className="size-[18px]" aria-hidden="true" />
    </span>
  );
}

/** Reads this Claude now. The portal refuses a pool, a stopped workspace and a second check within half a minute, and says why. */
function CheckButton({ c }: { c: ClaudeUsage }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const why = c.runsOn === 'pool' ? 'No plan limits on a pool' : !c.workspaceRunning ? 'Start the workspace to check' : '';
  return (
    <button
      type="button"
      disabled={busy || !!why}
      aria-label={`Check ${c.claudeName} now`}
      title={why || (c.checkedAt ? `Check now · read ${agoText(c.checkedAt, Date.now())}` : 'Check now')}
      onClick={async () => {
        setBusy(true);
        try {
          replaceClaude(await claudeUsageApi.check(c.claudeId));
        } catch (e) {
          toast(errorText(e, 'Couldn’t check.'), 'error');
        } finally {
          setBusy(false);
        }
      }}
      className="press tap:size-11 inline-flex size-8 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {busy ? <Spinner className="size-4" /> : <RefreshCw className="size-4" aria-hidden="true" />}
    </button>
  );
}

/** One line for a Claude without plan windows. */
function Plain({ c }: { c: ClaudeUsage }) {
  // T-255: an unknown plan reading says why (no usage endpoint, not read yet), with the probe's own problem in the ⓘ.
  const why = c.state === 'unknown' ? unavailableWords(c) : null;
  const text = c.state === 'no_limits' ? 'No plan limits' : c.state === 'signed_out' ? 'Not signed in' : why ? why.line : c.problem ? 'Couldn’t read usage' : 'Not read yet';
  return (
    <p className="flex items-center gap-1 text-[13px] text-muted">
      {text}
      {c.state === 'unknown' && (c.problem || why) && (
        <InfoTip label="Why">
          {c.problem ? `${PROBLEM_WORDS[c.problem]}. ` : ''}
          {why?.tip ?? ''}
        </InfoTip>
      )}
    </p>
  );
}

/** T-255: why its usage is unknown (never 0 %), and a limit a chat reported, each a short line with its detail in the ⓘ. */
function UnknownLines({ c, nowMs }: { c: ClaudeUsage; nowMs: number }) {
  const why = c.state === 'signed_out' || c.state === 'no_limits' ? null : unavailableWords(c);
  const report = limitReportWords(c, nowMs);
  if (!why && !report) return null;
  return (
    <>
      {report && (
        <p className="mt-1.5 flex items-center gap-1 text-[13px] text-danger [overflow-wrap:anywhere]">
          {report.line}
          <InfoTip label="Where this comes from">{report.tip}</InfoTip>
        </p>
      )}
      {why && (
        <p className="mt-1.5 flex items-center gap-1 text-[13px] text-muted [overflow-wrap:anywhere]">
          {why.line}
          <InfoTip label="Why">{why.tip}</InfoTip>
        </p>
      )}
    </>
  );
}

/** When a Claude is out of usage: another Claude on the same workspace that has room, if one does. Only said, never done for you. */
function roomElsewhere(c: ClaudeUsage, peers: ClaudeUsage[], nowMs: number): string | null {
  if (c.state !== 'exhausted') return null;
  const options = peers
    .filter((p) => p.claudeId !== c.claudeId && p.workspaceId === c.workspaceId)
    .map((p) => ({ p, h: headroomOfClaude(p, nowMs) }))
    .filter(({ h }) => (h.kind === 'plan' && !h.exhausted && h.limiting) || h.kind === 'no_limits');
  const plan = options.filter(({ h }) => h.kind === 'plan').sort((a, b) => b.h.limiting!.leftPct - a.h.limiting!.leftPct)[0];
  const best = plan ?? options[0];
  if (!best) return null;
  return best.h.kind === 'plan' ? `Room on ${best.p.claudeName} · ${Math.round(best.h.limiting!.leftPct)} % left` : `${best.p.claudeName} has no plan limits`;
}

/** Extra usage, when the plan has it on: the amounts are in minor units of the currency. */
function Extra({ c }: { c: ClaudeUsage }) {
  const e = c.extra;
  if (!e?.enabled) return null;
  const money = (v: number | null) => (v === null ? null : new Intl.NumberFormat([], { style: 'currency', currency: e.currency ?? 'USD' }).format(v / 100));
  const of = e.used !== null && e.limit !== null ? `${money(e.used)} of ${money(e.limit)}` : null;
  return (
    <p className="text-[13px] text-muted">
      Extra usage {pctText(e.usedPct)}
      {of && ` · ${of}`}
    </p>
  );
}

/** When a Claude is estimated to run out before its window resets: one line (gold; muted while the estimate is low confidence), the numbers behind it in the ⓘ. */
function RiskLine({ c }: { c: ClaudeUsage }) {
  const risk = projectionRisk(c);
  if (!risk) return null;
  const { line, tip } = riskWords(risk);
  return (
    <p className={cn('mt-1.5 flex items-center gap-1.5 text-[13px]', risk.low ? 'text-muted' : 'text-gold')}>
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{line}</span>
      <InfoTip text="est." label="How this is estimated" className="-my-1">
        {tip}
      </InfoTip>
    </p>
  );
}

const PACE_FORMULA = 'Speed: points an hour from this period’s readings (least squares over three or more, else first to last), never from tokens. At reset = used + speed × time left. Out at = when it would reach 100 %. Even = where an even spend over the whole window would stand.';

/** The numbers behind a window's bar: its speed, where it ends up at the reset, when it would run out, and how far ahead of an even spend it is. */
function PaceDetails({ c }: { c: ClaudeUsage }) {
  const rows = paceRows(c);
  if (!rows.length) return null;
  return (
    <div className="mt-3 border-t border-line pt-3">
      <h3 className="mb-2 flex items-center gap-1 text-[13px] font-semibold">
        Pace
        <InfoTip text="est." label="How pace is estimated">
          {PACE_FORMULA}
        </InfoTip>
      </h3>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.key} className="grid grid-cols-[3.75rem_minmax(0,1fr)] items-baseline gap-2 text-[13px]">
            <span className="truncate text-ink-soft">{r.label}</span>
            {r.speed.basis === 'unavailable' ? (
              <span className="text-muted">
                <FigureValue figure={r.speed} format={String} />
              </span>
            ) : (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted tabular-nums">
                <span>{`${r.speed.value > 0 ? '+' : ''}${r.speed.value} pts/h`}</span>
                <span>{r.projectedPct.basis === 'unavailable' ? '-' : `${Math.round(r.projectedPct.value)} % at reset`}</span>
                <span>{r.outAt.text === '-' ? '-' : r.outAt.text === 'after reset' ? 'out after reset' : r.outAt.text === 'now' ? 'out now' : `out ~${r.outAt.text}`}</span>
                {r.aheadPts.basis !== 'unavailable' && <span>{`${aheadText(r.aheadPts.value)} vs even`}</span>}
                {r.low && (
                  <InfoTip text="low" label="Low confidence" className="-my-1">
                    Fewer than three readings, or a short span: shown, never alerted on.
                  </InfoTip>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A Claude's windows over a day, a week or a month, a line each. Asked for when the row opens and when a new reading lands. */
function History({ c }: { c: ClaudeUsage }) {
  const [range, setRange] = useState<UsageRange>('7d');
  const [h, setH] = useState<ClaudeUsageHistory | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    claudeUsageApi.history(c.claudeId, range).then(
      (next) => live && (setH(next), setFailed(false)),
      () => live && setFailed(true),
    );
    return () => void (live = false);
  }, [c.claudeId, range, c.checkedAt]);
  const to = h ? Date.parse(h.to) : Date.now();
  const from = h ? Date.parse(h.from) : to - RANGE_MS[range];
  const labels = new Map(c.windows.map((w) => [w.key, windowAt(w, Date.now())]));
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <div className="w-44">
          <Segmented label="Range" value={range} options={USAGE_RANGES.map((r) => ({ value: r, label: r }))} onChange={setRange} />
        </div>
        <Snooze c={c} />
      </div>
      {failed && !h ? (
        <p className="py-2 text-[13px] text-muted">Couldn’t load the history.</p>
      ) : !h ? (
        <div className="skeleton h-24 rounded-2xl" />
      ) : h.series.length === 0 ? (
        <p className="py-2 text-[13px] text-muted">Nothing read in this range.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {h.series.map((s) => {
            const last = s.points.at(-1)?.usedPct ?? null;
            const w = labels.get(s.key);
            return (
              <li key={s.key} className="grid grid-cols-[3.75rem_minmax(0,1fr)_2.75rem] items-center gap-2 text-[13px]">
                <span className="truncate text-ink-soft">{s.label}</span>
                <Spark
                  points={s.points}
                  fromMs={from}
                  toMs={to}
                  marks
                  tone={w ? toneOf(w.level) : 'ok'}
                  className="h-10 w-full"
                  label={`${s.label}, ${last === null ? 'no reading' : `${Math.round(last)} % now`}, over ${range}`}
                />
                <span className="text-right font-semibold text-ink-soft tabular-nums">{pctText(last)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <PaceDetails c={c} />
    </div>
  );
}

/** Silences this Claude's alerts for a while; the readings go on. */
function Snooze({ c }: { c: ClaudeUsage }) {
  const toast = useToast();
  const set = async (until: SnoozeUntil | null, kind?: SnoozeKind) => {
    try {
      replaceClaude(until ? await claudeUsageApi.snooze(c.claudeId, until, kind) : await claudeUsageApi.unsnooze(c.claudeId, kind));
    } catch (e) {
      toast(errorText(e, 'Couldn’t change the snooze.'), 'error');
    }
  };
  const quiet = !!c.snoozedUntil || !!c.projectionSnoozedUntil;
  return (
    <div className="flex items-center gap-1.5 text-[12.5px] text-muted">
      {c.snoozedUntil ? <span>until {localTime(c.snoozedUntil)}</span> : c.projectionSnoozedUntil && <span>projections until {localTime(c.projectionSnoozedUntil)}</span>}
      <Menu
        label={`Snooze ${c.claudeName}’s alerts`}
        align="right"
        trigger={<BellOff className={cn('size-4', quiet && 'text-gold')} aria-hidden="true" />}
        items={[
          { label: 'Snooze 1 hour', onSelect: () => void set('1h') },
          { label: 'Snooze 4 hours', onSelect: () => void set('4h') },
          { label: 'Until it resets', onSelect: () => void set('reset') },
          ...(c.snoozedUntil ? [{ label: 'Alert me again', onSelect: () => void set(null) }] : []),
          ...(c.runsOn === 'plan' ? [c.projectionSnoozedUntil ? { label: 'Warn about pace again', onSelect: () => void set(null, 'projection') } : { label: 'Mute pace warnings', onSelect: () => void set('reset', 'projection') }] : []),
        ]}
      />
    </div>
  );
}

/** One Claude: where it stands at a glance, its plan windows, and its history behind a chevron. */
export function ClaudeRow({ c, peers, nowMs, open, onToggle }: { c: ClaudeUsage; peers: ClaudeUsage[]; nowMs: number; open: boolean; onToggle: () => void }) {
  const plan = planText(c.plan);
  const windows = c.runsOn === 'plan' ? c.windows : [];
  const tone = stateTone(c);
  const room = roomElsewhere(c, peers, nowMs);
  return (
    <li id={c.claudeId} className="scroll-mt-24 rounded-[24px] border border-line bg-surface p-4">
      <div className="flex items-center gap-1">
        <button type="button" onClick={onToggle} aria-expanded={open} className="press -m-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-xl p-1 text-left">
          <StateIcon c={c} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span dir="auto" className="truncate text-[15px] font-semibold">
                {c.claudeName}
              </span>
              {plan && <span className="shrink-0 rounded-md bg-surface-2 px-1.5 text-[11px] font-semibold text-ink-soft">{plan}</span>}
              {c.snoozedUntil && <BellOff className="size-3 shrink-0 self-center text-gold" aria-label={`Alerts snoozed until ${localTime(c.snoozedUntil)}`} />}
            </span>
            <span className="block truncate text-[12.5px] text-muted">
              {c.workspaceName}
              {!c.workspaceRunning && ' · stopped'}
              {c.stale && c.checkedAt && ` · ${agoText(c.checkedAt, nowMs)}`}
            </span>
          </span>
          {c.trend && (
            <Spark
              points={c.trend.points}
              fromMs={nowMs - 7 * DAY}
              toMs={nowMs}
              tone={tone}
              className="hidden h-6 w-16 shrink-0 sm:block"
              label={`${c.trend.label}, last 7 days`}
            />
          )}
          <ChevronDown className={cn('size-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden="true" />
        </button>
        <CheckButton c={c} />
      </div>
      <div className={cn('mt-3', c.stale && 'opacity-60')}>
        {windows.length ? (
          <ul className="flex flex-col gap-2">
            {windows.map((w) => (
              <WindowLine key={w.key} w={w} nowMs={nowMs} />
            ))}
          </ul>
        ) : (
          <Plain c={c} />
        )}
        {windows.length > 0 && <UnknownLines c={c} nowMs={nowMs} />}
        <RiskLine c={c} />
        <Extra c={c} />
        {room && <p className="mt-1.5 text-[13px] text-ink-soft [overflow-wrap:anywhere]">{room}</p>}
      </div>
      {open && <History c={c} />}
    </li>
  );
}
