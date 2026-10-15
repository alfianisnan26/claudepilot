// Crew headline (T-600, docs/prd/claude-usage.md §28.14): the summary block at the top of the Crew page and the Glance widget. Pure: the
// scorecard hands in the facts it already loaded, the programs it keeps and the Claudes' paces; nothing is read here.
//
// - Pace (quota) is a snapshot of NOW from claudeusage, global (a Claude's quota is not a program's), so an agent never gets it
//   (`no_source`). Ratio = sum(usedPct) / sum(evenPct) over the 5-hour `session` window of every Claude on its own plan that is signed in
//   and has a pace: signed out (`none`), pooled (`pool`), key and unknown Claudes are left out. Under 10 points of even pace in all the
//   windows is noise (they reset a moment ago): `windows_just_reset`. No Claude left: `no_claude`.
// - Counts and dollars use the same programs and the same ticket attribution as the program rows; a ticket two programs touched counts
//   once in the global figures and once in each program row. Every division is guarded: nothing to divide by is `no_samples`, never 0.
// (This file is lab/headline.ts, not summary.ts: summary.ts is the efficiency lab's period summary, T-287.)

import type { ClaudeUsage, CrewCreatedClosedRow, CrewFigure, CrewPace, CrewPaceClaude, CrewProgramCount, CrewSummary, CrewSummaryWindow, CrewUnavailable } from '@portal/contracts';
import { programTickets, type CrewFacts, type CrewTicket, type Program } from './scorecard.js';

/** The part of a Claude's usage the headline reads (a `ClaudeUsage` satisfies it). */
export type PaceClaude = Pick<ClaudeUsage, 'claudeId' | 'claudeName' | 'runsOn' | 'state'> & { windows: readonly Pick<ClaudeUsage['windows'][number], 'key' | 'usedPct' | 'pace'>[] };

/** Where the Claudes' paces come from (claudeusage's snapshot). Absent or failing: pace is `no_source`. */
export type PaceSource = () => Promise<readonly PaceClaude[]>;

/** Below this sum of even-pace points the windows have only just reset and a ratio would be noise. */
export const MIN_EVEN_PCT = 10;
/** Under this ratio the quota is not being spent: the unused part at reset is shown. */
export const UNDERUSE_RATIO = 0.9;

const SRC = {
  pace: 'claudeusage: the session window of each Claude on its own plan (WindowPace.usedPct / evenPct), summed',
  paceWeekly: 'claudeusage: the week window of each Claude on its own plan (WindowPace), summed',
  requests: 'chat_usage.requests of the programs’ sessions in the window',
  cost: 'chat_usage.cost_usd (Claude Code’s price estimate) of the programs’ sessions in the window',
  tickets: 'tickets (status, created_at, closed_at) of the programs',
  ratio: 'a Claude’s usedPct / evenPct',
} as const;

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const meas = (value: number, source: string): CrewFigure => ({ value, basis: 'measured', source });
const est = (value: number, source: string): CrewFigure => ({ value, basis: 'estimate', source });
const none = (reason: CrewUnavailable, source: string): CrewFigure => ({ value: null, basis: 'unavailable', source, reason });

/** A pace of one Claude's window, or null when it has no usable usedPct and evenPct. */
function paceOf(c: PaceClaude, key: string): { used: number; even: number; projected: number | null } | null {
  const w = c.windows.find((x) => x.key === key);
  const even = w?.pace?.evenPct.value;
  if (!w || w.usedPct === null || even === null || even === undefined || !Number.isFinite(even) || !Number.isFinite(w.usedPct)) return null;
  const proj = w.pace?.projectedPct.value;
  return { used: w.usedPct, even, projected: proj === null || proj === undefined || !Number.isFinite(proj) ? null : proj };
}

/** Signed in, on its own plan, readable. */
const readable = (_c: PaceClaude) => true;

function ratioOver(rows: readonly { used: number; even: number }[], source: string): CrewFigure {
  if (!rows.length) return none('no_claude', source);
  const even = rows.reduce((s, r) => s + r.even, 0);
  if (even < 0) return none('windows_just_reset', source);
  return est(round(rows.reduce((s, r) => s + r.used, 0) / even, 2), source);
}

