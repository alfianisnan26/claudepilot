// Pilot metrics (T-2360, docs/prd/claude-usage.md §28.15): puts the pure parts together for the routes, the snapshot timer and (later) the
// Portal MCP tools. Reads go through the loaders (bounded to the window and the one before it); the T-450 / T-600 numbers come from the
// scorecard's own functions (`loadCrewFacts`, `programScore`, `buildHeadline`, usage spend's `ticketReport` behind them), never a copy.

import {
  METRICS_WINDOW_MS,
  type CrewFigure,
  type MetricsFlow,
  type MetricsGroupBy,
  type MetricsInsights,
  type MetricsOverview,
  type MetricsProgram,
  type MetricsStage,
  type MetricsTickets,
  type MetricsTrend,
  type MetricsTrendKey,
  type MetricsTrendWindow,
  type MetricsUnavailable,
  type MetricsWindow,
  platformRef,
} from '@portal/contracts';
import { canUser } from '../authz/seam.js';
import type { Store } from '../store/store.js';
import { SpendStore } from '../usagespend/store.js';
import { flowProgramsRaw, flowThresholds, type FlowSettingsReader } from '../flow/settings.js';
import { parsePrograms } from '../flow/programs.js';
import { buildHeadline, type PaceClaude } from './headline.js';
import { programIdOf, programScore, programsOf, programTickets, type CrewFacts, type Program } from './scorecard.js';
import { loadCrewFacts } from './scorecardData.js';
import {
  DEFAULT_METRICS_PROGRAMS,
  efficiencyScore,
  effectivenessScore,
  groupFlow,
  groupKeysOf,
  inProgram,
  insights,
  openWork,
  resolvePrograms,
  snapshotValues,
  downsample,
  ticketFlow,
  ticketRows,
  type CrewNow,
  type FlowRow,
  type OpenTicketFacts,
} from './flowMetrics.js';
import { loadFlowTickets, loadOpenTickets, loadProgramTags } from './flowMetricsData.js';
import { KEEP_SNAPSHOTS_MS, readTrend, snapshotNear, SNAPSHOT_EVERY_MS, writeSnapshots } from './metricsSnapshots.js';
import { METRICS_SETTING } from './metricsSettings.js';

const HOUR = 3_600_000;
const OPEN = new Set(['open', 'in_progress', 'blocked', 'in_review']);
const LIVE = new Set(['starting', 'idle', 'working', 'waiting', 'interrupted']);
/** The trend has at most about this many points. */
export const TREND_POINTS = 200;
/** The drill-down returns at most this many rows. */
export const TICKET_ROWS = 200;

export const METRICS_BASIS: Record<string, string> = {
  stages:
    'ticket_events (status moves into in_progress, the first comment by an agent session, QA and review verdicts, self-test lines) and ticket_merge_status (merged) of the tickets closed in the window; a ticket that lacks a stage’s timestamps is left out of it (excluded), never 0',
  percentile: 'nearest rank (scorecard.ts percentile), median and 90th percentile',
  wontDo: 'closed won’t-do: counted apart, never in a stage',
  programs:
    'tickets carrying one of the program’s tags (setting lab.metricsPrograms; program-* tags and flow.programs added); all: every ticket',
  lead: 'the ticket’s first area-* tag, else the lineage root of the session that held it (assignee, or who moved it into in_progress)',
  crew: 'the crews (lead tracks) holding the program’s tickets: the crew scorecard’s headline (T-600) and cost (T-450) over them',
  previous: 'the score in the snapshot nearest to one window ago (snapshots every 10 min, kept 30 days)',
};

export interface MetricsDeps {
  store: Store;
  now: () => number;
  settings: FlowSettingsReader | null;
  /** claudeusage's snapshot of the Claudes' plan windows; null or failing: quota is unavailable. */
  paces: (() => Promise<readonly PaceClaude[] | null>) | null;
  log?: (msg: string) => void;
  /**
   * How long a read (the closed and open tickets of a window, the crew facts, the programs) is reused, ms. 0 or absent: read on every call
   * (the unit tests). The portal sets METRICS_MEMO_MS, so leads polling the tools and the 10-minute snapshot share one read per window.
   */
  memoMs?: number;
}

