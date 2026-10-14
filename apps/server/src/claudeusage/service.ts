// Claude usage: the plan limits of each Claude (docs/prd/claude-usage.md). A scheduler asks Claude Code, in each
// running workspace and as each Claude, for its usage (probe.ts); live chat sessions add what their streams carry
// (`onRateLimit`); one store keeps the readings; and `report`, `headroom` and the alerts read it.
//
// Start-up and every background pass are skipped unless the portal trusts its database (`deliveryAllowed`) and wrapped in
// try/catch, so a frozen or newer database never takes the portal down (QA-011, foundation §6.5).

import { AppError } from '@isnanme/core';
import {
  ALL_MODEL_WINDOWS,
  CHAT_USAGE_RANGES,
  USAGE_RANGES,
  USAGE_THRESHOLDS,
  usageUnavailable,
  type ClaudeLimitReport,
  type ClaudeRunsOn,
  type ClaudeUsage,
  type ClaudeUsageAlert,
  type ClaudeUsageHistory,
  type ClaudeUsageReport,
  type Headroom,
  type LimitOutlook,
  type MoveRecommendation,
  type PaletteSlot,
  type RequestsReport,
  type SnoozeKind,
  type SnoozeUntil,
  type UsageExportQuery,
  type UsagePalette,
  type UsageRange,
  type UsageSummary,
} from '@portal/contracts';
import { isUsageRange } from '../chat/usage.js';
import type { Store } from '../store/store.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { ALERT_RANK, alertLevelOf, headroomOf, stateOf, viewWindows, withLimitReport } from './derive.js';
import { LIMIT_MESSAGE_SOURCE } from './limitMessage.js';
import { OWNER_ACTOR } from './actor.js';
import { exportFileName, quotaCsv, requestsCsv } from './exporter.js';
import { outlookOf, unavailableOutlook, windowLengthMs, windowPace } from './pace.js';
import { Palette } from './palette.js';
import { recommendMove } from './recommend.js';
import { buildRequestsReport } from './requests.js';
import { SpendReader } from './spend.js';
import { buildSummary, summaryRowsFrom } from './summary.js';
import { parseRateLimitInfo, sortWindows, windowLevel, type WindowReading } from './parse.js';
import { probeClaude, type ProbeIo, type ProbeResult } from './probe.js';
import { UsageStore, type AlertMark, type LatestRow, type ProjectionMark } from './store.js';

/** A Claude of a workspace, as this module needs to know it. */
export interface SourceClaude {
  /** The Claude's own id (`workspace_claudes.id`). */
  id: string;
  name: string;
  /** `claudes/<16 hex>`, or '' for Default. */
  directory: string;
  /** `<target>/<name>`. */
  workspaceId: string;
  workspaceName: string;
  target: string;
  running: boolean;
}

/** Everything outside this module the service reads (index.ts wires it to the workspaces and the chat controller). */
export interface UsageSource {
  /** Every Claude that exists (not removed), with its workspace and whether that runs. */
  claudes(): Promise<SourceClaude[]>;
  /** The workspace has an account pool: its Claudes run on API keys and have no plan limits. */
  pooled(workspaceId: string): boolean;
  exec(target: string, name: string, command: string[]): Promise<ExecSession>;
  /** The workspace and Claude a live chat session runs in; `claudeId` is what the reader knows ('' for Default). */
  sessionClaude(sessionId: string, claudeId: string): { workspaceId: string; claudeId: string; name: string; workspaceName: string } | null;
}

export interface UsageSettings {
  /** Off: nothing is probed (passive readings and the snapshot still work). */
  probes: boolean;
  /** The wait between probes of one Claude. */
  intervalMs: number;
  /** The same while a page is open on the Usage tab. */
  fastMs: number;
  /** Probe only workspaces whose name starts with one of these; empty means all. */
  only: string[];
}

export interface UsageOptions {
  store: Store;
  source: UsageSource;
  settings?: Partial<UsageSettings>;
  now?: () => number;
  /** Something changed: tell open pages (the `claudeusage` live topic). */
  notify?: () => void;
  log?: (line: string) => void;
  /** Test seam: replaces the probe. */
  probe?: (claude: SourceClaude, io: ProbeIo) => Promise<ProbeResult>;
  /**
   * Multi-user seam (PLAN-10; docs §20.14): whether `actorId` may use, and so see the usage of, `claudeId`. Absent: everyone may (one owner). The
   * snapshot, the summary, the Requests report, the export and the Move recommendation leave out the Claudes it refuses; an error in it refuses.
   */
  canUseClaude?: (actorId: string, claudeId: string) => boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const TICK_MS = 15_000;
const FIRST_TICK_MS = 20_000;
const PRUNE_EVERY_MS = 6 * HOUR;
/** A Claude found signed out, or on a key, is looked at again this rarely (nothing changes until someone signs in). */
const SETTLED_MS = HOUR;
const MAX_BACKOFF_MS = HOUR;
/** Check now, per Claude. */
export const COOLDOWN_MS = 30_000;
/** A page that asks for the snapshot with `watch` makes probing faster for this long. */
export const WATCH_MS = 2 * MINUTE;
const MAX_PARALLEL = 2;
const STALE_AFTER = 3;
const CLAUDES_CACHE_MS = 5_000;
/** Alerts older than this are no longer listed. */
const ALERT_WINDOW_MS = 24 * HOUR;
/** Reset times this close are one period (a source rounds to the second, another to the microsecond). */
const SAME_PERIOD_MS = 60_000;
const RANGE_MS: Record<UsageRange, number> = { '1d': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR };
const MAX_POINTS = 200;
const TREND_POINTS = 28;
/** How far back a window's readings are fetched when its period's length is not known. */
const PACE_LOOKBACK_MS = 8 * 24 * HOUR;

export function usageSettings(over: Partial<{ probes: boolean; intervalS: number; fastS: number; only: string[] }> = {}): UsageSettings {
  const secs = (v: unknown, dflt: number, min: number) => Math.max(min, typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt) * 1000;
  return { probes: over.probes !== false, intervalMs: secs(over.intervalS, 600, 60), fastMs: secs(over.fastS, 120, 30), only: over.only ?? [] };
}

export class ClaudeUsageMonitor {
  readonly #store: UsageStore;
  readonly #spend: SpendReader;
  readonly #palette: Palette;
  readonly #settings: UsageSettings;
  readonly #now: () => number;
  readonly #sinks = new Set<(alert: ClaudeUsageAlert) => void>();
  /** Told after every new reading (a probe that read, a live reading): auto move re-evaluates on it (T-105). */
  readonly #readings = new Set<() => void>();
  /** Workspaces with a probe running: one at a time each. */
  readonly #busy = new Set<string>();
  readonly #manual = new Map<string, number>();
  #running = 0;
  #watchedUntil = 0;
  #claudes: { at: number; list: SourceClaude[] } | null = null;
  #timers: NodeJS.Timeout[] = [];
  #ticking = false;
  readonly #warned = new Set<string>();
  /** Workspaces whose Claude Code has no `--safe-mode`, told once in the log. */
  readonly #unsafe = new Set<string>();

