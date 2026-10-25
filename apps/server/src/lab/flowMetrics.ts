// Pilot metrics (T-2360, docs/prd/claude-usage.md §28.15): flow times per ticket stage, the efficiency and effectiveness scores, and the
// findings. Pure: `flowMetricsData.ts` loads the facts and `metricsService.ts` puts them together; nothing is read here and nothing reads
// the clock (every function takes its `nowMs` or its window).
//
// - A STAGE is a duration between two recorded moments of a done ticket. A ticket that lacks one of the two is LEFT OUT of that stage and
//   counted in its `excluded`, never counted as 0. A duration below 0 (clocks of two writers) is left out the same way.
// - Won't-do is counted apart: it is in no stage.
// - Aggregates are n, the median and the 90th percentile, nearest rank (scorecard.ts `percentile`, the crew scorecard's rule).
// - A score is the weighted mean of its components; a component whose input the portal does not have is `unavailable` with a reason, and
//   its weight is shared by the others (the basis line says which were left out). Never a 0 in its place.

import {
  METRICS_STAGES,
  type CrewUnavailable,
  type MetricsComponent,
  type MetricsFlowGroup,
  type MetricsFlowWindow,
  type MetricsGroupBy,
  type MetricsInsight,
  type MetricsOpenWork,
  type MetricsProgram,
  type MetricsScore,
  type MetricsStage,
  type MetricsStageStat,
  type MetricsTargets,
  type MetricsTicketRow,
  type MetricsTrendKey,
  TICKET_TAG,
} from '@portal/contracts';
import { percentile } from './scorecard.js';

const HOUR = 3_600_000;

/* ---------- The facts of one closed ticket ---------- */

export interface FlowTicketFacts {
  id: string;
  type: string;
  priority: string;
  status: 'done' | 'wont_do';
  createdAtMs: number;
  closedAtMs: number;
  tags: readonly string[];
  /** The unit lead: the first `area-*` tag, else `lead:<the lineage root of its holder>`, else `unrecorded` (the loader decides). */
  lead: string;
  /** The crew (lineage root, crew_scorecard's program id) of the session that held it; null or absent: no session held it. An agent reads only its own crew's. */
  crew?: string | null;
  /** Every move into in_progress, oldest first. */
  starts: readonly number[];
  /** The first comment written by an agent session (`session:*` actor), or null. */
  firstAgentCommentMs: number | null;
  /** QA and review verdicts (comment data `verdict`) and self-test lines (`Self-test: ... pass|fail N`), oldest first. */
  verdicts: readonly { atMs: number; pass: boolean }[];
  /** The merge gate's `merged` records (ticket_merge_status), oldest first. */
  merges: readonly number[];
}

export interface FlowRow {
  id: string;
  type: string;
  priority: string;
  status: 'done' | 'wont_do';
  createdAtMs: number;
  closedAtMs: number;
  tags: readonly string[];
  lead: string;
  crew?: string | null;
  stages: Record<MetricsStage, number | null>;
  /** Verdicts in the test stage, and how many of them failed; null without a test stage. */
  rounds: number | null;
  fails: number | null;
  /** Created to closed, ms (a won't-do's life; a done ticket's equals `stages.resolve`). */
  lifeMs: number | null;
}

const span = (from: number | null | undefined, to: number | null | undefined): number | null =>
  from === null || from === undefined || to === null || to === undefined || !Number.isFinite(from) || !Number.isFinite(to) || to < from ? null : to - from;

const NO_STAGES = (): Record<MetricsStage, number | null> => ({ start: null, report: null, implement: null, test: null, deliver: null, resolve: null, work: null });

/**
 * One closed ticket's stages (the rules of §28.15):
 * - start: created to the first move into in_progress.
 * - report: created to the first comment by an agent session.
 * - implement: the first in_progress to the first verdict at or after it; with none, to the first merge at or after it.
 * - test: the first verdict (at or after the first in_progress) to the last PASSING verdict at or before the last merge (no merge: at or
 *   before the close). rounds = the verdicts in that span, fails = the failing ones (rework). No passing verdict: no test stage.
 * - deliver: the last merge at or before the close to the close.
 * - resolve: created to the close. work: the first in_progress to the close.
 * Nothing after the close counts. A won't-do ticket has no stage (its life is `lifeMs`).
 */