/** The portal's reuse of a read (see MetricsDeps.memoMs). */
export const METRICS_MEMO_MS = 60_000;

/**
 * Who reads: the whole portal (null: a reader of the area `usage`), or an agent's own crew (the lineage root of its lead session, the crew
 * scorecard's own program). A crew read keeps only the tickets the crew's sessions held, gets no paces (every Claude's quota) and no score
 * a window ago (the snapshots hold whole-program numbers).
 */
export type MetricsScope = { crew: string } | null;

/** The facts read once for one answer. */
interface Loaded {
  nowMs: number;
  rows: FlowRow[] | null;
  open: OpenTicketFacts[] | null;
}

/** The closed tickets could not be read: the flow is unavailable, never an empty 0. */
export const FLOW_UNAVAILABLE: MetricsUnavailable = {
  reason: 'no_source',
  text: 'The closed tickets could not be read, so the flow figures are unavailable (not 0). The server log names the error.',
};
/** The trend keys that come from the closed tickets of the day: null in a snapshot whose read failed. */
const FLOW_KEYS = ['done24h', 'wontDo24h'] as const;
/** Program tags count only with a ticket touched in this span (the longest trend window), ranked by how many. */
export const PROGRAM_TAG_RECENT_MS = 30 * 24 * HOUR;
/** At most this many programs per snapshot (each is one row every SNAPSHOT_EVERY_MS). */
export const MAX_SNAPSHOT_PROGRAMS = 32;

export class Metrics {
  constructor(private readonly deps: MetricsDeps) {}

  #memo = new Map<string, { atMs: number; value: unknown }>();