/** The pace block. `paces` null: no source (an agent's read, or claudeusage absent or failing). */
export function paceBlock(paces: readonly PaceClaude[] | null): CrewPace {
  if (!paces) return { ratio: none('no_source', SRC.pace), unusedAtResetPct: null, weekly: none('no_source', SRC.paceWeekly), claudes: [] };
  const live = paces.filter(readable);
  const sess = live.flatMap((c) => {
    const p = paceOf(c, 'session');
    return p ? [{ c, ...p }] : [];
  });
  const ratio = ratioOver(sess, SRC.pace);
  const claudes: CrewPaceClaude[] = sess.map(({ c, used, even, projected }) => ({
    claude: c.claudeId,
    label: c.claudeName,
    usedPct: used,
    evenPct: even,
    ratio: even > 0 ? est(round(used / even, 2), SRC.ratio) : none('no_samples', SRC.ratio),
    projectedPct: projected,
  }));
  let unused: number | null = null;
  if (ratio.value !== null && ratio.value < UNDERUSE_RATIO) {
    const proj = sess.flatMap((s) => (s.projected === null ? [] : [s.projected]));
    if (proj.length) unused = round(Math.max(0, 100 - proj.reduce((a, b) => a + b, 0) / proj.length), 1);
  }
  const week = live.flatMap((c) => {
    const p = paceOf(c, 'week');
    return p ? [p] : [];
  });
  const weekly = week.length ? ratioOver(week, SRC.paceWeekly) : none('no_source', SRC.paceWeekly);
  return { ratio, unusedAtResetPct: unused, weekly, claudes };
}

/** One window's figures over the kept programs. */
function windowFigures(programs: readonly Program[], facts: CrewFacts, fromMs: number, toMs: number): CrewSummaryWindow {
  const hours = (toMs - fromMs) / 3_600_000;
  const ids = new Set<string>();
  for (const p of programs) for (const m of p.members) ids.add(m);
  const rows = facts.usage(fromMs, toMs, ids);
  const requests = rows.reduce((s, r) => s + r.requests, 0);
  const usd = rows.reduce((s, r) => s + r.costUsd, 0);
  const base = {
    fromMs,
    toMs,
    requestsPerHour: hours > 0 ? meas(round(requests / hours, 2), SRC.requests) : none('no_samples', SRC.requests),
    usdPerHour: hours > 0 ? est(round(usd / hours, 3), SRC.cost) : none('no_samples', SRC.cost),
  };
  if (!facts.tickets) {
    const u = none('no_source', SRC.tickets);
    return { ...base, resolved: u, wontDo: u, resolvedByProgram: [], perResolvedUsd: u, createdPerClosed: u, createdPerClosedByProgram: [] };
  }
  const inWin = (ms: number | null) => ms !== null && ms >= fromMs && ms < toMs;
  const done = (t: CrewTicket) => t.status === 'done' && inWin(t.closedAtMs);
  const wont = (t: CrewTicket) => t.status === 'wont_do' && inWin(t.closedAtMs);
  const closed = (t: CrewTicket) => done(t) || wont(t);
  const created = (t: CrewTicket) => inWin(t.createdAtMs);
  const per = programs.map((p) => ({ p, tickets: programTickets(p, facts.tickets!, facts.sessions) }));
  const all = new Map<string, CrewTicket>();
  for (const x of per) for (const t of x.tickets) all.set(t.id, t);
  const global = [...all.values()];
  const count = (list: readonly CrewTicket[], f: (t: CrewTicket) => boolean) => list.filter(f).length;
  const ratio = (c: number, k: number): CrewFigure => (k > 0 ? est(round(c / k, 2), SRC.tickets) : none('no_samples', SRC.tickets));
  const resolved = count(global, done);
  const resolvedByProgram: CrewProgramCount[] = per.map(({ p, tickets }) => ({ program: p.id, title: p.title, count: count(tickets, done) }));
  const byProgram: CrewCreatedClosedRow[] = per.map(({ p, tickets }) => {
    const c = count(tickets, created);
    const k = count(tickets, closed);
    return { program: p.id, title: p.title, created: c, closed: k, ratio: ratio(c, k) };
  });
  return {
    ...base,
    resolved: meas(resolved, SRC.tickets),
    wontDo: meas(count(global, wont), SRC.tickets),
    resolvedByProgram,
    perResolvedUsd: resolved > 0 ? est(round(usd / resolved, 2), SRC.cost) : none('no_samples', SRC.cost),
    createdPerClosed: ratio(count(global, created), count(global, closed)),
    createdPerClosedByProgram: byProgram,
  };
}

/**
 * The headline over the kept programs (an agent's read keeps only its own, and gets `paces` null). `previous` is the window before, the same
 * length, only with `compare`; pace is a snapshot of now and is the same in both.
 */
export function buildHeadline(input: { programs: readonly Program[]; facts: CrewFacts; windowMs: number; compare: boolean; paces: readonly PaceClaude[] | null }): CrewSummary {
  const to = input.facts.nowMs;
  const w = input.windowMs;
  return {
    pace: paceBlock(input.paces),
    current: windowFigures(input.programs, input.facts, to - w, to),
    previous: input.compare ? windowFigures(input.programs, input.facts, to - 2 * w, to - w) : null,
  };
}