export function ticketFlow(t: FlowTicketFacts): FlowRow {
  const close = t.closedAtMs;
  const base = { id: t.id, type: t.type, priority: t.priority, status: t.status, createdAtMs: t.createdAtMs, closedAtMs: close, tags: t.tags, lead: t.lead, crew: t.crew ?? null, lifeMs: span(t.createdAtMs, close) };
  if (t.status !== 'done') return { ...base, stages: NO_STAGES(), rounds: null, fails: null };
  const upTo = (ms: number) => ms <= close;
  const start = t.starts.find((s) => upTo(s) && s >= t.createdAtMs) ?? null;
  const verdicts = t.verdicts.filter((v) => upTo(v.atMs) && (start === null || v.atMs >= start));
  const merges = t.merges.filter(upTo);
  const lastMerge = merges.length ? merges[merges.length - 1]! : null;
  const firstVerdict = verdicts[0] ?? null;
  const implEnd = start === null ? null : (firstVerdict?.atMs ?? merges.find((m) => m >= start) ?? null);
  // The test stage ends at the last pass that the merge (or, without one, the close) rested on.
  const limit = lastMerge ?? close;
  let lastPass: number | null = null;
  for (let i = verdicts.length - 1; i >= 0; i--) {
    const v = verdicts[i]!;
    if (v.pass && v.atMs <= limit) {
      lastPass = i;
      break;
    }
  }
  const inTest = lastPass === null ? [] : verdicts.slice(0, lastPass + 1);
  const stages: Record<MetricsStage, number | null> = {
    start: span(t.createdAtMs, start),
    report: span(t.createdAtMs, t.firstAgentCommentMs !== null && upTo(t.firstAgentCommentMs) ? t.firstAgentCommentMs : null),
    implement: span(start, implEnd),
    test: lastPass === null ? null : span(firstVerdict!.atMs, verdicts[lastPass]!.atMs),
    deliver: span(lastMerge, close),
    resolve: span(t.createdAtMs, close),
    work: span(start, close),
  };
  return { ...base, stages, rounds: stages.test === null ? null : inTest.length, fails: stages.test === null ? null : inTest.filter((v) => !v.pass).length };
}

/* ---------- Aggregates ---------- */

const sortNum = (xs: number[]) => xs.sort((a, b) => a - b);

export function stageStat(rows: readonly FlowRow[], stage: MetricsStage): MetricsStageStat {
  const done = rows.filter((r) => r.status === 'done');
  const vals = sortNum(done.map((r) => r.stages[stage]).filter((v): v is number => v !== null));
  return { stage, n: vals.length, excluded: done.length - vals.length, medianMs: percentile(vals, 0.5), p90Ms: percentile(vals, 0.9) };
}

const inWindow = (r: FlowRow, fromMs: number, toMs: number) => r.closedAtMs >= fromMs && r.closedAtMs < toMs;

/** The stage figures of the tickets closed in [fromMs, toMs). */
export function flowWindow(rows: readonly FlowRow[], fromMs: number, toMs: number): MetricsFlowWindow {
  const win = rows.filter((r) => inWindow(r, fromMs, toMs));
  const done = win.filter((r) => r.status === 'done');
  const wont = win.filter((r) => r.status === 'wont_do');
  const tested = done.filter((r) => r.rounds !== null);
  return {
    fromMs,
    toMs,
    done: done.length,
    wontDo: wont.length,
    wontDoMedianMs: percentile(sortNum(wont.map((r) => r.lifeMs).filter((v): v is number => v !== null)), 0.5),
    stages: METRICS_STAGES.map((s) => stageStat(done, s)),
    rounds: {
      n: tested.length,
      medianRounds: percentile(sortNum(tested.map((r) => r.rounds!)), 0.5),
      reworked: tested.filter((r) => (r.fails ?? 0) > 0).length,
      fails: tested.reduce((s, r) => s + (r.fails ?? 0), 0),
    },
  };
}

/** The group keys of a row: a ticket can be in more than one program, in exactly one lead, type and priority. */
export function groupKeysOf(r: FlowRow, by: MetricsGroupBy, programs: readonly MetricsProgram[]): string[] {
  switch (by) {
    case 'program': {
      const ids = programs.filter((p) => p.kind === 'tickets' && inProgram(r.tags, p)).map((p) => p.id);
      return ids.length ? ids : ['unrecorded'];
    }
    case 'lead':
      return [r.lead || 'unrecorded'];
    case 'type':
      return [r.type || 'unrecorded'];
    case 'priority':
      return [r.priority || 'unrecorded'];
  }
}