  constructor(private readonly o: UsageOptions) {
    this.#store = new UsageStore(o.store);
    this.#spend = new SpendReader(o.store);
    this.#settings = { ...usageSettings(), ...o.settings };
    this.#now = o.now ?? Date.now;
    this.#palette = new Palette(o.store, () => this.#now());
  }

  /** Whether the asking user may use (and so see the usage of) a Claude: the multi-user seam, open to all until users exist. */
  #mayUse(actorId: string, claudeId: string): boolean {
    if (!this.o.canUseClaude) return true;
    try {
      return this.o.canUseClaude(actorId, claudeId);
    } catch {
      return false; // a seam that fails hides, never leaks
    }
  }

  /** Readings are taken and kept only while the portal trusts its database (FR14). */
  #active(): boolean {
    return this.o.store.writable && this.o.store.deliveryAllowed;
  }

  #log(line: string) {
    (this.o.log ?? ((l) => console.log(`[claude-usage] ${l}`)))(line);
  }

  /** A background failure is logged once per kind, never thrown. */
  #warn(what: string, e: unknown) {
    if (this.#warned.has(what)) return;
    this.#warned.add(what);
    console.error(`[claude-usage] ${what} failed: ${(e as Error)?.message ?? 'unknown'}`);
  }

  /* ---------- Life ---------- */

  start(): void {
    if (this.#timers.length) return;
    this.#prune();
    void this.#list(true);
    const first = setTimeout(() => void this.tick(), FIRST_TICK_MS);
    const every = setInterval(() => void this.tick(), TICK_MS);
    const prune = setInterval(() => this.#prune(), PRUNE_EVERY_MS);
    for (const t of [first, every, prune]) t.unref();
    this.#timers = [first, every, prune];
  }

  stop(): void {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers = [];
  }

  #prune() {
    try {
      if (!this.#active()) return;
      this.#store.prune(this.#now(), this.#knownClaudes());
    } catch (e) {
      this.#warn('pruning', e);
    }
  }

  #knownClaudes(): ReadonlySet<string> | undefined {
    return this.#claudes?.list.length ? new Set(this.#claudes.list.map((c) => c.id)) : undefined;
  }

  /** Every Claude that exists, listed at most every few seconds (FR: reads never wait on the runtime twice). */
  async #list(fresh = false): Promise<SourceClaude[]> {
    const now = this.#now();
    if (!fresh && this.#claudes && now - this.#claudes.at < CLAUDES_CACHE_MS) return this.#claudes.list;
    try {
      const list = await this.o.source.claudes();
      this.#claudes = { at: now, list };
      return list;
    } catch (e) {
      this.#warn('listing Claudes', e);
      return this.#claudes?.list ?? [];
    }
  }

  /* ---------- Scheduling ---------- */

  /** Whether a page is open on the Usage tab (it asked for the snapshot with `watch` lately). */
  #watching(now: number): boolean {
    return now < this.#watchedUntil;
  }

  #waitFor(row: LatestRow | null, now: number): number {
    const base = this.#watching(now) ? this.#settings.fastMs : this.#settings.intervalMs;
    let wait = row && (row.runsOn === 'none' || row.runsOn === 'key') ? Math.max(base, SETTLED_MS) : base;
    if (row && row.fails > 0) wait = Math.min(Math.max(wait, base) * 2 ** Math.min(row.fails, 6), MAX_BACKOFF_MS);
    return wait;
  }

  /** `PORTAL_CLAUDE_USAGE_ONLY`: a portal that shares its container runtime with others probes only its own workspaces. */
  #allowed(c: SourceClaude): boolean {
    return !this.#settings.only.length || this.#settings.only.some((p) => c.workspaceName.startsWith(p));
  }

  #due(c: SourceClaude, now: number): boolean {
    const row = this.#store.latest(c.id);
    return !row || now - row.lastProbeAtMs >= this.#waitFor(row, now);
  }

  /** One pass: probes the Claudes that are due (FR10, FR11). Public so a test can drive it. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      if (!this.#settings.probes || !this.#active()) return;
      const list = await this.#list(true);
      const now = this.#now();
      const due = list
        .filter((c) => c.running && this.#allowed(c) && !this.o.source.pooled(c.workspaceId) && this.#due(c, now))
        .sort((a, b) => (this.#store.latest(a.id)?.lastProbeAtMs ?? 0) - (this.#store.latest(b.id)?.lastProbeAtMs ?? 0));
      for (const c of due) {
        if (this.#running >= MAX_PARALLEL) break;
        if (this.#busy.has(c.workspaceId)) continue;
        void this.#probe(c);
      }
    } catch (e) {
      this.#warn('the probe pass', e);
    } finally {
      this.#ticking = false;
    }
  }

  async #probe(c: SourceClaude): Promise<void> {
    this.#busy.add(c.workspaceId);
    this.#running++;
    const started = this.#now();
    try {
      const io: ProbeIo = { exec: (t, n, cmd) => this.o.source.exec(t, n, cmd) };
      const result = await (this.o.probe ?? ((claude, i) => probeClaude(i, claude.target, claude.workspaceName, claude.directory)))(c, io);
      this.#apply(c, result);
      this.#log(`${c.id} ${result.failed ? `failed (${result.problem}${result.unsupported ? ', no --safe-mode' : ''})` : result.runsOn} in ${this.#now() - started} ms`);
      if (result.unsupported && !this.#unsafe.has(c.workspaceId)) {
        // Said once per workspace: a probe there reads nothing until Claude Code is updated, because without safe mode it would run the Claude's hooks (§11).
        this.#unsafe.add(c.workspaceId);
        this.#log(`${c.workspaceName}: Claude Code there has no --safe-mode (it is older than 2.1.169), so its usage is not read: a probe would run the Claude's hooks. Update Claude Code in that workspace.`);
      }
    } catch (e) {
      this.#warn('a probe', e);
      try {
        this.#apply(c, { runsOn: 'unknown', plan: null, windows: [], extra: null, problem: 'unreadable', failed: true });
      } catch {
        // the store is gone: nothing more to record
      }
    } finally {
      this.#busy.delete(c.workspaceId);
      this.#running--;
      this.o.notify?.();
    }
  }

  /** Keeps what a probe found (FR7, FR8). A failed probe keeps the last numbers and only counts the failure. */
  #apply(c: SourceClaude, r: ProbeResult): void {
    if (!this.#active()) return;
    const now = this.#now();
    const prev = this.#store.latest(c.id);
    if (r.failed) {
      this.#store.saveLatest({
        ...(prev ?? this.#blank(c)),
        workspaceId: c.workspaceId,
        runsOn: r.runsOn === 'unknown' ? prev?.runsOn ?? 'unknown' : r.runsOn,
        plan: r.plan ?? prev?.plan ?? null,
        lastProbeAtMs: now,
        problem: r.problem,
        fails: (prev?.fails ?? 0) + 1,
      });
      return;
    }
    const row: LatestRow = {
      ...(prev ?? this.#blank(c)),
      workspaceId: c.workspaceId,
      checkedAtMs: now,
      lastProbeAtMs: now,
      runsOn: r.runsOn,
      plan: r.plan,
      windows: r.windows,
      extra: r.extra,
      source: 'probe',
      problem: r.problem,
      fails: 0,
    };
    this.#store.addSamples(c.id, c.workspaceId, now, r.windows, 'probe');
    this.#store.saveLatest(this.#alerts(c, row, now));
    this.#reading();
  }

  #reading(): void {
    for (const fn of this.#readings) {
      try {
        fn();
      } catch (e) {
        this.#warn('a reading listener', e);
      }
    }
  }

  #blank(c: SourceClaude): LatestRow {
    return { claudeId: c.id, workspaceId: c.workspaceId, checkedAtMs: null, lastProbeAtMs: 0, runsOn: 'unknown', plan: null, windows: [], extra: null, source: null, problem: null, fails: 0, snoozedUntilMs: null, alerted: {}, projAlerted: {}, projSnoozedUntilMs: null };
  }

  /* ---------- Check now ---------- */

  /** Probes one Claude now (FR12). Refused for a pool, a stopped workspace, a cooldown and a probe already running. */
  async check(claudeId: string): Promise<ClaudeUsage> {
    const c = (await this.#list(true)).find((x) => x.id === claudeId);
    if (!c) throw new AppError('NOT_FOUND', 'No such Claude.');
    if (this.o.source.pooled(c.workspaceId)) throw new AppError('CONFLICT', 'This workspace runs on an account pool, so there are no plan limits.');
    if (!c.running) throw new AppError('CONFLICT', 'Start the workspace first.');
    if (!this.#active()) throw new AppError('SERVICE_UNAVAILABLE', 'The portal can’t save readings right now.', { expose: true });
    const now = this.#now();
    const last = this.#manual.get(claudeId);
    if (last !== undefined && now - last < COOLDOWN_MS) throw new AppError('RATE_LIMITED', 'Checked a moment ago.');
    if (this.#busy.has(c.workspaceId)) throw new AppError('CONFLICT', 'A check is already running.');
    this.#manual.set(claudeId, now);
    await this.#probe(c);
    return this.#view(c, this.#store.latest(claudeId), this.#now());
  }

  /* ---------- Passive (§10.2) ---------- */

  /**
   * A live chat session's `rate_limit_info`, handed over by the chat reader (interface I12). It updates the windows it
   * carries; the others stay as the last probe left them. Never throws and never affects the session.
   */
  onRateLimit(sessionId: string, claudeId: string, info: unknown): void {
    try {
      if (!this.#active()) return;
      const parsed = parseRateLimitInfo(info);
      if (!parsed) return;
      const target = this.o.source.sessionClaude(sessionId, claudeId);
      if (!target || this.o.source.pooled(target.workspaceId)) return;
      const now = this.#now();
      // T-255: Claude Code's limit message in the chat (the chat reader made it a refusal of that window): kept as a report until its reset.
      const fromMessage = (info as Record<string, unknown>).reportedBy === LIMIT_MESSAGE_SOURCE;
      let limitReport: LatestRow['limitReport'] = undefined;
      if (fromMessage) {
        const w = parsed.windows.find((x) => parsed.rejected.includes(x.key));
        const raw = info as Record<string, unknown>;
        // A line read again later (a reader that starts over) whose reset is past says nothing about now.
        if (!w || w.resetsAtMs === null || w.resetsAtMs <= now) return;
        const at = typeof raw.reportedAtMs === 'number' && Number.isFinite(raw.reportedAtMs) && raw.reportedAtMs <= now ? raw.reportedAtMs : now;
        limitReport = { window: w.key, atMs: at, untilMs: w.resetsAtMs, guessed: raw.resetGuessed === true, sessionId };
        console.info(`[claudeusage] limit reported by a chat: claude=${target.claudeId} window=${w.key} until=${new Date(w.resetsAtMs).toISOString()}${limitReport.guessed ? ' (guessed: no reset time in the message)' : ''}`);
      }
      const prev = this.#store.latest(target.claudeId);
      const byKey = new Map((prev?.windows ?? []).map((w) => [w.key, w]));
      for (const w of parsed.windows) byKey.set(w.key, { ...w, label: w.label || byKey.get(w.key)?.label || w.key });
      const windows = sortWindows([...byKey.values()]);
      const row: LatestRow = {
        ...(prev ?? { claudeId: target.claudeId, workspaceId: target.workspaceId, checkedAtMs: null, lastProbeAtMs: 0, runsOn: 'plan', plan: null, windows: [], extra: null, source: null, problem: null, fails: 0, snoozedUntilMs: null, alerted: {}, projAlerted: {}, projSnoozedUntilMs: null }),
        workspaceId: target.workspaceId,
        runsOn: 'plan',
        windows,
        checkedAtMs: now,
        source: 'live',
        problem: prev?.problem === 'unavailable' || prev?.problem === 'no_scope' ? null : prev?.problem ?? null,
        ...(limitReport ? { limitReport } : {}),
      };
      // A guessed reset time is no reading of the window's period: no sample from it.
      if (!limitReport?.guessed) this.#store.addSamples(target.claudeId, target.workspaceId, now, parsed.windows, 'live');
      const who: SourceClaude = { id: target.claudeId, name: target.name, directory: '', workspaceId: target.workspaceId, workspaceName: target.workspaceName, target: '', running: true };
      this.#store.saveLatest(this.#alerts(who, row, now));
      this.o.notify?.();
      this.#reading();
    } catch (e) {
      this.#warn('a live reading', e);
    }
  }

  /* ---------- Alerts (§12) ---------- */

  /** Notes the crossings a reading made (once per window, level and period) and returns the row with its marks. */
  #alerts(c: SourceClaude, row: LatestRow, now: number): LatestRow {
    const alerted: Record<string, AlertMark> = {};
    const snoozed = row.snoozedUntilMs !== null && row.snoozedUntilMs > now;
    for (const w of row.windows) {
      const level = alertLevelOf(windowLevel(w.usedPct, w.resetsAtMs, now));
      const old = row.alerted[w.key];
      // A window that resets starts a new period: the old mark is forgotten.
      const same = old && (old.resetsAtMs === w.resetsAtMs || (old.resetsAtMs !== null && w.resetsAtMs !== null && Math.abs(old.resetsAtMs - w.resetsAtMs) < SAME_PERIOD_MS));
      const mark = same ? old : undefined;
      if (level && ALERT_RANK[level] > ALERT_RANK[mark?.level ?? 'none']) {
        const next: AlertMark = { level, resetsAtMs: w.resetsAtMs, atMs: now, ...(snoozed ? { quiet: true } : {}) };
        alerted[w.key] = next;
        if (!snoozed) this.#emit(c, w, next);
      } else if (mark) alerted[w.key] = mark;
    }
    return this.#projections(c, { ...row, alerted }, now);
  }

  /**
   * "Will run out before reset" (§20.4): told once per window and period for the windows that stop a Claude altogether, when the pace says
   * `over` on three or more readings spanning at least a tenth of the window, and the window is not used up yet. A period that ends forgets
   * its mark; a projection that falls back and rises again in the same period is not told twice.
   */
  #projections(c: SourceClaude, row: LatestRow, now: number): LatestRow {
    const projAlerted: Record<string, ProjectionMark> = {};
    const snoozed = (row.snoozedUntilMs !== null && row.snoozedUntilMs > now) || (row.projSnoozedUntilMs !== null && row.projSnoozedUntilMs > now);
    for (const w of row.windows) {
      const old = row.projAlerted[w.key];
      if (old && w.resetsAtMs !== null && Math.abs(old.resetsAtMs - w.resetsAtMs) < SAME_PERIOD_MS) {
        projAlerted[w.key] = old;
        continue;
      }
      if (!ALL_MODEL_WINDOWS.includes(w.key) || w.resetsAtMs === null || w.usedPct === null) continue;
      const pace = this.#pace(c.id, w.key, w.usedPct, w.resetsAtMs, row.checkedAtMs, false, now);
      if (pace.status.value !== 'over' || pace.lowConfidence || pace.etaAt.value === null || pace.projectedPct.value === null) continue;
      const mark: ProjectionMark = { resetsAtMs: w.resetsAtMs, atMs: now, usedPct: w.usedPct, etaMs: Date.parse(pace.etaAt.value), projectedPct: pace.projectedPct.value, ...(snoozed ? { quiet: true } : {}) };
      projAlerted[w.key] = mark;
      if (!snoozed) this.#emitAlert(this.#projectionAlert(c.id, c.name, c.workspaceName, w.key, w.label, mark));
    }
    return { ...row, projAlerted };
  }

  #projectionAlert(claudeId: string, claudeName: string, workspaceName: string, key: string, label: string, mark: ProjectionMark): ClaudeUsageAlert {
    return {
      id: `${claudeId}|${key}|projection|${mark.resetsAtMs}`,
      claudeId,
      claudeName,
      workspaceName,
      window: key,
      label,
      level: 'near',
      usedPct: mark.usedPct,
      resetsAt: new Date(mark.resetsAtMs).toISOString(),
      at: new Date(mark.atMs).toISOString(),
      kind: 'projection',
      etaAt: new Date(mark.etaMs).toISOString(),
      projectedPct: mark.projectedPct,
    };
  }

  #emitAlert(alert: ClaudeUsageAlert) {
    for (const sink of this.#sinks) {
      try {
        sink(alert);
      } catch (e) {
        this.#warn('an alert sink', e);
      }
    }
  }

  #emit(c: SourceClaude, w: WindowReading, mark: AlertMark) {
    this.#emitAlert(this.#alertOf(c.id, c.name, c.workspaceName, w, mark));
  }

  #alertOf(claudeId: string, claudeName: string, workspaceName: string, w: WindowReading, mark: AlertMark): ClaudeUsageAlert {
    return {
      id: `${claudeId}|${w.key}|${mark.level}|${mark.resetsAtMs ?? 0}`,
      claudeId,
      claudeName,
      workspaceName,
      window: w.key,
      label: w.label,
      level: mark.level,
      usedPct: w.usedPct,
      resetsAt: mark.resetsAtMs === null ? null : new Date(mark.resetsAtMs).toISOString(),
      at: new Date(mark.atMs).toISOString(),
    };
  }

  /** The usage window keys of a Claude's last reading (T-109: whether it shows a model's own limit, like Fable's week); [] when none. */
  windowKeys(claudeId: string): string[] {
    try {
      return (this.#store.latest(claudeId)?.windows ?? []).map((w) => w.key);
    } catch {
      return [];
    }
  }

  /** Calls `fn` after every new reading of any Claude (a probe or a live `rate_limit_info`); returns the way to stop. Never with data. */
  onReading(fn: () => void): () => void {
    this.#readings.add(fn);
    return () => this.#readings.delete(fn);
  }

  /** Calls `fn` for each new crossing: the seam where push notifications plug in later (§12). Returns the way to stop. */
  onAlert(fn: (alert: ClaudeUsageAlert) => void): () => void {
    this.#sinks.add(fn);
    return () => this.#sinks.delete(fn);
  }

  /* ---------- Snooze (FR17) ---------- */

  /** `kind: 'projection'` silences only the "will run out before reset" alerts (§20.4); without it every alert of the Claude is silenced. */
  async snooze(claudeId: string, until: SnoozeUntil, kind?: SnoozeKind): Promise<ClaudeUsage> {
    const c = (await this.#list()).find((x) => x.id === claudeId);
    if (!c) throw new AppError('NOT_FOUND', 'No such Claude.');
    const now = this.#now();
    const row = this.#store.latest(claudeId) ?? this.#blank(c);
    let end: number;
    if (until === '1h') end = now + HOUR;
    else if (until === '4h') end = now + 4 * HOUR;
    else {
      // Until the next reset among the windows that are in the way (for projections: the windows that stop the Claude); four hours when none says.
      const inTheWay = kind === 'projection' ? row.windows.filter((w) => ALL_MODEL_WINDOWS.includes(w.key)) : row.windows.filter((w) => alertLevelOf(windowLevel(w.usedPct, w.resetsAtMs, now)));
      const resets = inTheWay.filter((w) => w.resetsAtMs !== null && w.resetsAtMs > now).map((w) => w.resetsAtMs!);
      end = resets.length ? Math.min(...resets) : now + 4 * HOUR;
    }
    this.#write(kind === 'projection' ? { ...row, projSnoozedUntilMs: end } : { ...row, snoozedUntilMs: end });
    this.o.notify?.();
    return this.#view(c, this.#store.latest(claudeId), now);
  }

  async unsnooze(claudeId: string, kind?: SnoozeKind): Promise<ClaudeUsage> {
    const c = (await this.#list()).find((x) => x.id === claudeId);
    if (!c) throw new AppError('NOT_FOUND', 'No such Claude.');
    const row = this.#store.latest(claudeId);
    if (row) this.#write(kind === 'projection' ? { ...row, projSnoozedUntilMs: null } : { ...row, snoozedUntilMs: null });
    this.o.notify?.();
    return this.#view(c, this.#store.latest(claudeId), this.#now());
  }

  #write(row: LatestRow) {
    if (!this.#active()) throw new AppError('SERVICE_UNAVAILABLE', 'The portal can’t save changes right now.', { expose: true });
    this.#store.saveLatest(row);
  }

  /* ---------- Reading ---------- */

  #view(c: SourceClaude, row: LatestRow | null, now: number, slot: PaletteSlot = this.#slotOf(c, now)): ClaudeUsage {
    const pooled = this.o.source.pooled(c.workspaceId);
    const runsOn: ClaudeRunsOn = pooled ? 'pool' : row?.runsOn ?? 'unknown';
    const report = pooled || !row?.limitReport || row.limitReport.untilMs <= now ? null : row.limitReport;
    const windows = pooled ? [] : withLimitReport(row?.windows ?? [], report, now);
    const checkedMs = pooled ? null : row?.checkedAtMs ?? null;
    const snoozed = row?.snoozedUntilMs != null && row.snoozedUntilMs > now;
    const stale = checkedMs !== null && (!c.running || now - checkedMs > STALE_AFTER * this.#settings.intervalMs);
    const checkedAt = checkedMs === null ? null : new Date(checkedMs).toISOString();
    const view = viewWindows(windows, now).map((w) => ({ ...w, pace: this.#pace(c.id, w.key, w.usedPct, w.resetsAt ? Date.parse(w.resetsAt) : null, checkedMs, stale, now) }));
    const projSnoozed = row?.projSnoozedUntilMs != null && row.projSnoozedUntilMs > now;
    const limitReport: ClaudeLimitReport | null = report
      ? { window: report.window, label: windows.find((w) => w.key === report.window)?.label ?? report.window, at: new Date(report.atMs).toISOString(), until: new Date(report.untilMs).toISOString(), guessed: report.guessed, sessionId: report.sessionId }
      : null;
    const problem = pooled ? null : row?.problem ?? null;
    // T-255: why the usage is not known (never 0 %); a Claude whose numbers can't be trusted is `unknown`, not `ok`.
    const unavailable = pooled ? null : usageUnavailable({ runsOn, windows: view, checkedAt, problem, limitReport }, now);
    const state0 = pooled ? 'no_limits' : stateOf(runsOn, windows, now);
    return {
      claudeId: c.id,
      claudeName: c.name,
      workspaceId: c.workspaceId,
      workspaceName: c.workspaceName,
      runsOn,
      state: unavailable && state0 === 'ok' ? 'unknown' : state0,
      plan: pooled ? null : row?.plan ?? null,
      windows: view,
      extra: pooled || !row?.extra ? null : { enabled: row.extra.enabled, usedPct: row.extra.usedPct, limit: row.extra.limit, used: row.extra.used, currency: row.extra.currency },
      checkedAt,
      source: pooled ? null : row?.source ?? null,
      stale,
      workspaceRunning: c.running,
      problem,
      unavailable,
      limitReport,
      snoozedUntil: snoozed ? new Date(row!.snoozedUntilMs!).toISOString() : null,
      projectionSnoozedUntil: projSnoozed ? new Date(row!.projSnoozedUntilMs!).toISOString() : null,
      slot,
      outlook: outlookOf({ runsOn, windows: view, checkedAt }),
      trend: pooled ? null : this.#trend(c.id, windows, now),
    };
  }

  /** The palette slot a Claude keeps everywhere (§20.6), given on first sight. */
  #slotOf(c: SourceClaude, now: number): PaletteSlot {
    return this.#palette.slots('claude', [{ key: c.id, seenMs: now }]).get(c.id) ?? null;
  }

  /** One window's speed and pace from its readings of the current period (§20.2). */
  #pace(claudeId: string, key: string, usedPct: number | null, resetsAtMs: number | null, checkedMs: number | null, stale: boolean, now: number) {
    const length = windowLengthMs(key);
    // Readings older than the period's start can't be in it: a window's period is at most its length long.
    const since = resetsAtMs !== null && length !== null ? resetsAtMs - length - 10 * MINUTE : now - PACE_LOOKBACK_MS;
    const samples = usedPct === null ? [] : this.#store.windowSamples(claudeId, key, since);
    return windowPace({ key, usedPct, resetsAtMs, readAtMs: checkedMs, samples, nowMs: now, stale });
  }

  /** The week window's last 7 days (else the session's, else the first), as a few dozen points for the row's sparkline. */
  #trend(claudeId: string, windows: WindowReading[], now: number): ClaudeUsage['trend'] {
    const w = windows.find((x) => x.key === 'week') ?? windows.find((x) => x.key === 'session') ?? windows[0];
    if (!w) return null;
    const points = thin(this.#store.history(claudeId, now - RANGE_MS['7d'], w.key), TREND_POINTS).map((p) => ({ at: new Date(p.atMs).toISOString(), usedPct: p.usedPct }));
    return points.length ? { key: w.key, label: w.label, points } : null;
  }

  /** The snapshot (FR18). `watch`: a page is open on the Usage tab, so probing runs at the faster interval for a while. */
  async report(opts: { watch?: boolean; actorId?: string } = {}): Promise<ClaudeUsageReport> {
    const now = this.#now();
    if (opts.watch) this.#watchedUntil = now + WATCH_MS;
    const list = await this.#list();
    const rows = new Map(this.#store.allLatest().map((r) => [r.claudeId, r]));
    const slots = this.#palette.slots('claude', list.map((c) => ({ key: c.id, seenMs: now })));
    const claudes = list.map((c) => this.#view(c, rows.get(c.id) ?? null, now, slots.get(c.id) ?? null));
    const alerts: ClaudeUsageAlert[] = [];
    for (const [i, c] of list.entries()) {
      const row = rows.get(c.id);
      if (!row || this.o.source.pooled(c.workspaceId) || (row.snoozedUntilMs !== null && row.snoozedUntilMs > now)) continue;
      for (const [key, mark] of Object.entries(row.alerted)) {
        const w = row.windows.find((x) => x.key === key);
        // Told within the day, not quiet, and its period (the window's reset time) not over: a new device isn't told old news.
        if (!w || mark.quiet || now - mark.atMs > ALERT_WINDOW_MS || (mark.resetsAtMs !== null && mark.resetsAtMs <= now)) continue;
        alerts.push(this.#alertOf(c.id, c.name, c.workspaceName, w, mark));
      }
      if (row.projSnoozedUntilMs !== null && row.projSnoozedUntilMs > now) continue;
      for (const [key, mark] of Object.entries(row.projAlerted)) {
        const w = claudes[i]!.windows.find((x) => x.key === key);
        // The same rules, and the projection must still hold: its estimate is shown as it stands now, never as it stood when it was told.
        if (!w || mark.quiet || now - mark.atMs > ALERT_WINDOW_MS || mark.resetsAtMs <= now) continue;
        const pace = w.pace;
        if (!pace || pace.status.value !== 'over' || pace.lowConfidence || pace.etaAt.value === null || pace.projectedPct.value === null) continue;
        alerts.push(this.#projectionAlert(c.id, c.name, c.workspaceName, key, w.label, { ...mark, usedPct: w.usedPct ?? mark.usedPct, etaMs: Date.parse(pace.etaAt.value), projectedPct: pace.projectedPct.value }));
      }
    }
    alerts.sort((a, b) => b.at.localeCompare(a.at));
    const actor = opts.actorId ?? OWNER_ACTOR;
    return {
      claudes: claudes.filter((c) => this.#mayUse(actor, c.claudeId)),
      alerts: alerts.filter((a) => this.#mayUse(actor, a.claudeId)),
      thresholds: { warn: USAGE_THRESHOLDS.warn, critical: USAGE_THRESHOLDS.critical },
      intervalMs: this.#watching(now) ? this.#settings.fastMs : this.#settings.intervalMs,
      now: new Date(now).toISOString(),
    };
  }

  /** The Claude a live chat session runs in, or null (the Portal MCP tool keeps an agent to this one). */
  claudeOfSession(sessionId: string): string | null {
    try {
      return this.o.source.sessionClaude(sessionId, '')?.claudeId ?? null;
    } catch {
      return null;
    }
  }

  /** What a Claude has left (FR15). Never throws and never probes. */
  headroom(claudeId: string): Headroom {
    try {
      const now = this.#now();
      const c = this.#claudes?.list.find((x) => x.id === claudeId);
      const row = this.#store.latest(claudeId);
      const pooled = c ? this.o.source.pooled(c.workspaceId) : false;
      const stale = row?.checkedAtMs != null && ((c ? !c.running : false) || now - row.checkedAtMs > STALE_AFTER * this.#settings.intervalMs);
      return headroomOf(claudeId, row ? { ...row, windows: withLimitReport(row.windows, row.limitReport, now) } : null, { pooled, stale }, now);
    } catch {
      return { claudeId, kind: 'unknown', limiting: null, exhausted: false, availableAt: null, blockedModels: [], checkedAt: null, stale: false };
    }
  }

  /* ---------- Insight (§20) ---------- */

  /** The Requests report with the previous period, the cache split, palette slots and the series for stacked charts (§20.8). */
  requestsReport(range: unknown, opts: { claudeId?: string; tzOffsetMin?: number; actorId?: string } = {}): RequestsReport {
    if (!isUsageRange(range)) throw new AppError('VALIDATION_FAILED', `Pick a range: ${CHAT_USAGE_RANGES.join(', ')}.`, { details: { range: `One of ${CHAT_USAGE_RANGES.join(', ')}.` } });
    const actor = opts.actorId ?? OWNER_ACTOR;
    return buildRequestsReport({ reader: this.#spend, palette: this.#palette, allow: (k) => this.#mayUse(actor, k.claudeId || k.key) }, range, { claudeId: opts.claudeId || undefined, tzOffsetMin: opts.tzOffsetMin, now: this.#now() });
  }

  /** The summary strip (§20.7): spend today, speed, time until the limit and the next reset, overall or for one Claude. */
  async summary(opts: { claudeId?: string; tzOffsetMin?: number; actorId?: string } = {}): Promise<UsageSummary> {
    const actor = opts.actorId ?? OWNER_ACTOR;
    const report = await this.report({ actorId: actor });
    if (opts.claudeId && !report.claudes.some((c) => c.claudeId === opts.claudeId)) throw new AppError('NOT_FOUND', 'No such Claude.');
    const nowMs = this.#now();
    return buildSummary({ claudes: report.claudes, rows: this.#spend.rowsBetween(summaryRowsFrom(nowMs, opts.tzOffsetMin)), refs: this.#spend.claudes(), nowMs, tzOffsetMin: opts.tzOffsetMin, claudeId: opts.claudeId || undefined, allow: (k) => this.#mayUse(actor, k.claudeId || k.key) });
  }

  /**
   * The Claudes of `workspaceId` a chat can move to, ranked (§20.5), `fromClaudeId` (the one it leaves) left out, and only those `actorId` may use.
   * In-process for the auto-transfer; the route and the Portal MCP tool call it too. Advice only: nothing is moved.
   */
  async recommend(workspaceId: string, fromClaudeId?: string | null, actorId: string = OWNER_ACTOR): Promise<MoveRecommendation> {
    const report = await this.report({ actorId });
    return recommendMove(report.claudes, { workspaceId, from: fromClaudeId || null, nowMs: this.#now() });
  }

  /** The same when only the Claude the chat leaves is known: its workspace is the one. */
  async recommendFrom(fromClaudeId: string, actorId: string = OWNER_ACTOR): Promise<MoveRecommendation> {
    const report = await this.report({ actorId });
    const workspaceId = report.claudes.find((c) => c.claudeId === fromClaudeId)?.workspaceId;
    if (!workspaceId) throw new AppError('NOT_FOUND', 'No such Claude.');
    return recommendMove(report.claudes, { workspaceId, from: fromClaudeId, nowMs: this.#now() });
  }

  /**
   * What a Claude has left and where its limits are heading, in one call (§20.2): `headroom` is FR15's answer, `limit` says whether a limit that stops
   * the Claude is projected to run out before it resets. Like `headroom` it reads what is stored (the list of Claudes as last seen), never throws and
   * never probes; a Claude it does not know answers unknown.
   */
  outlook(claudeId: string): { headroom: Headroom; limit: LimitOutlook } {
    try {
      const c = this.#claudes?.list.find((x) => x.id === claudeId);
      if (c) return { headroom: this.headroom(claudeId), limit: this.#view(c, this.#store.latest(claudeId), this.#now()).outlook };
    } catch {
      // answered below as unknown
    }
    return { headroom: this.headroom(claudeId), limit: unavailableOutlook('no_reading') };
  }

  /** A request finished (the chat controller's hook, when wired): tells open pages the strip's spend changed. Never throws. */
  noteSpend(): void {
    try {
      this.o.notify?.();
    } catch {
      // a page that cannot be told simply reads the next time
    }
  }

  /** Every palette assignment (§20.6). */
  palette(): UsagePalette {
    return this.#palette.all();
  }

  /** A download (§20.9): the Requests report or the plan readings, as CSV or JSON. */
  async exportFile(q: Partial<UsageExportQuery>, actorId: string = OWNER_ACTOR): Promise<{ body: string; contentType: string; fileName: string }> {
    const what = q.what ?? 'requests';
    const format = q.format ?? 'json';
    if (what !== 'requests' && what !== 'quota') throw new AppError('VALIDATION_FAILED', 'Pick requests or quota.', { details: { what: 'One of requests, quota.' } });
    if (format !== 'csv' && format !== 'json') throw new AppError('VALIDATION_FAILED', 'Pick csv or json.', { details: { format: 'One of csv, json.' } });
    const range = q.range ?? '1d';
    const contentType = format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8';
    const fileName = exportFileName(what, range, format);
    const nowMs = this.#now();
    if (what === 'requests') {
      const report = this.requestsReport(range, { claudeId: q.claudeId, tzOffsetMin: q.tz, actorId });
      const allow = (k: { claudeId: string; key: string }) => this.#mayUse(actorId, k.claudeId || k.key);
      return { body: format === 'csv' ? requestsCsv(this.#spend, report.range, { claudeId: q.claudeId || undefined, tzOffsetMin: q.tz, now: nowMs, allow }) : JSON.stringify(report, null, 2), contentType, fileName };
    }
    if (!(USAGE_RANGES as readonly string[]).includes(range)) throw new AppError('VALIDATION_FAILED', 'Plan readings come in 1d, 7d or 30d.', { details: { range: 'One of 1d, 7d, 30d.' } });
    const list = (await this.#list()).filter((c) => (!q.claudeId || c.id === q.claudeId) && this.#mayUse(actorId, c.id));
    if (q.claudeId && !list.length) throw new AppError('NOT_FOUND', 'No such Claude.');
    const histories = list.map((c) => ({ claudeName: c.name, workspaceName: c.workspaceName, history: this.#history(c.id, range as UsageRange, nowMs, Infinity) }));
    return { body: format === 'csv' ? quotaCsv(histories) : JSON.stringify(histories.map((h) => h.history), null, 2), contentType, fileName };
  }

  /** A Claude's windows over a range, as a line each (at most 200 points). */
  async history(claudeId: string, range: string): Promise<ClaudeUsageHistory> {
    if (!(USAGE_RANGES as readonly string[]).includes(range)) throw new AppError('VALIDATION_FAILED', 'Pick 1d, 7d or 30d.', { details: { range: 'One of 1d, 7d, 30d.' } });
    const c = (await this.#list()).find((x) => x.id === claudeId);
    if (!c) throw new AppError('NOT_FOUND', 'No such Claude.');
    return this.#history(claudeId, range as UsageRange, this.#now(), MAX_POINTS);
  }

  /** The readings of a Claude over a range as a line per window, thinned to `max` points each (Infinity: every stored reading). */
  #history(claudeId: string, range: UsageRange, now: number, max: number): ClaudeUsageHistory {
    const from = now - RANGE_MS[range];
    const rows = this.#store.history(claudeId, from);
    const labels = new Map((this.#store.latest(claudeId)?.windows ?? []).map((w) => [w.key, w.label]));
    const by = new Map<string, { atMs: number; usedPct: number }[]>();
    for (const r of rows) {
      const list = by.get(r.win);
      if (list) list.push({ atMs: r.atMs, usedPct: r.usedPct });
      else by.set(r.win, [{ atMs: r.atMs, usedPct: r.usedPct }]);
    }
    const series = sortWindows([...by.keys()].map((key) => ({ key, label: labels.get(key) ?? key, usedPct: null, resetsAtMs: null }))).map((w) => ({
      key: w.key,
      label: w.label,
      points: thin(by.get(w.key)!, max).map((p) => ({ at: new Date(p.atMs).toISOString(), usedPct: p.usedPct })),
    }));
    return { claudeId, range, from: new Date(from).toISOString(), to: new Date(now).toISOString(), series };
  }
}

/** At most `max` points, keeping the first and the last and spreading the rest evenly. */
function thin<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