  /** `fn()` reused for `memoMs` (by the deps' clock); a failed read (null) is not kept. A handful of keys: the windows and spans. */
  #memoized<T>(key: string, fn: () => T, keep: (v: T) => boolean = (v) => v !== null): T {
    const ttl = this.deps.memoMs ?? 0;
    if (ttl <= 0) return fn();
    const nowMs = this.deps.now();
    const hit = this.#memo.get(key);
    if (hit && nowMs >= hit.atMs && nowMs - hit.atMs < ttl) return hit.value as T;
    const value = fn();
    if (keep(value)) this.#memo.set(key, { atMs: nowMs, value });
    else this.#memo.delete(key);
    return value;
  }

  /** A read that fails is null (unavailable to the caller), and its error name, never its message or data, goes to the log. */
  #read<T>(what: string, fn: () => T): T | null {
    try {
      return fn();
    } catch (e) {
      this.deps.log?.(`metrics: ${what} read failed (${e instanceof Error ? e.name : 'error'})`);
      return null;
    }
  }

  #setting(key: string): unknown {
    try {
      return this.deps.settings?.get(key);
    } catch {
      return undefined;
    }
  }

  /** Every program, `all` first. */
  programs(): MetricsProgram[] {
    return this.#memoized('programs', () => this.#programs());
  }

  #programs(): MetricsProgram[] {
    const db = this.deps.store.db;
    const flow = parsePrograms(flowProgramsRaw(this.deps.settings)).map((p) => ({ name: p.name, tag: p.tag }));
    // No settings module, or a value that is not text: the setting's default (as flowProgramsRaw does for flow.programs).
    const raw = this.#setting(METRICS_SETTING.programs);
    return resolvePrograms({
      setting: typeof raw === 'string' ? raw : DEFAULT_METRICS_PROGRAMS,
      programTags: (db && this.#read('program tags', () => loadProgramTags(db, this.deps.now() - PROGRAM_TAG_RECENT_MS))) || [],
      flow,
    });
  }

  /**
   * The reach of an agent's token on the metrics tools (portal MCP, metricsTools.ts): its own crew, only when its session is a lead (a
   * top-level chat: no parent session; a worker started with `session_spawn` has one) AND the person who owns the session may view the area
   * `usage` (what the REST routes ask). Unknown, unreadable, a worker, an owner without that right, or no crew: null (refused).
   */
  leadScope(sessionId: string): MetricsScope {
    const db = this.deps.store.db;
    const row = db
      ? this.#read(
          'lead session',
          () =>
            db.prepare('SELECT parent_id, owner_id FROM chat_sessions WHERE id = ?').get(sessionId) as
              { parent_id: string | null; owner_id: string | null } | undefined,
        )
      : null;
    if (!row || row.parent_id || !row.owner_id) return null;
    if (!canUser(row.owner_id, 'view', platformRef('usage'))) return null;
    const sessions = this.#read('lead lineage', () => new SpendStore(this.deps.store).sessions([sessionId]));
    const crew = sessions?.has(sessionId) ? programIdOf(sessionId, sessions) : null;
    return crew ? { crew } : null;
  }

  /** One program of `programs` (read once per request by the caller), or null. */
  program(id: string | undefined, programs: readonly MetricsProgram[] = this.programs()): MetricsProgram | null {
    return programs.find((p) => p.id === (id ?? 'all')) ?? null;
  }

  /** The window's reads, reused for memoMs; one with a failed part is read again next time. */
  #load(windowMs: number): Loaded {
    return this.#memoized(
      `load:${windowMs}`,
      () => this.#loadNow(windowMs),
      (l) => l.rows !== null && l.open !== null,
    );
  }

  /** The crew facts from `backMs` before now (the scorecard's loader), reused like the ticket reads. */
  #crewFacts(nowMs: number, backMs: number): CrewFacts | null {
    return this.#memoized(`crew:${backMs}`, () => this.#read('crew facts', () => loadCrewFacts(this.deps.store, nowMs, nowMs - backMs)));
  }

  #loadNow(windowMs: number): Loaded {
    const nowMs = this.deps.now();
    const db = this.deps.store.db;
    if (!db) return { nowMs, rows: null, open: null };
    const spend = new SpendStore(this.deps.store);
    // At least two days back: effectiveness reads the last 24 h whatever the window.
    const from = nowMs - Math.max(2 * windowMs, 48 * HOUR);
    const facts = this.#read('closed tickets', () => loadFlowTickets(db, from, nowMs + 1, (ids) => spend.sessions(ids)));
    return {
      nowMs,
      rows: facts ? facts.map(ticketFlow) : null,
      open: this.#read('open tickets', () => loadOpenTickets(db, (ids) => spend.sessions(ids))),
    };
  }

  #rowsOf(l: Loaded, p: MetricsProgram, scope: MetricsScope): FlowRow[] | null {
    if (p.kind === 'commits') return [];
    return l.rows ? l.rows.filter((r) => inProgram(r.tags, p) && (!scope || r.crew === scope.crew)) : null;
  }

  #openOf(l: Loaded, p: MetricsProgram, scope: MetricsScope) {
    if (!l.open) return null;
    return openWork(
      l.open.filter((t) => inProgram(t.tags, p) && (!scope || t.crew === scope.crew)),
      l.nowMs,
      flowThresholds(this.deps.settings).stallMs,
    );
  }

  async #paces(scope: MetricsScope): Promise<readonly PaceClaude[] | null> {
    if (!this.deps.paces || scope) return null;
    try {
      return await this.deps.paces();
    } catch (e) {
      this.deps.log?.(`metrics: pace source failed (${e instanceof Error ? e.name : 'error'})`);
      return null;
    }
  }

  /** The crews holding the program's tickets (for `all`, every crew), with a session live now. */
  #crews(facts: CrewFacts, p: MetricsProgram, scope: MetricsScope): Program[] {
    const crews = [...programsOf(facts.sessions, facts.extra).values()].filter((c) => !scope || c.id === scope.crew);
    if (p.kind === 'commits') return [];
    const tickets = (facts.tickets ?? []).filter((t) => inProgram(t.tags, p));
    return crews.filter((c) => p.kind === 'all' || programTickets(c, tickets, facts.sessions).length > 0);
  }

  #crewNow(facts: CrewFacts, crews: readonly Program[], p: MetricsProgram): CrewNow[] {
    const open = (facts.tickets ?? []).filter((t) => OPEN.has(t.status) && inProgram(t.tags, p));
    return crews
      .map((c) => {
        const leadId = c.leads.at(-1) ?? c.id;
        const lead = facts.sessions.get(leadId);
        const leads = new Set(c.leads);
        const workers = [...c.members]
          .filter((m) => !leads.has(m))
          .map((m) => ({ id: m, state: facts.sessions.get(m)?.state ?? 'ended', stateSinceMs: facts.extra.get(m)?.stateSinceMs ?? null }));
        return {
          lead: lead ? { id: leadId, state: lead.state ?? 'ended', claudeId: lead.claudeId || null } : null,
          workers,
          openWork: programTickets(c, open, facts.sessions).length > 0,
        };
      })
      .filter((c) => (c.lead && LIVE.has(c.lead.state)) || c.workers.some((w) => LIVE.has(w.state)));
  }

  #previous(
    program: string,
    nowMs: number,
    windowMs: number,
    scope: MetricsScope,
  ): { efficiency: number | null; effectiveness: number | null } {
    const db = scope ? null : this.deps.store.db;
    const s = db
      ? this.#read('snapshot', () => snapshotNear(db, program, nowMs - windowMs, Math.max(SNAPSHOT_EVERY_MS * 3, windowMs / 24)))
      : null;
    const n = (v: unknown) => (typeof v === 'number' ? v : null);
    return { efficiency: n(s?.values.efficiency), effectiveness: n(s?.values.effectiveness) };
  }

  /** Both scores of one program now, with the facts behind them. */
  #scores(
    l: Loaded,
    p: MetricsProgram,
    facts: CrewFacts | null,
    paces: readonly PaceClaude[] | null,
    windowMs: number,
    scope: MetricsScope,
  ) {
    const prev = this.#previous(p.id, l.nowMs, windowMs, scope);
    const crews = facts ? this.#crews(facts, p, scope) : null;
    const exhausted = paces
      ? new Set(paces.filter((c) => c.windows.some((w) => typeof w.usedPct === 'number' && w.usedPct >= 100)).map((c) => c.claudeId))
      : null;
    const efficiency = efficiencyScore({
      nowMs: l.nowMs,
      crews: facts && crews ? this.#crewNow(facts, crews, p) : null,
      exhausted,
      previous: prev.efficiency,
    });
    const rows = this.#rowsOf(l, p, scope);
    const open = p.kind === 'commits' ? null : this.#openOf(l, p, scope);
    const effectiveness = effectivenessScore({
      nowMs: l.nowMs,
      rows: p.kind === 'commits' ? null : rows,
      open,
      targets: p.targets,
      previous: prev.effectiveness,
    });
    return { efficiency, effectiveness, rows, open, crews };
  }

  /** The overview of one program; null when the program is not there. */
  async overview(programId: string | undefined, window: MetricsWindow, scope: MetricsScope = null): Promise<MetricsOverview | null> {
    const p = this.program(programId);
    if (!p) return null;
    const windowMs = METRICS_WINDOW_MS[window];
    const l = this.#load(windowMs);
    const facts = this.#crewFacts(l.nowMs, 2 * windowMs);
    const paces = await this.#paces(scope);
    const s = this.#scores(l, p, facts, paces, windowMs, scope);
    // A failed read is null with the reason, never a window of zeros.
    const flow = s.rows === null ? null : groupFlow(s.rows, l.nowMs, windowMs, null, []).total;
    const flowUnavailable = flow === null ? { flowUnavailable: FLOW_UNAVAILABLE } : {};
    let crew: MetricsOverview['crew'] = null;
    if (facts && s.crews) {
      const headline = buildHeadline({ programs: s.crews, facts, windowMs, compare: true, paces });
      const costs = s.crews.map((c) => programScore(c, facts, windowMs, false).current.cost);
      const sum = (k: 'total' | 'lead' | 'workers') => {
        const vals = costs.map((c) => c[k]).filter((f) => f.value !== null);
        return vals.length ? vals.reduce((a, f) => a + f.value!, 0) : null;
      };
      const src = 'chat_usage.cost_usd of the crews in the window (crew scorecard cost, T-450), summed';
      const fig = (v: number | null, source = src, reason: 'no_samples' | 'no_source' = 'no_samples'): CrewFigure =>
        v === null
          ? { value: null, basis: 'unavailable', source, reason }
          : { value: Math.round(v * 100) / 100, basis: 'estimate', source };
      const total = sum('total');
      const lead = sum('lead');
      const done = flow?.current.done ?? null;
      crew = {
        programs: s.crews.map((c) => c.id),
        headline,
        cost: {
          total: fig(total),
          lead: fig(lead),
          workers: fig(sum('workers')),
          leadShare: fig(total && lead !== null ? (100 * lead) / total : null, 'the crews’ lead dollars / all their dollars, percent'),
          // The done count unreadable: no_source (not "no samples").
          perDone: fig(
            total !== null && done !== null && done > 0 ? total / done : null,
            'the crews’ dollars / the program’s tickets done in the window',
            done === null ? 'no_source' : 'no_samples',
          ),
        },
      };
    }
    return {
      program: p,
      window,
      nowMs: l.nowMs,
      efficiency: s.efficiency,
      effectiveness: s.effectiveness,
      flow,
      ...flowUnavailable,
      open: s.open
        ? {
            open: s.open.open,
            inProgress: s.open.inProgress,
            blocked: s.open.blocked,
            inReview: s.open.inReview,
            oldestReviewMs: s.open.oldestReviewMs,
            stalled: s.open.stalled,
          }
        : null,
      crew,
      basis: METRICS_BASIS,
    };
  }

  flow(
    programId: string | undefined,
    window: MetricsWindow,
    groupBy: MetricsGroupBy | null,
    scope: MetricsScope = null,
  ): MetricsFlow | null {
    const programs = this.programs();
    const p = this.program(programId, programs);
    if (!p) return null;
    const windowMs = METRICS_WINDOW_MS[window];
    const l = this.#load(windowMs);
    const rows = this.#rowsOf(l, p, scope);
    if (rows === null)
      return {
        program: p.id,
        window,
        nowMs: l.nowMs,
        groupBy,
        total: null,
        groups: [],
        basis: METRICS_BASIS,
        unavailable: FLOW_UNAVAILABLE,
      };
    const { total, groups } = groupFlow(rows, l.nowMs, windowMs, groupBy, programs);
    return { program: p.id, window, nowMs: l.nowMs, groupBy, total, groups, basis: METRICS_BASIS };
  }

  /** `offset` (the Portal MCP's paging, metricsTools.ts): the rows from there on, still at most TICKET_ROWS; `total` is over all of them. */
  tickets(
    programId: string | undefined,
    window: MetricsWindow,
    opts: { stage?: MetricsStage; groupBy?: MetricsGroupBy; group?: string; offset?: number },
    scope: MetricsScope = null,
  ): MetricsTickets | null {
    const programs = this.programs();
    const p = this.program(programId, programs);
    if (!p) return null;
    const windowMs = METRICS_WINDOW_MS[window];
    const l = this.#load(windowMs);
    const read = this.#rowsOf(l, p, scope);
    let rows = (read ?? []).filter((r) => !opts.stage || r.stages[opts.stage] !== null);
    if (opts.groupBy && opts.group) rows = rows.filter((r) => groupKeysOf(r, opts.groupBy!, programs).includes(opts.group!));
    const all = ticketRows(rows, l.nowMs - windowMs, l.nowMs, programs);
    const from = Math.max(0, opts.offset ?? 0);
    return {
      program: p.id,
      window,
      nowMs: l.nowMs,
      stage: opts.stage ?? null,
      group: opts.group ?? null,
      groupBy: opts.groupBy ?? null,
      total: read === null ? null : all.length,
      rows: all.slice(from, from + TICKET_ROWS),
      ...(read === null ? { unavailable: FLOW_UNAVAILABLE } : {}),
    };
  }

  trend(programId: string | undefined, metric: MetricsTrendKey, window: MetricsTrendWindow): MetricsTrend | null {
    const p = this.program(programId);
    if (!p) return null;
    const nowMs = this.deps.now();
    const from = nowMs - METRICS_WINDOW_MS[window];
    const db = this.deps.store.db;
    const points = db ? (this.#read('trend', () => readTrend(db, p.id, metric, from, nowMs)) ?? []) : [];
    return {
      program: p.id,
      metric,
      window,
      nowMs,
      points: downsample(points, from, nowMs, TREND_POINTS),
      everyMs: SNAPSHOT_EVERY_MS,
      keepMs: KEEP_SNAPSHOTS_MS,
      source: 'lab_metric_snapshots (written every 10 min, kept 30 days); the last snapshot of each of at most 200 equal slices',
    };
  }

  /** Plain-language findings for one program and window. */
  async insights(programId: string | undefined, window: MetricsWindow, scope: MetricsScope = null): Promise<MetricsInsights | null> {
    const p = this.program(programId);
    if (!p) return null;
    const windowMs = METRICS_WINDOW_MS[window];
    const l = this.#load(windowMs);
    if (p.kind === 'commits')
      return {
        program: p.id,
        window,
        nowMs: l.nowMs,
        items: [{ kind: 'no_data', severity: 'info', text: p.unavailable!.text, tickets: [] }],
      };
    const facts = this.#crewFacts(l.nowMs, HOUR);
    const s = this.#scores(l, p, facts, await this.#paces(scope), windowMs, scope);
    if (s.rows === null)
      return {
        program: p.id,
        window,
        nowMs: l.nowMs,
        items: [{ kind: 'no_data', severity: 'info', text: FLOW_UNAVAILABLE.text, tickets: [] }],
      };
    const rows = s.rows;
    const flow = groupFlow(rows, l.nowMs, windowMs, null, []).total;
    return {
      program: p.id,
      window,
      nowMs: l.nowMs,
      items: insights({
        label: p.label,
        windowLabel: window === '24h' ? '24 hours' : '7 days',
        flow,
        rows,
        efficiency: s.efficiency,
        open: s.open,
        targets: p.targets,
      }),
    };
  }

  /** One snapshot per ticket program (the timer, every 10 minutes). Returns how many rows were written. */
  async snapshot(): Promise<number> {
    const db = this.deps.store.writable ? this.deps.store.db : null;
    if (!db) return 0;
    const windowMs = METRICS_WINDOW_MS['24h'];
    const l = this.#load(windowMs);
    const facts = this.#crewFacts(l.nowMs, HOUR);
    const paces = await this.#paces(null);
    const all = this.programs().filter((p) => p.kind !== 'commits');
    // A hard cap per snapshot (all first, then the setting's, the tag and the flow programs in that order): the table grows by at most
    // MAX_SNAPSHOT_PROGRAMS rows every 10 minutes, whatever the setting or the tags hold.
    if (all.length > MAX_SNAPSHOT_PROGRAMS)
      this.deps.log?.(`metrics: snapshot keeps the first ${MAX_SNAPSHOT_PROGRAMS} of ${all.length} programs`);
    const rows = all.slice(0, MAX_SNAPSHOT_PROGRAMS).map((p) => {
      const s = this.#scores(l, p, facts, paces, windowMs, null);
      const day = groupFlow(s.rows ?? [], l.nowMs, windowMs, null, []).total.current;
      const values = snapshotValues({ efficiency: s.efficiency, effectiveness: s.effectiveness, day, open: s.open });
      // A failed read is a gap in the trend, never a dip to 0.
      if (s.rows === null)
        for (const k of Object.keys(values) as (keyof typeof values)[])
          if (FLOW_KEYS.includes(k as never) || k.endsWith('P50')) values[k] = null;
      return { program: p.id, values };
    });
    return writeSnapshots(db, l.nowMs, rows);
  }
}