/** The window [nowMs - windowMs, nowMs) and the one before it, for the whole set and per group (most done first, then by key). */
export function groupFlow(rows: readonly FlowRow[], nowMs: number, windowMs: number, groupBy: MetricsGroupBy | null, programs: readonly MetricsProgram[]): { total: MetricsFlowGroup; groups: MetricsFlowGroup[] } {
  const one = (key: string, list: readonly FlowRow[]): MetricsFlowGroup => ({
    key,
    current: flowWindow(list, nowMs - windowMs, nowMs),
    previous: flowWindow(list, nowMs - 2 * windowMs, nowMs - windowMs),
  });
  const total = one('total', rows);
  if (!groupBy) return { total, groups: [] };
  const by = new Map<string, FlowRow[]>();
  for (const r of rows) for (const k of groupKeysOf(r, groupBy, programs)) (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  const groups = [...by].map(([k, list]) => one(k, list)).sort((a, b) => b.current.done - a.current.done || b.previous.done - a.previous.done || a.key.localeCompare(b.key));
  return { total, groups };
}

/** The drill-down rows: closed in [fromMs, toMs), newest close first. */
export function ticketRows(rows: readonly FlowRow[], fromMs: number, toMs: number, programs: readonly MetricsProgram[]): MetricsTicketRow[] {
  return rows
    .filter((r) => inWindow(r, fromMs, toMs))
    .sort((a, b) => b.closedAtMs - a.closedAtMs || a.id.localeCompare(b.id))
    .map((r) => ({
      ticket: r.id,
      type: r.type,
      priority: r.priority,
      status: r.status,
      closedAtMs: r.closedAtMs,
      lead: r.lead,
      programs: programs.filter((p) => p.kind === 'tickets' && inProgram(r.tags, p)).map((p) => p.id),
      stages: { ...r.stages },
      rounds: r.rounds,
      fails: r.fails,
    }));
}

/* ---------- Programs ---------- */

/** The default of `lab.metricsPrograms`: what the live tickets are tagged with (most carry `claudepilot` or `konfersi`, few `program-*`). */
export const DEFAULT_METRICS_PROGRAMS =
  'all=All|*|4/24/2;claudepilot=ClaudePilot|claudepilot,program-claudepilot;konfersi=Konfersi|konfersi,konfersi-migration,program-konfersi;memor-id=memor.id|commits';
export const DEFAULT_TARGETS: MetricsTargets = { closuresPerHour: 2, resolveHours: 24, reviewHours: 2 };
export const DEFAULT_ALL_TARGETS: MetricsTargets = { closuresPerHour: 4, resolveHours: 24, reviewHours: 2 };

const PROGRAM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface ParsedMetricsProgram {
  id: string;
  label: string;
  kind: 'all' | 'tickets' | 'commits';
  tags: string[];
  targets: MetricsTargets | null;
}

function parseTargets(raw: string | undefined): MetricsTargets | null | 'bad' {
  if (raw === undefined || raw === '') return null;
  const f = raw.split('/').map((x) => Number(x.trim()));
  if (f.length !== 3 || f.some((n) => !Number.isFinite(n) || n <= 0 || n > 10_000)) return 'bad';
  return { closuresPerHour: f[0]!, resolveHours: f[1]!, reviewHours: f[2]! };
}

/**
 * `lab.metricsPrograms`: entries split by ";", each `id=Label|tag1,tag2|closures-per-hour/resolve-hours/review-hours` (label and targets
 * optional). The tags `*` mean every ticket (only for id `all`, which sets the targets of the whole view); `commits` marks a program with
 * no tickets. `errors` lists what was refused; the rest still parses (the validator refuses a value with any error).
 */
export function parseMetricsPrograms(raw: unknown): { programs: ParsedMetricsProgram[]; errors: string[] } {
  const programs: ParsedMetricsProgram[] = [];
  const errors: string[] = [];
  if (typeof raw !== 'string') return { programs, errors: ['not text'] };
  for (const part of raw.split(';')) {
    if (!part.trim()) continue;
    const f = part.split('|').map((x) => x.trim());
    const [head = '', tagsRaw = '', targetsRaw] = f;
    const eq = head.indexOf('=');
    const id = (eq < 0 ? head : head.slice(0, eq)).trim();
    const label = (eq < 0 ? id : head.slice(eq + 1).trim()) || id;
    if (f.length < 2 || f.length > 3 || !PROGRAM_ID.test(id) || label.length > 40) {
      errors.push(`"${part.trim().slice(0, 40)}": write id=Label|tags|targets`);
      continue;
    }
    if (programs.some((p) => p.id === id)) {
      errors.push(`${id}: listed twice`);
      continue;
    }
    const targets = parseTargets(targetsRaw);
    if (targets === 'bad') {
      errors.push(`${id}: targets are three numbers above 0, closures per hour/resolve hours/review hours`);
      continue;
    }
    if (id === 'all') {
      if (tagsRaw !== '*') errors.push('all: its tags are *');
      else programs.push({ id, label, kind: 'all', tags: [], targets });
      continue;
    }
    if (tagsRaw === 'commits') {
      programs.push({ id, label, kind: 'commits', tags: [], targets });
      continue;
    }
    const tags = tagsRaw.split(',').map((x) => x.trim()).filter(Boolean);
    if (!tags.length || tags.some((t) => t.length > 30 || !TICKET_TAG.test(t))) {
      errors.push(`${id}: tags are ticket tags split by commas`);
      continue;
    }
    programs.push({ id, label, kind: 'tickets', tags: [...new Set(tags)], targets });
  }
  return { programs, errors };
}

const COMMITS_TEXT = 'This program has no tickets in the portal, and the portal keeps no commit history (workspace git keeps the repo state and scan events only), so its flow is unavailable.';

/**
 * At most this many programs come from `program-*` tags (each one costs a snapshot row every 10 min); the setting's and the flow programs
 * always count. The tags arrive ranked (loadProgramTags: tickets touched in the last 30 days, then all their tickets).
 */
export const MAX_TAG_PROGRAMS = 12;

/**
 * The programs, `all` first: the setting's, then a `program-*` tag no program covers (`program-x` is program `x`; the first
 * MAX_TAG_PROGRAMS of the ranked tags, shown by id), then a `flow.programs` tag no program covers (named as the flow watchdog names it).
 */
export function resolvePrograms(input: { setting: unknown; programTags: readonly string[]; flow: readonly { name: string; tag: string }[] }): MetricsProgram[] {
  const parsed = parseMetricsPrograms(input.setting).programs;
  const all = parsed.find((p) => p.kind === 'all');
  const out: MetricsProgram[] = [{ id: 'all', label: all?.label ?? 'All', kind: 'all', tags: [], source: all ? 'setting' : 'builtin', targets: all?.targets ?? DEFAULT_ALL_TARGETS }];
  for (const p of parsed) {
    if (p.kind === 'all') continue;
    out.push({
      id: p.id,
      label: p.label,
      kind: p.kind,
      tags: p.tags,
      source: 'setting',
      targets: p.targets ?? DEFAULT_TARGETS,
      ...(p.kind === 'commits' ? { unavailable: { reason: 'no_source' as CrewUnavailable, text: COMMITS_TEXT } } : {}),
    });
  }
  const covered = () => new Set(out.flatMap((p) => p.tags));
  const ids = () => new Set(out.map((p) => p.id));
  const fromTags: MetricsProgram[] = [];
  for (const tag of input.programTags) {
    if (fromTags.length >= MAX_TAG_PROGRAMS) break;
    const id = tag.slice('program-'.length);
    if (!tag.startsWith('program-') || covered().has(tag) || !PROGRAM_ID.test(id) || ids().has(id) || fromTags.some((p) => p.id === id)) continue;
    fromTags.push({ id, label: id, kind: 'tickets', tags: [tag], source: 'program-tag', targets: DEFAULT_TARGETS });
  }
  out.push(...fromTags.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  for (const f of input.flow) {
    if (covered().has(f.tag) || ids().has(f.name)) continue;
    out.push({ id: f.name, label: f.name, kind: 'tickets', tags: [f.tag], source: 'flow', targets: DEFAULT_TARGETS });
  }
  return out;
}

/** A ticket is in a program when it carries one of its tags (`all`: every ticket; a `commits` program: none). */
export function inProgram(tags: readonly string[], p: Pick<MetricsProgram, 'kind' | 'tags'>): boolean {
  if (p.kind === 'all') return true;
  if (p.kind === 'commits') return false;
  return tags.some((t) => p.tags.includes(t));
}

/* ---------- Scores ---------- */

export const EFFICIENCY_WEIGHTS = { utilisation: 40, leadsActive: 25, notExhausted: 20, noLongIdle: 15 } as const;
/**
 * The ticket's effectiveness weights (40/25/15/10/10) with the flow-time component added at 10: closures give it 5 and review flow 5, so
 * the parts the ticket names keep their order. The pilot-health SKILL.md was not available to this build, so these are the spec.
 */
export const EFFECTIVENESS_WEIGHTS = { closures: 35, reviewFlow: 20, notBlocked: 15, doneVsWontDo: 10, noStall: 10, flowTime: 10 } as const;
/** A live worker idle longer than this is long-idle. */
export const LONG_IDLE_MS = 30 * 60_000;
/** Closures are measured over the last 6 hours. */
export const CLOSURES_WINDOW_MS = 6 * HOUR;

const r1 = (x: number) => Math.round(x * 10) / 10;
const clamp = (x: number) => Math.max(0, Math.min(100, x));

type Part = Omit<MetricsComponent, 'appliedWeight'>;
const meas = (id: string, label: string, weight: number, value: number, source: string, raw: string): Part => ({ id, label, weight, value: r1(clamp(value)), basis: 'measured', source, raw });
const gone = (id: string, label: string, weight: number, reason: CrewUnavailable, source: string, raw: string): Part => ({ id, label, weight, value: null, basis: 'unavailable', source, reason, raw });

/** The weighted mean of the available parts; the weights of the unavailable ones are shared out (appliedWeight says by how much). */
export function combine(parts: readonly Part[], spec: string, previous: number | null): MetricsScore {
  const avail = parts.filter((p) => p.value !== null);
  const w = avail.reduce((s, p) => s + p.weight, 0);
  const components: MetricsComponent[] = parts.map((p) => ({ ...p, appliedWeight: p.value === null || w === 0 ? 0 : r1((p.weight * 100) / w) }));
  const value = w > 0 ? r1(avail.reduce((s, p) => s + p.value! * p.weight, 0) / w) : null;
  const left = parts.filter((p) => p.value === null).map((p) => `${p.id} (${p.reason})`);
  const basis = `${spec} Weights: ${parts.map((p) => `${p.id} ${p.weight}`).join(', ')}.${left.length ? ` Left out, their weight shared by the rest: ${left.join(', ')}.` : ''}`;
  return { value, previous, components, basis };
}

export const EFFICIENCY_SPEC = 'Efficiency 0-100 (T-2360 section B; the pilot-health skill was not available, so the ticket is the spec): how much of the crew is working now.';
export const EFFECTIVENESS_SPEC =
  'Effectiveness 0-100 (T-2360 section B; the pilot-health skill was not available, so the ticket is the spec; flow time added with its weight taken from closures and review flow): how well tickets move.';

/** A crew (a lead's track) as the efficiency score reads it now. */
export interface CrewNow {
  lead: { id: string; state: string; claudeId: string | null } | null;
  workers: readonly { id: string; state: string; stateSinceMs: number | null }[];
  /** The crew holds open work of the program now. */
  openWork: boolean;
}

const LIVE = new Set(['starting', 'idle', 'working', 'waiting', 'interrupted']);
const live = (s: string) => LIVE.has(s);

/** Efficiency now. `exhausted`: the Claudes with a plan window at 100 % or more; null when the portal has no quota reading (no_source). */
export function efficiencyScore(input: { nowMs: number; crews: readonly CrewNow[] | null; exhausted: ReadonlySet<string> | null; previous: number | null }): MetricsScore {
  const W = EFFICIENCY_WEIGHTS;
  const src = {
    utilisation: 'chat_sessions.state of the crews’ live workers: working / live',
    leadsActive: 'chat_sessions.state of the leads whose crew holds open work: working, or a worker of theirs working',
    notExhausted: 'claudeusage: a live lead’s Claude with no plan window at 100 % used',
    noLongIdle: `chat_sessions.state and state_since: live workers not idle for more than ${LONG_IDLE_MS / 60_000} min`,
  };
  if (!input.crews) {
    const u = (id: keyof typeof W, label: string) => gone(id, label, W[id], 'no_source', src[id], 'sessions not readable');
    return combine([u('utilisation', 'Worker utilisation'), u('leadsActive', 'Leads active'), u('notExhausted', 'Leads not exhausted'), u('noLongIdle', 'No long idle')], EFFICIENCY_SPEC, input.previous);
  }
  const workers = input.crews.flatMap((c) => c.workers).filter((w) => live(w.state));
  const working = workers.filter((w) => w.state === 'working').length;
  const utilisation = workers.length
    ? meas('utilisation', 'Worker utilisation', W.utilisation, (100 * working) / workers.length, src.utilisation, `${working} of ${workers.length} live workers working`)
    : gone('utilisation', 'Worker utilisation', W.utilisation, 'no_samples', src.utilisation, 'no live worker');
  const withWork = input.crews.filter((c) => c.openWork);
  const active = withWork.filter((c) => (c.lead && c.lead.state === 'working') || c.workers.some((w) => w.state === 'working')).length;
  // No live crew at all is no sample (a 100 there would score an empty portal as fully active); live crews with no open work are 100.
  const leadsActive = !input.crews.length
    ? gone('leadsActive', 'Leads active', W.leadsActive, 'no_samples', src.leadsActive, 'no live crew')
    : withWork.length
      ? meas('leadsActive', 'Leads active', W.leadsActive, (100 * active) / withWork.length, src.leadsActive, `${active} of ${withWork.length} crews with open work active`)
      : meas('leadsActive', 'Leads active', W.leadsActive, 100, src.leadsActive, 'no crew holds open work');
  const liveLeads = input.crews.flatMap((c) => (c.lead && live(c.lead.state) ? [c.lead] : []));
  const notExhausted = !input.exhausted
    ? gone('notExhausted', 'Leads not exhausted', W.notExhausted, 'no_source', src.notExhausted, 'no quota reading')
    : !liveLeads.length
      ? gone('notExhausted', 'Leads not exhausted', W.notExhausted, 'no_samples', src.notExhausted, 'no live lead')
      : (() => {
          const ok = liveLeads.filter((l) => !l.claudeId || !input.exhausted!.has(l.claudeId)).length;
          return meas('notExhausted', 'Leads not exhausted', W.notExhausted, (100 * ok) / liveLeads.length, src.notExhausted, `${ok} of ${liveLeads.length} live leads on a Claude with quota left`);
        })();
  const longIdle = workers.filter((w) => w.state === 'idle' && w.stateSinceMs !== null && input.nowMs - w.stateSinceMs > LONG_IDLE_MS).length;
  const noLongIdle = workers.length
    ? meas('noLongIdle', 'No long idle', W.noLongIdle, 100 - (100 * longIdle) / workers.length, src.noLongIdle, `${longIdle} of ${workers.length} live workers idle over ${LONG_IDLE_MS / 60_000} min`)
    : gone('noLongIdle', 'No long idle', W.noLongIdle, 'no_samples', src.noLongIdle, 'no live worker');
  return combine([utilisation, leadsActive, notExhausted, noLongIdle], EFFICIENCY_SPEC, input.previous);
}

const labelOf = { closures: 'Closures', reviewFlow: 'Review flow', notBlocked: 'Not blocked', doneVsWontDo: 'Done vs won’t-do', noStall: 'No stall', flowTime: 'Flow time' } as const;

/** Effectiveness now, over the program's tickets. `rows`: the closed tickets (null: not readable); `open`: the open work now (null: same). */
export function effectivenessScore(input: { nowMs: number; rows: readonly FlowRow[] | null; open: MetricsOpenWork | null; targets: MetricsTargets; previous: number | null }): MetricsScore {
  const W = EFFECTIVENESS_WEIGHTS;
  const T = input.targets;
  const src = {
    closures: `tickets closed done in the last 6 h, per hour, against the target ${T.closuresPerHour}/h`,
    reviewFlow: `the oldest ticket in review now (ticket_events), against the target ${T.reviewHours} h`,
    notBlocked: 'tickets blocked now / open work (open, in progress, blocked, in review)',
    doneVsWontDo: 'tickets closed in the last 24 h: done / (done + won’t-do)',
    noStall: 'tickets in progress now with no change (tickets.updated_at) for flow.stallHours',
    flowTime: `median created-to-done of the last 24 h, against the target ${T.resolveHours} h`,
  };
  const now = input.nowMs;
  const parts: Part[] = [];
  if (!input.rows) {
    for (const id of ['closures', 'doneVsWontDo', 'flowTime'] as const) parts.push(gone(id, labelOf[id], W[id], 'no_source', src[id], 'tickets not readable'));
  } else {
    const done6 = input.rows.filter((r) => r.status === 'done' && inWindow(r, now - CLOSURES_WINDOW_MS, now)).length;
    const rate = done6 / (CLOSURES_WINDOW_MS / HOUR);
    parts.push(meas('closures', labelOf.closures, W.closures, (100 * rate) / T.closuresPerHour, src.closures, `${done6} done in 6 h (${r1(rate)}/h)`));
    const day = input.rows.filter((r) => inWindow(r, now - 24 * HOUR, now));
    const d = day.filter((r) => r.status === 'done');
    const k = day.length - d.length;
    parts.push(day.length ? meas('doneVsWontDo', labelOf.doneVsWontDo, W.doneVsWontDo, (100 * d.length) / day.length, src.doneVsWontDo, `${d.length} done, ${k} won’t-do`) : gone('doneVsWontDo', labelOf.doneVsWontDo, W.doneVsWontDo, 'no_samples', src.doneVsWontDo, 'nothing closed in 24 h'));
    const med = stageStat(d, 'resolve').medianMs;
    parts.push(med === null ? gone('flowTime', labelOf.flowTime, W.flowTime, 'no_samples', src.flowTime, 'nothing done in 24 h') : meas('flowTime', labelOf.flowTime, W.flowTime, med <= T.resolveHours * HOUR ? 100 : (100 * T.resolveHours * HOUR) / med, src.flowTime, `median ${fmtDur(med)}`));
  }
  const o = input.open;
  if (!o) {
    for (const id of ['reviewFlow', 'notBlocked', 'noStall'] as const) parts.push(gone(id, labelOf[id], W[id], 'no_source', src[id], 'tickets not readable'));
  } else {
    const age = o.oldestReviewMs;
    parts.push(age === null ? meas('reviewFlow', labelOf.reviewFlow, W.reviewFlow, 100, src.reviewFlow, 'nothing in review') : meas('reviewFlow', labelOf.reviewFlow, W.reviewFlow, age <= T.reviewHours * HOUR ? 100 : (100 * T.reviewHours * HOUR) / age, src.reviewFlow, `oldest in review ${fmtDur(age)}`));
    const work = o.open + o.inProgress + o.blocked + o.inReview;
    parts.push(work ? meas('notBlocked', labelOf.notBlocked, W.notBlocked, 100 - (100 * o.blocked) / work, src.notBlocked, `${o.blocked} of ${work} blocked`) : meas('notBlocked', labelOf.notBlocked, W.notBlocked, 100, src.notBlocked, 'no open work'));
    parts.push(o.inProgress ? meas('noStall', labelOf.noStall, W.noStall, 100 - (100 * o.stalled) / o.inProgress, src.noStall, `${o.stalled} of ${o.inProgress} in progress stalled`) : meas('noStall', labelOf.noStall, W.noStall, 100, src.noStall, 'nothing in progress'));
  }
  const order = Object.keys(W);
  parts.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return combine(parts, EFFECTIVENESS_SPEC, input.previous);
}

/* ---------- Open work ---------- */

export interface OpenTicketFacts {
  id: string;
  status: string;
  tags: readonly string[];
  updatedAtMs: number;
  /** When it entered its current status (the last status change to it), else its creation. */
  statusSinceMs: number;
  assigneeSession: string | null;
  /** The crew (lineage root) of the session that holds it; null or absent: no session holds it. */
  crew?: string | null;
}

export function openWork(tickets: readonly OpenTicketFacts[], nowMs: number, stallMs: number): MetricsOpenWork & { blockedIds: string[]; oldestReview: string | null } {
  const of = (s: string) => tickets.filter((t) => t.status === s);
  const review = of('in_review').sort((a, b) => a.statusSinceMs - b.statusSinceMs || a.id.localeCompare(b.id));
  const inProgress = of('in_progress');
  return {
    open: of('open').length,
    inProgress: inProgress.length,
    blocked: of('blocked').length,
    inReview: review.length,
    oldestReviewMs: review.length ? Math.max(0, nowMs - review[0]!.statusSinceMs) : null,
    stalled: inProgress.filter((t) => nowMs - t.updatedAtMs >= stallMs).length,
    blockedIds: of('blocked').map((t) => t.id).sort(byTicket),
    oldestReview: review[0]?.id ?? null,
  };
}

const byTicket = (a: string, b: string) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')) || a.localeCompare(b);

/* ---------- Snapshots ---------- */

/** The values one snapshot keeps for a program (the trend's metrics). */
export function snapshotValues(input: { efficiency: MetricsScore; effectiveness: MetricsScore; day: MetricsFlowWindow; open: MetricsOpenWork | null }): Record<MetricsTrendKey, number | null> {
  const out: Record<string, number | null> = {
    efficiency: input.efficiency.value,
    effectiveness: input.effectiveness.value,
    done24h: input.day.done,
    wontDo24h: input.day.wontDo,
    openWork: input.open ? input.open.open + input.open.inProgress + input.open.blocked + input.open.inReview : null,
    blocked: input.open?.blocked ?? null,
    inReview: input.open?.inReview ?? null,
  };
  for (const s of input.day.stages) out[`${s.stage}P50`] = s.medianMs;
  return out as Record<MetricsTrendKey, number | null>;
}

/** At most `max` points: one per equal slice of the window, the last snapshot in each (the series keeps its shape, not every sample). */
export function downsample<T extends { atMs: number }>(points: readonly T[], fromMs: number, toMs: number, max: number): T[] {
  if (points.length <= max) return [...points];
  const width = (toMs - fromMs) / max;
  const by = new Map<number, T>();
  for (const p of points) by.set(Math.min(max - 1, Math.floor((p.atMs - fromMs) / width)), p);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

/* ---------- Findings ---------- */

/** A duration in words: minutes under 2 hours, hours under 2 days, else days. */
export function fmtDur(ms: number): string {
  if (ms < 2 * HOUR) return `${Math.round(ms / 60_000)} min`;
  if (ms < 48 * HOUR) return `${r1(ms / HOUR)} h`;
  return `${r1(ms / (24 * HOUR))} d`;
}

/** The stages that are parts of the journey (resolve and work are the whole of it). */
const PART_STAGES: readonly MetricsStage[] = ['start', 'report', 'implement', 'test', 'deliver'];
/** A regression is at least this much slower, over at least this many tickets on both sides. */
export const REGRESSION_FRAC = 0.25;
export const MIN_N = 3;
/** An outlier took at least this many times the median to resolve (with at least 5 done). */
export const OUTLIER_FACTOR = 3;

/**
 * Plain-language findings for one program and window: the slowest stage, the biggest regression against the window before, idle capacity,
 * the blocked share, the review wait and the outliers (with ticket ids). Pure; the order is act, warn, info.
 */
export function insights(input: {
  label: string;
  windowLabel: string;
  flow: MetricsFlowGroup;
  rows: readonly FlowRow[];
  efficiency: MetricsScore;
  open: (MetricsOpenWork & { blockedIds: string[]; oldestReview: string | null }) | null;
  targets: MetricsTargets;
}): MetricsInsight[] {
  const out: MetricsInsight[] = [];
  const cur = input.flow.current;
  const prev = input.flow.previous;
  if (!cur.done) out.push({ kind: 'no_data', severity: 'info', text: `${input.label}: no ticket closed done in the last ${input.windowLabel}, so there are no stage times.`, tickets: [] });
  const parts = cur.stages.filter((s) => PART_STAGES.includes(s.stage) && s.medianMs !== null);
  const slow = [...parts].sort((a, b) => b.medianMs! - a.medianMs!)[0];
  if (slow)
    out.push({
      kind: 'slowest_stage',
      severity: 'info',
      text: `Slowest stage: ${slow.stage}, median ${fmtDur(slow.medianMs!)} (p90 ${fmtDur(slow.p90Ms!)}) over ${slow.n} tickets${slow.excluded ? `; ${slow.excluded} left out with no ${slow.stage} recorded` : ''}.`,
      tickets: [],
    });
  let worst: { stage: MetricsStage; frac: number; from: number; to: number } | null = null;
  for (const s of cur.stages) {
    const p = prev.stages.find((x) => x.stage === s.stage);
    if (!p || s.medianMs === null || p.medianMs === null || s.n < MIN_N || p.n < MIN_N || p.medianMs <= 0) continue;
    const frac = (s.medianMs - p.medianMs) / p.medianMs;
    if (frac >= REGRESSION_FRAC && (!worst || frac > worst.frac)) worst = { stage: s.stage, frac, from: p.medianMs, to: s.medianMs };
  }
  if (worst)
    out.push({ kind: 'regression', severity: worst.frac >= 1 ? 'act' : 'warn', text: `Biggest regression: ${worst.stage} median went from ${fmtDur(worst.from)} to ${fmtDur(worst.to)} (+${Math.round(worst.frac * 100)} %) against the ${input.windowLabel} before.`, tickets: [] });
  const util = input.efficiency.components.find((c) => c.id === 'utilisation');
  if (util && util.value !== null && util.value < 50) out.push({ kind: 'idle_capacity', severity: util.value < 25 ? 'act' : 'warn', text: `Idle capacity: ${util.raw}.`, tickets: [] });
  const idle = input.efficiency.components.find((c) => c.id === 'noLongIdle');
  if (idle && idle.value !== null && idle.value < 100) out.push({ kind: 'idle_capacity', severity: 'warn', text: `Long idle: ${idle.raw}; end them or give them work.`, tickets: [] });
  const o = input.open;
  if (o) {
    const work = o.open + o.inProgress + o.blocked + o.inReview;
    if (work && o.blocked / work >= 0.2)
      out.push({ kind: 'blocked_share', severity: o.blocked / work >= 0.4 ? 'act' : 'warn', text: `${Math.round((100 * o.blocked) / work)} % of open work is blocked (${o.blocked} of ${work}).`, tickets: o.blockedIds.slice(0, 10) });
    if (o.oldestReviewMs !== null && o.oldestReviewMs > input.targets.reviewHours * HOUR)
      out.push({ kind: 'review_wait', severity: o.oldestReviewMs > 4 * input.targets.reviewHours * HOUR ? 'act' : 'warn', text: `${o.oldestReview} has waited ${fmtDur(o.oldestReviewMs)} in review (target ${input.targets.reviewHours} h).`, tickets: o.oldestReview ? [o.oldestReview] : [] });
  }
  const done = input.rows.filter((r) => r.status === 'done' && inWindow(r, cur.fromMs, cur.toMs) && r.stages.resolve !== null);
  const med = cur.stages.find((s) => s.stage === 'resolve')?.medianMs ?? null;
  if (med !== null && med > 0 && done.length >= 5) {
    const slowOnes = done.filter((r) => r.stages.resolve! >= OUTLIER_FACTOR * med).sort((a, b) => b.stages.resolve! - a.stages.resolve!);
    if (slowOnes.length)
      out.push({ kind: 'outlier', severity: 'info', text: `${slowOnes.length} ticket${slowOnes.length > 1 ? 's' : ''} took over ${OUTLIER_FACTOR}x the median ${fmtDur(med)} to resolve; the slowest ${slowOnes[0]!.id} took ${fmtDur(slowOnes[0]!.stages.resolve!)}.`, tickets: slowOnes.slice(0, 10).map((r) => r.id) });
  }
  const rank = { act: 0, warn: 1, info: 2 } as const;
  return out.map((x, i) => ({ x, i })).sort((a, b) => rank[a.x.severity] - rank[b.x.severity] || a.i - b.i).map(({ x }) => x);
}
