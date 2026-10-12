// Claude usage: the plan limits of each Claude (docs/prd/claude-usage.md). A scheduler asks Claude Code, in each
// running workspace and as each Claude, for its usage (probe.ts); live chat sessions add what their streams carry
// (`onRateLimit`); one store keeps the readings; and `report`, `headroom` and the alerts read it.
//
// Start-up and every background pass are skipped unless the portal trusts its database (`deliveryAllowed`) and wrapped in
// try/catch, so a frozen or newer database never takes the portal down (QA-011, foundation §6.5).

import { AppError } from '@isnanme/core';
import {
  USAGE_RANGES,
  USAGE_THRESHOLDS,
  type ClaudeRunsOn,
  type ClaudeUsage,
  type ClaudeUsageAlert,
  type ClaudeUsageHistory,
  type ClaudeUsageReport,
  type Headroom,
  type SnoozeUntil,
  type UsageRange,
} from '@portal/contracts';
import type { Store } from '../store/store.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { ALERT_RANK, alertLevelOf, headroomOf, stateOf, viewWindows } from './derive.js';
import { parseRateLimitInfo, sortWindows, windowLevel, type WindowReading } from './parse.js';
import { probeClaude, type ProbeIo, type ProbeResult } from './probe.js';
import { UsageStore, type AlertMark, type LatestRow } from './store.js';

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

export function usageSettings(over: Partial<{ probes: boolean; intervalS: number; fastS: number; only: string[] }> = {}): UsageSettings {
  const secs = (v: unknown, dflt: number, min: number) => Math.max(min, typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt) * 1000;
  return { probes: over.probes !== false, intervalMs: secs(over.intervalS, 600, 60), fastMs: secs(over.fastS, 120, 30), only: over.only ?? [] };
}

export class ClaudeUsageMonitor {
  readonly #store: UsageStore;
  readonly #settings: UsageSettings;
  readonly #now: () => number;
  readonly #sinks = new Set<(alert: ClaudeUsageAlert) => void>();
  /** Workspaces with a probe running: one at a time each. */
  readonly #busy = new Set<string>();
  readonly #manual = new Map<string, number>();
  #running = 0;
  #watchedUntil = 0;
  #claudes: { at: number; list: SourceClaude[] } | null = null;
  #timers: NodeJS.Timeout[] = [];
  #ticking = false;
  readonly #warned = new Set<string>();

  constructor(private readonly o: UsageOptions) {
    this.#store = new UsageStore(o.store);
    this.#settings = { ...usageSettings(), ...o.settings };
    this.#now = o.now ?? Date.now;
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
      this.#log(`${c.id} ${result.failed ? `failed (${result.problem})` : result.runsOn} in ${this.#now() - started} ms`);
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
  }

  #blank(c: SourceClaude): LatestRow {
    return { claudeId: c.id, workspaceId: c.workspaceId, checkedAtMs: null, lastProbeAtMs: 0, runsOn: 'unknown', plan: null, windows: [], extra: null, source: null, problem: null, fails: 0, snoozedUntilMs: null, alerted: {} };
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
      const prev = this.#store.latest(target.claudeId);
      const byKey = new Map((prev?.windows ?? []).map((w) => [w.key, w]));
      for (const w of parsed.windows) byKey.set(w.key, { ...w, label: w.label || byKey.get(w.key)?.label || w.key });
      const windows = sortWindows([...byKey.values()]);
      const row: LatestRow = {
        ...(prev ?? { claudeId: target.claudeId, workspaceId: target.workspaceId, checkedAtMs: null, lastProbeAtMs: 0, runsOn: 'plan', plan: null, windows: [], extra: null, source: null, problem: null, fails: 0, snoozedUntilMs: null, alerted: {} }),
        workspaceId: target.workspaceId,
        runsOn: 'plan',
        windows,
        checkedAtMs: now,
        source: 'live',
        problem: prev?.problem === 'unavailable' || prev?.problem === 'no_scope' ? null : prev?.problem ?? null,
      };
      this.#store.addSamples(target.claudeId, target.workspaceId, now, parsed.windows, 'live');
      const who: SourceClaude = { id: target.claudeId, name: target.name, directory: '', workspaceId: target.workspaceId, workspaceName: target.workspaceName, target: '', running: true };
      this.#store.saveLatest(this.#alerts(who, row, now));
      this.o.notify?.();
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
    return { ...row, alerted };
  }

  #emit(c: SourceClaude, w: WindowReading, mark: AlertMark) {
    const alert = this.#alertOf(c.id, c.name, c.workspaceName, w, mark);
    for (const sink of this.#sinks) {
      try {
        sink(alert);
      } catch (e) {
        this.#warn('an alert sink', e);
      }
    }
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

  /** Calls `fn` for each new crossing: the seam where push notifications plug in later (§12). Returns the way to stop. */
  onAlert(fn: (alert: ClaudeUsageAlert) => void): () => void {
    this.#sinks.add(fn);
    return () => this.#sinks.delete(fn);
  }

  /* ---------- Snooze (FR17) ---------- */

  async snooze(claudeId: string, until: SnoozeUntil): Promise<ClaudeUsage> {
    const c = (await this.#list()).find((x) => x.id === claudeId);
    if (!c) throw new AppError('NOT_FOUND', 'No such Claude.');
    const now = this.#now();
    const row = this.#store.latest(claudeId) ?? this.#blank(c);
    let end: number;
    if (until === '1h') end = now + HOUR;
    else if (until === '4h') end = now + 4 * HOUR;
    else {
      // Until the next reset among the windows that are in the way; four hours when none says.
      const resets = row.windows.filter((w) => alertLevelOf(windowLevel(w.usedPct, w.resetsAtMs, now)) && w.resetsAtMs !== null).map((w) => w.resetsAtMs!);
      end = resets.length ? Math.min(...resets) : now + 4 * HOUR;
    }
    this.#write({ ...row, snoozedUntilMs: end });
    this.o.notify?.();
    return this.#view(c, this.#store.latest(claudeId), now);
  }

  async unsnooze(claudeId: string): Promise<ClaudeUsage> {
    const c = (await this.#list()).find((x) => x.id === claudeId);
    if (!c) throw new AppError('NOT_FOUND', 'No such Claude.');
    const row = this.#store.latest(claudeId);
    if (row) this.#write({ ...row, snoozedUntilMs: null });
    this.o.notify?.();
    return this.#view(c, this.#store.latest(claudeId), this.#now());
  }

  #write(row: LatestRow) {
    if (!this.#active()) throw new AppError('SERVICE_UNAVAILABLE', 'The portal can’t save changes right now.', { expose: true });
    this.#store.saveLatest(row);
  }

  /* ---------- Reading ---------- */

  #view(c: SourceClaude, row: LatestRow | null, now: number): ClaudeUsage {
    const pooled = this.o.source.pooled(c.workspaceId);
    const runsOn: ClaudeRunsOn = pooled ? 'pool' : row?.runsOn ?? 'unknown';
    const windows = pooled ? [] : row?.windows ?? [];
    const checkedMs = pooled ? null : row?.checkedAtMs ?? null;
    const snoozed = row?.snoozedUntilMs != null && row.snoozedUntilMs > now;
    return {
      claudeId: c.id,
      claudeName: c.name,
      workspaceId: c.workspaceId,
      workspaceName: c.workspaceName,
      runsOn,
      state: pooled ? 'no_limits' : stateOf(runsOn, windows, now),
      plan: pooled ? null : row?.plan ?? null,
      windows: viewWindows(windows, now),
      extra: pooled || !row?.extra ? null : { enabled: row.extra.enabled, usedPct: row.extra.usedPct, limit: row.extra.limit, used: row.extra.used, currency: row.extra.currency },
      checkedAt: checkedMs === null ? null : new Date(checkedMs).toISOString(),
      source: pooled ? null : row?.source ?? null,
      stale: checkedMs !== null && (!c.running || now - checkedMs > STALE_AFTER * this.#settings.intervalMs),
      workspaceRunning: c.running,
      problem: pooled ? null : row?.problem ?? null,
      snoozedUntil: snoozed ? new Date(row!.snoozedUntilMs!).toISOString() : null,
      trend: pooled ? null : this.#trend(c.id, windows, now),
    };
  }

  /** The week window's last 7 days (else the session's, else the first), as a few dozen points for the row's sparkline. */
  #trend(claudeId: string, windows: WindowReading[], now: number): ClaudeUsage['trend'] {
    const w = windows.find((x) => x.key === 'week') ?? windows.find((x) => x.key === 'session') ?? windows[0];
    if (!w) return null;
    const points = thin(this.#store.history(claudeId, now - RANGE_MS['7d'], w.key), TREND_POINTS).map((p) => ({ at: new Date(p.atMs).toISOString(), usedPct: p.usedPct }));
    return points.length ? { key: w.key, label: w.label, points } : null;
  }

  /** The snapshot (FR18). `watch`: a page is open on the Usage tab, so probing runs at the faster interval for a while. */
  async report(opts: { watch?: boolean } = {}): Promise<ClaudeUsageReport> {
    const now = this.#now();
    if (opts.watch) this.#watchedUntil = now + WATCH_MS;
    const list = await this.#list();
    const rows = new Map(this.#store.allLatest().map((r) => [r.claudeId, r]));
    const claudes = list.map((c) => this.#view(c, rows.get(c.id) ?? null, now));
    const alerts: ClaudeUsageAlert[] = [];
    for (const c of list) {
      const row = rows.get(c.id);
      if (!row || this.o.source.pooled(c.workspaceId) || (row.snoozedUntilMs !== null && row.snoozedUntilMs > now)) continue;
      for (const [key, mark] of Object.entries(row.alerted)) {
        const w = row.windows.find((x) => x.key === key);
        // Told within the day, not quiet, and its period (the window's reset time) not over: a new device isn't told old news.
        if (!w || mark.quiet || now - mark.atMs > ALERT_WINDOW_MS || (mark.resetsAtMs !== null && mark.resetsAtMs <= now)) continue;
        alerts.push(this.#alertOf(c.id, c.name, c.workspaceName, w, mark));
      }
    }
    alerts.sort((a, b) => b.at.localeCompare(a.at));
    return {
      claudes,
      alerts,
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
      return headroomOf(claudeId, row, { pooled, stale }, now);
    } catch {
      return { claudeId, kind: 'unknown', limiting: null, exhausted: false, availableAt: null, blockedModels: [], checkedAt: null, stale: false };
    }
  }

  /** A Claude's windows over a range, as a line each (at most 200 points). */
  async history(claudeId: string, range: string): Promise<ClaudeUsageHistory> {
    if (!(USAGE_RANGES as readonly string[]).includes(range)) throw new AppError('VALIDATION_FAILED', 'Pick 1d, 7d or 30d.', { details: { range: 'One of 1d, 7d, 30d.' } });
    const c = (await this.#list()).find((x) => x.id === claudeId);
    if (!c) throw new AppError('NOT_FOUND', 'No such Claude.');
    const now = this.#now();
    const from = now - RANGE_MS[range as UsageRange];
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
      points: thin(by.get(w.key)!, MAX_POINTS).map((p) => ({ at: new Date(p.atMs).toISOString(), usedPct: p.usedPct })),
    }));
    return { claudeId, range: range as UsageRange, from: new Date(from).toISOString(), to: new Date(now).toISOString(), series };
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

