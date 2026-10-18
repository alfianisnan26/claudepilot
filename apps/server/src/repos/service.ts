// Workspace git: the service (docs/prd/workspace-git.md). It finds the git repositories inside a workspace by looking, reads each one
// without changing it, keeps what it saw and what changed (the audit), and makes the few changes it is asked to make: a worktree, a
// fast-forward sync. Everything runs through the session host's hardened git (chat/host.ts) in the workspace; nothing here
// touches a repository by any other way, and a scan never fetches.

import { randomBytes } from 'node:crypto';
import { AppError } from '@isnanme/core';
import {
  REPO_ROOTS_MAX,
  type ChatServerMessage,
  type ChatSession,
  type CreateRepoWorktreeRequest,
  type CreateRepoWorktreeResult,
  type RemoveRepoWorktreeResult,
  type RepoDetail,
  type RepoEventData,
  type RepoEventKind,
  type RepoEventPage,
  type RepoEventQuery,
  type RepoNode,
  type RepoScanInfo,
  type RepoSession,
  type RepoSettings,
  type ReposOverview,
  type RepoSyncResult,
  type RepoSyncOutcome,
  type UpdateRepoSettingsRequest,
  type WorkspaceRepos,
} from '@portal/contracts';
import type { Store } from '../store/store.js';
import { Worktrees } from '../chat/worktrees.js';
import { describe, diffScan, type EventDraft } from './events.js';
import type { RepoHost } from './host.js';
import { mainFolder, parseFind, parseState, parseSync, type FoundRepo, type RawRepo } from './parse.js';
import { RepoStore, type NewEvent, type StoredRepo } from './store.js';
import { basename, plain, repoId, within } from './text.js';
import { addSummaries, attentionOf, buildNodes, orderNodes, summarize, type NodeCore } from './tree.js';
import { loop } from '../platform/loops.js';

export interface ReposConfig {
  /** Scan on a timer while workspaces run. */
  auto: boolean;
  /** Seconds between automatic scans of one workspace (each is jittered by 20 %). */
  intervalS: number;
  /** What is scanned unless a workspace names its own folders: `~` is the home folder. */
  roots: string[];
  /** How many folders down a scan looks, and how many repositories it follows. */
  depth: number;
  maxRepos: number;
  /** Scans at once across all workspaces. */
  concurrency: number;
  /** How long one scan may read before it stops and keeps what it has. */
  scanBudgetMs: number;
  /** The least seconds between two syncs of one "keep synced" worktree. */
  syncEveryS: number;
  /** After a chat's turn ends, how long to wait (so a burst is one look), and the least time between two such looks in one workspace. */
  sessionScanDelayMs: number;
  sessionScanGapMs: number;
}

export const DEFAULT_REPOS_CONFIG: ReposConfig = { auto: true, intervalS: 300, roots: ['~'], depth: 6, maxRepos: 300, concurrency: 2, scanBudgetMs: 90_000, syncEveryS: 900, sessionScanDelayMs: 2_000, sessionScanGapMs: 30_000 };

export interface SessionSource {
  list(filter?: { workspaceId?: string }): ChatSession[];
  onEvent(cb: (sessionId: string, msg: ChatServerMessage) => void): () => void;
}

export interface ReposDeps {
  store: Store;
  host: RepoHost;
  /** Every workspace and whether it runs; `supported: false` for a target that isn't scanned (Kubernetes with delivery switched off: no session host). */
  workspaces: () => Promise<{ id: string; name: string; running: boolean; supported?: boolean }[]>;
  sessions: SessionSource;
  /** Text from a workspace with the workspace's secret values and credential shapes taken out. */
  scrub: (workspaceId: string, text: string) => string;
  /** Tells open pages something about repositories changed. */
  notify: () => void;
  config?: Partial<ReposConfig>;
  now?: () => number;
  random?: () => number;
  log?: (message: string) => void;
}

interface ScanOptions {
  /** Who asked (`ui`, `portal-mcp:<id>`, `portal:timer`, `portal:session`...). */
  actor: string;
  /** A Portal MCP token's label as it is now, kept on the events this look records. */
  actorLabel?: string;
  /** Looks again at this repository only; `deep` also what is inside it and its worktrees. */
  scope?: { path: string; deep: boolean } | null;
  /** The events this look finds are the doing of `actor` (a sync it just made), not something to attribute. */
  claim?: boolean;
  /** Also follow the worktrees that opted in to "keep synced". */
  syncPass?: boolean;
}

const TICK_MS = 15_000;
const BATCH = 8;
const EXTRA_READS = 100;
const MAX_EVENTS_PER_SCAN = 400;
const SYNCS_PER_SCAN = 3;
/** How long a request that scans waits for the scan before it answers with what there is (the scan carries on). */
const REQUEST_WAIT_MS = 20_000;

/** A scan that failed as a whole, with the sentence to show. */
class ScanProblem extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

class Slots {
  #n = 0;
  readonly #waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#n >= this.max) await new Promise<void>((r) => this.#waiting.push(r));
    this.#n++;
    try {
      return await fn();
    } finally {
      this.#n--;
      this.#waiting.shift()?.();
    }
  }
}

/** A scan folder as the host takes it: `~`, `~/work`, or an absolute path; null for something that can't be one. */
export function normalizeRoot(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let r = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!r || r.length > 300 || /[\u0000-\u001f\u007f]/.test(r)) return null;
  r = r.replace(/\/+$/, '') || '/';
  if (r === '~' || r === '.' || r === './') return '~';
  if (r.startsWith('./')) r = r.slice(2);
  if (!r.startsWith('/') && !r.startsWith('~/')) r = `~/${r}`;
  const body = r.startsWith('~/') ? r.slice(2) : r.slice(1);
  if (body.split('/').some((s) => s === '..' || s === '.' || s === '')) return null;
  return r;
}

export class ReposService {
  readonly #deps: ReposDeps;
  readonly #cfg: ReposConfig;
  readonly #db: RepoStore;
  readonly #worktrees: Worktrees;
  readonly #slots: Slots;
  readonly #scanning = new Map<string, { run: Promise<void>; key: string }>();
  /** When each workspace's folders were last walked, and which walks were cut short (those repeat less often). */
  readonly #walkedAt = new Map<string, number>();
  readonly #walkSlow = new Set<string>();
  /** Repositories whose last read timed out: left alone for a while, longer each time. */
  readonly #slow = new Map<string, { n: number; until: number }>();
  readonly #busy = new Set<string>();
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly #seen = new Set<string>();
  readonly #nextAt = new Map<string, number>();
  readonly #fails = new Map<string, number>();
  readonly #sessionState = new Map<string, string>();
  readonly #sessionTimers = new Map<string, NodeJS.Timeout>();
  readonly #lastSessionScan = new Map<string, number>();
  #timer: NodeJS.Timeout | undefined;
  /** Scans the timer started and has not seen end yet (see `timerScansDone`). */
  readonly #timerScans = new Set<Promise<void>>();
  #unsubscribe: (() => void) | undefined;
  #lastPurge = 0;
  #closed = false;

  constructor(deps: ReposDeps) {
    this.#deps = deps;
    this.#cfg = { ...DEFAULT_REPOS_CONFIG, ...deps.config };
    this.#db = new RepoStore(deps.store);
    this.#worktrees = new Worktrees((ws, args) => deps.host.run(ws, args));
    this.#slots = new Slots(Math.max(1, this.#cfg.concurrency));
  }

  get db(): RepoStore {
    return this.#db;
  }

  #now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now();
  }
  #iso(ms = this.#now()): string {
    return new Date(ms).toISOString();
  }
  #rand(): number {
    return this.#deps.random ? this.#deps.random() : Math.random();
  }
  #log(message: string): void {
    this.#deps.log?.(`[repos] ${message}`);
  }
  #clean(workspaceId: string, text: string, max: number): string {
    return plain(this.#deps.scrub(workspaceId, text), max);
  }

  /* ---------- Lifecycle ---------- */

  start(): void {
    if (this.#timer || this.#closed) return;
    const run = loop('repos.scan', TICK_MS, 'Workspace git: scan repositories for changes').wrap(() => this.tick());
    this.#timer = setInterval(() => void run(), TICK_MS);
    this.#timer.unref?.();
    this.#unsubscribe = this.#deps.sessions.onEvent((id, msg) => this.#onSession(id, msg));
  }

  stop(): void {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe?.();
    for (const t of this.#sessionTimers.values()) clearTimeout(t);
    this.#sessionTimers.clear();
  }

  /** A workspace was removed: its repositories and settings go (its events age out with the rest). */
  forgetWorkspace(workspaceId: string): void {
    this.#db.forgetWorkspace(workspaceId);
    this.#seen.delete(workspaceId);
    this.#nextAt.delete(workspaceId);
    this.#deps.notify();
  }

  /** One round of the timer: scans on a timer, around chats and when a workspace starts (PRD §8), budgeted, jittered, only while the workspace runs. */
  async tick(): Promise<void> {
    if (this.#closed || !this.#db.writable) return;
    const now = this.#now();
    if (now - this.#lastPurge > 6 * 3_600_000) {
      this.#lastPurge = now;
      this.#db.purge(now);
    }
    if (!this.#cfg.auto) return;
    let list: Awaited<ReturnType<ReposDeps['workspaces']>>;
    try {
      list = await this.#deps.workspaces();
    } catch {
      return;
    }
    const running = new Set(list.filter((w) => w.running && w.supported !== false).map((w) => w.id));
    for (const id of [...this.#seen]) {
      if (running.has(id)) continue;
      this.#seen.delete(id);
      this.#nextAt.delete(id);
    }
    for (const id of running) {
      if (this.#db.workspace(id)?.auto === false) continue;
      if (!this.#seen.has(id)) {
        // The first look follows the workspace's start (or the portal's) by a few seconds.
        this.#seen.add(id);
        this.#nextAt.set(id, now + 3_000 + this.#rand() * 10_000);
        continue;
      }
      if ((this.#nextAt.get(id) ?? 0) > now || this.#scanning.has(id)) continue;
      const started: Promise<void> = this.scanWorkspace(id, { actor: 'portal:timer', syncPass: true, wait: false })
        .then(() => this.#scanning.get(id)?.run)
        .catch(() => undefined)
        .finally(() => this.#timerScans.delete(started));
      this.#timerScans.add(started);
    }
  }

  /** Resolves when every scan a `tick` started has ended, including the part before it registers as running (a seam for tests; no behaviour of its own). */
  async timerScansDone(): Promise<void> {
    while (this.#timerScans.size) await Promise.all([...this.#timerScans]);
  }

  /** A chat's turn ended or a chat began or ended: look at the repository it is in (debounced, and not more than every 30 s per workspace). */
  #onSession(id: string, msg: ChatServerMessage): void {
    if (this.#closed) return;
    if (msg.type === 'removed') this.#sessionState.delete(id);
    if (msg.type !== 'session') return;
    const s = msg.session;
    const before = this.#sessionState.get(id);
    this.#sessionState.set(id, s.state);
    if (s.state === 'ended') this.#sessionState.delete(id);
    const began = before === undefined && s.state !== 'ended';
    const turnOver = before === 'working' && s.state !== 'working';
    const ended = before !== undefined && before !== 'ended' && s.state === 'ended';
    if (!began && !turnOver && !ended) return;
    const ws = s.workspaceId;
    if (!this.#db.workspace(ws)?.scanAt) return; // never scanned: the first full scan comes with the timer or a request
    const folder = s.worktree?.path ?? s.cwd;
    const owner = this.#deepest(this.#db.rows(ws), folder);
    if (!owner) return;
    const key = `${ws}\0${owner.path}`;
    if (this.#sessionTimers.has(key)) return;
    const wait = Math.max(this.#cfg.sessionScanDelayMs, (this.#lastSessionScan.get(ws) ?? 0) + this.#cfg.sessionScanGapMs - this.#now());
    const timer = setTimeout(() => {
      this.#sessionTimers.delete(key);
      this.#lastSessionScan.set(ws, this.#now());
      void this.#deps
        .workspaces()
        .then((list) => (list.find((w) => w.id === ws)?.running && list.find((w) => w.id === ws)?.supported !== false ? this.scanWorkspace(ws, { actor: 'portal:session', scope: { path: owner.path, deep: false } }) : undefined))
        .catch(() => undefined);
    }, wait);
    timer.unref?.();
    this.#sessionTimers.set(key, timer);
  }

  /** The deepest repository (not a not-cloned one) whose folder holds `folder`. */
  #deepest<T extends { path: string; kind: string }>(rows: T[], folder: string): T | null {
    let best: T | null = null;
    for (const r of rows) if (r.kind !== 'missing' && within(folder, r.path) && (!best || r.path.length > best.path.length)) best = r;
    return best;
  }

  /* ---------- Reads ---------- */

  settings(workspaceId: string): RepoSettings {
    const row = this.#db.workspace(workspaceId);
    return { roots: row?.roots ?? null, defaultRoots: this.#cfg.roots, auto: row?.auto ?? this.#cfg.auto };
  }

  /** A workspace's repositories as a tree, from what the last scan kept (nothing is read from the workspace). */
  async workspace(workspaceId: string): Promise<WorkspaceRepos> {
    const list = await this.#deps.workspaces().catch(() => []);
    const mine = list.find((w) => w.id === workspaceId);
    const running = !!mine?.running && mine.supported !== false;
    const rows = this.#db.rows(workspaceId);
    const nodes = this.#nodes(workspaceId, rows);
    const info = this.#db.workspace(workspaceId);
    const settings = this.settings(workspaceId);
    return {
      workspaceId,
      running,
      scan: this.#scanInfo(workspaceId, info, running && settings.auto, running),
      settings,
      summary: summarize(rows),
      repos: nodes,
    };
  }

  #scanInfo(workspaceId: string, info: ReturnType<RepoStore['workspace']>, auto: boolean, running: boolean): RepoScanInfo {
    const next = this.#nextAt.get(workspaceId);
    return {
      at: info?.scanAt ?? null,
      ms: info?.scanMs ?? null,
      // a workspace that was stopped on purpose isn't "failing"
      error: running ? (info?.scanError ?? null) : null,
      truncated: info?.scanTruncated ?? false,
      running: this.#scanning.has(workspaceId),
      nextAt: auto && next ? this.#iso(next) : null,
    };
  }

  /** Rows as nodes, in tree order, with the chats that run in each. */
  #nodes(workspaceId: string, rows: StoredRepo[]): RepoNode[] {
    const ordered = orderNodes(rows);
    const sessions = this.#sessionsByRepo(workspaceId, rows);
    return ordered.map(({ node, depth }) => this.#node(node, depth, sessions.get(node.id) ?? []));
  }

  #node(r: StoredRepo, depth: number, sessions: RepoSession[]): RepoNode {
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      path: r.path,
      name: r.name,
      kind: r.kind,
      parentId: r.parentId,
      depth,
      mainId: r.mainId,
      state: r.state,
      error: r.error,
      worktree: r.worktree,
      submodule: r.submodule,
      drifted: r.drifted,
      sessions,
      sync: r.kind === 'worktree' ? r.sync : null,
      attention: attentionOf(r),
      firstSeenAt: r.firstSeenAt,
      scannedAt: r.scannedAt,
    };
  }

  /** The chats that are running or waiting in each repository (the deepest one holding their folder), live ones first, at most three. */
  #sessionsByRepo(workspaceId: string, rows: StoredRepo[]): Map<string, RepoSession[]> {
    const out = new Map<string, RepoSession[]>();
    let list: ChatSession[] = [];
    try {
      list = this.#deps.sessions.list({ workspaceId }).filter((s) => s.workspaceId === workspaceId && s.state !== 'ended' && !s.archivedAt);
    } catch {
      return out;
    }
    for (const s of list) {
      const owner = this.#deepest(rows, s.worktree?.path ?? s.cwd);
      if (!owner) continue;
      const mine = out.get(owner.id) ?? [];
      mine.push({ id: s.id, title: plain(s.title, 80), state: s.state, live: s.process === 'live' });
      out.set(owner.id, mine);
    }
    for (const [id, mine] of out) out.set(id, mine.sort((a, b) => Number(b.live) - Number(a.live)).slice(0, 3));
    return out;
  }

  /** Every workspace's summary, and the repositories that need a look first. */
  async overview(): Promise<ReposOverview> {
    const list = (await this.#deps.workspaces().catch(() => [])).filter((w) => w.supported !== false);
    const names = new Map(list.map((w) => [w.id, w]));
    const byWorkspace = new Map<string, StoredRepo[]>();
    for (const r of this.#db.rows()) {
      if (!names.has(r.workspaceId)) continue;
      (byWorkspace.get(r.workspaceId) ?? byWorkspace.set(r.workspaceId, []).get(r.workspaceId)!).push(r);
    }
    const workspaces = list
      .filter((w) => byWorkspace.has(w.id) || this.#db.workspace(w.id)?.scanAt)
      .map((w) => ({ workspaceId: w.id, name: w.name, running: w.running, scannedAt: this.#db.workspace(w.id)?.scanAt ?? null, summary: summarize(byWorkspace.get(w.id) ?? []) }));
    const worst: RepoNode[] = [];
    for (const [id, rows] of byWorkspace) {
      const nodes = this.#nodes(id, rows);
      worst.push(...nodes.filter((n) => n.attention.reasons.length > 0));
    }
    worst.sort((a, b) => b.attention.score - a.attention.score || (a.path < b.path ? -1 : 1));
    return { total: addSummaries(workspaces.map((w) => w.summary)), workspaces, attention: worst.slice(0, 30) };
  }

  detail(id: string): RepoDetail {
    const row = this.#row(id);
    const rows = this.#db.rows(row.workspaceId);
    const nodes = this.#nodes(row.workspaceId, rows);
    const repo = nodes.find((n) => n.id === id)!;
    return { repo, children: nodes.filter((n) => n.parentId === id), events: this.#db.events({ repoId: id, limit: 20 }).events };
  }

  events(q: RepoEventQuery): RepoEventPage {
    return this.#db.events(q);
  }

  #row(id: string): StoredRepo {
    const row = this.#db.row(id);
    if (!row) throw new AppError('NOT_FOUND', 'No such repository.');
    return row;
  }

  /** The workspace a repository is in, for callers that must check who may touch it. */
  workspaceOf(id: string): string {
    return this.#row(id).workspaceId;
  }

  /* ---------- Settings ---------- */

  updateSettings(workspaceId: string, req: UpdateRepoSettingsRequest, actor: string): RepoSettings {
    const patch: { roots?: string[] | null; auto?: boolean } = {};
    if (req.roots !== undefined) {
      if (req.roots === null) patch.roots = null;
      else {
        if (!Array.isArray(req.roots) || req.roots.length > REPO_ROOTS_MAX) throw new AppError('VALIDATION_FAILED', `Give at most ${REPO_ROOTS_MAX} folders.`, { details: { roots: `At most ${REPO_ROOTS_MAX}.` } });
        const roots = req.roots.map(normalizeRoot);
        if (roots.some((r) => r === null)) throw new AppError('VALIDATION_FAILED', 'A folder isn’t valid: use a path inside the home folder, without “..”.', { details: { roots: 'Not a folder path.' } });
        patch.roots = [...new Set(roots as string[])];
      }
    }
    if (req.auto !== undefined) {
      if (typeof req.auto !== 'boolean') throw new AppError('VALIDATION_FAILED', 'Turn automatic scans on or off.', { details: { auto: 'Expected true or false.' } });
      patch.auto = req.auto;
    }
    this.#db.saveSettings(workspaceId, this.#iso(), patch);
    const after = this.settings(workspaceId);
    if (patch.roots !== undefined) this.#record(workspaceId, null, 'settings', actor, { roots: after.roots });
    if (patch.auto !== undefined) this.#record(workspaceId, null, 'settings', actor, { auto: after.auto });
    this.#deps.notify();
    return after;
  }

  /* ---------- Scanning ---------- */

  /**
   * Looks at the workspace's repositories now (or at one repository and what hangs off it) and keeps what it sees. A scan already
   * running is joined, not repeated. Waits for the scan up to a short while, then answers with what is kept: the page learns the rest
   * from the `repos` live topic. The workspace must be running.
   */
  async scanWorkspace(workspaceId: string, o: ScanOptions & { wait?: boolean }): Promise<WorkspaceRepos> {
    await this.#requireRunning(workspaceId);
    if (!this.#db.writable) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s store is read-only, so nothing can be scanned.', { expose: true });
    // A scan of everything covers a scan of one repository, and a scan of the same thing is the same scan; anything else waits its turn.
    const key = o.scope ? `${o.scope.deep ? 'deep' : 'one'}:${o.scope.path}` : '*';
    const current = this.#scanning.get(workspaceId);
    let run: Promise<void>;
    if (current && (current.key === '*' || current.key === key)) run = current.run;
    else {
      const entry = { key, run: Promise.resolve() };
      entry.run = this.#slots
        .run(() => this.#exclusive(workspaceId, () => this.#scan(workspaceId, o)))
        .catch((e: unknown) => this.#scanFailed(workspaceId, e, o))
        .finally(() => {
          if (this.#scanning.get(workspaceId) === entry) this.#scanning.delete(workspaceId);
          const fails = this.#fails.get(workspaceId) ?? 0;
          this.#nextAt.set(workspaceId, this.#now() + this.#cfg.intervalS * 1000 * Math.min(8, 2 ** fails) * (0.8 + 0.4 * this.#rand()));
        });
      this.#scanning.set(workspaceId, entry);
      run = entry.run;
    }
    if (o.wait === false) return this.workspace(workspaceId);
    await Promise.race([run, sleep(REQUEST_WAIT_MS)]);
    return this.workspace(workspaceId);
  }

  /** A request to scan: the person's (or an agent's) action is in the audit, then the scan. */
  async requestScan(workspaceId: string, actor: string, repoId?: string): Promise<WorkspaceRepos> {
    let scope: ScanOptions['scope'] = null;
    if (repoId) {
      const row = this.#row(repoId);
      if (row.workspaceId !== workspaceId) throw new AppError('NOT_FOUND', 'No such repository.');
      scope = { path: row.path, deep: true };
    }
    this.#record(workspaceId, repoId ? this.#db.row(repoId) : null, 'scan_requested', actor, { repoId: repoId ?? null });
    return this.scanWorkspace(workspaceId, { actor, scope });
  }

  /** What was found nothing of: the scan as a whole couldn't run. Said once while it keeps failing. */
  #scanFailed(workspaceId: string, e: unknown, o: ScanOptions): void {
    const message = e instanceof ScanProblem ? e.message : 'The workspace couldn’t be scanned.';
    if (!(e instanceof ScanProblem)) this.#log(`scan of ${workspaceId} failed: ${(e as Error)?.message ?? e}`);
    this.#fails.set(workspaceId, (this.#fails.get(workspaceId) ?? 0) + 1);
    if (o.scope) return;
    const before = this.#db.workspace(workspaceId);
    this.#db.saveScan(workspaceId, this.#iso(), { ms: 0, error: message, truncated: before?.scanTruncated ?? false });
    if (before?.scanError !== message) this.#record(workspaceId, null, 'scan_failed', 'portal:scan', { error: message });
    this.#deps.notify();
  }

  async #scan(ws: string, o: ScanOptions): Promise<void> {
    const t0 = this.#now();
    const cfg = this.#cfg;
    const scope = o.scope ?? null;
    const info = this.#db.workspace(ws);
    const initial = !info?.scanAt && !scope;
    const allRows = this.#db.rows(ws);
    const scopeId = scope ? repoId(ws, scope.path) : null;
    const inScope = (r: StoredRepo) => !scope || r.path === scope.path || (scope.deep && (within(r.path, scope.path) || (r.kind === 'worktree' && r.mainId === scopeId)));
    const prevRows = allRows.filter(inScope);
    const prevByPath = new Map(allRows.map((r) => [r.path, r]));
    try {
      await this.#deps.host.ensure(ws);
    } catch (e) {
      throw new ScanProblem(this.#clean(ws, (e as Error)?.message ?? 'The workspace can’t be reached.', 200) || 'The workspace can’t be reached.');
    }

    // 1. Where repositories are: a bounded walk of the folders (nothing is followed through a link). The timer walks every third
    // interval (twice as seldom when the last walk hit a limit): repositories already known are read every time anyway, and a walk
    // only finds new ones. A request, a start and the first scan after the portal's own start always walk.
    const routine = o.actor === 'portal:timer' || o.actor === 'portal:session';
    const walkEveryMs = cfg.intervalS * 3000 * (this.#walkSlow.has(ws) ? 2 : 1);
    const walk = scope ? scope.deep : !routine || this.#now() - (this.#walkedAt.get(ws) ?? 0) >= walkEveryMs;
    const found = new Map<string, FoundRepo>();
    let truncated = !scope && !walk ? (info?.scanTruncated ?? false) : false;
    const problems: string[] = [];
    const roots = !walk ? [] : scope ? [scope.path] : (this.settings(ws).roots ?? this.#cfg.roots);
    for (const root of roots) {
      if (found.size >= cfg.maxRepos) {
        truncated = true;
        break;
      }
      const r = await this.#host(ws, ['repo-find', root, String(cfg.depth), String(cfg.maxRepos)]);
      if (r.code === 2) {
        if (!scope) problems.push(`“${plain(root, 60)}” isn’t a folder here.`);
        continue;
      }
      if (r.code !== 0) throw new ScanProblem('The workspace didn’t answer in time.');
      const f = parseFind(r.out);
      if (f.truncated || f.timedOut) truncated = true;
      for (const x of f.repos) {
        if (found.size >= cfg.maxRepos) {
          truncated = true;
          break;
        }
        found.set(x.path, x);
      }
    }

    if (!scope && walk) {
      this.#walkedAt.set(ws, t0);
      if (truncated) this.#walkSlow.add(ws);
      else this.#walkSlow.delete(ws);
    }

    // 2. What each one looks like. Repositories already known are always read again (that is how a removal is told from a limit
    // that stopped the walk), the ones read longest ago first; what they point at (superproject, main repository, worktrees,
    // submodules) is read too.
    const queue: string[] = [];
    const queued = new Set<string>();
    const enqueue = (p: string) => {
      if (queued.has(p)) return;
      if (queued.size >= cfg.maxRepos + EXTRA_READS) {
        truncated = true;
        return;
      }
      queued.add(p);
      queue.push(p);
    };
    // One whose last read timed out is left alone for a while (longer each time) unless somebody asked.
    const resting = (p: string) => {
      const slow = routine ? this.#slow.get(repoId(ws, p)) : undefined;
      return !!slow && slow.until > this.#now();
    };
    const first = [...new Set([...found.keys(), ...prevRows.filter((r) => r.kind !== 'missing').map((r) => r.path)])].filter((p) => !resting(p));
    first.sort((a, b) => (prevByPath.get(a)?.scannedAt ?? '').localeCompare(prevByPath.get(b)?.scannedAt ?? ''));
    if (scope && !scope.deep && !first.includes(scope.path)) first.push(scope.path);
    first.forEach(enqueue);
    const read = new Map<string, RawRepo>();
    let budgetHit = false;
    while (queue.length) {
      if (this.#now() - t0 > cfg.scanBudgetMs) {
        budgetHit = true;
        break;
      }
      const batch = queue.splice(0, BATCH);
      const args = ['repo-state'];
      for (const p of batch) args.push(p, prevByPath.get(p)?.state?.head?.sha ?? '-');
      const r = await this.#host(ws, args);
      if (r.code === null) {
        for (const p of batch) {
          read.set(p, failedRead(p, 'timeout'));
          this.#rest(ws, p, true);
        }
        continue;
      }
      if (r.code !== 0) throw new ScanProblem(r.code === 2 ? 'The workspace has an older session host: stop and start it to update.' : 'The workspace couldn’t read its repositories.');
      const got = new Map(parseState(r.out).map((x) => [x.path, x]));
      for (const p of batch) {
        const rec = got.get(p) ?? failedRead(p, 'unreadable');
        read.set(p, rec);
        this.#rest(ws, p, rec.error === 'timeout');
        if (rec.error) continue;
        if (rec.superproject) enqueue(rec.superproject);
        if (rec.gitDir !== rec.commonDir) enqueue(mainFolder(rec.commonDir));
        for (const w of rec.worktrees) if (!w.prunable && w.path !== rec.path) enqueue(w.path);
        for (const g of rec.gitlinks) enqueue(`${rec.path === '/' ? '' : rec.path}/${g.path}`);
      }
    }
    if (queue.length) truncated = true;

    // 3. The tree, what changed, and what to keep.
    const records = [...read.values()];
    const clean = (text: string, max: number) => this.#clean(ws, text, max);
    const nodes = buildNodes(ws, records, new Map(allRows.map((r) => [r.path, { kind: r.kind, parentId: r.parentId, mainId: r.mainId, name: r.name }])), clean);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const gone = new Set<string>();
    for (const p of prevRows) {
      if (nodeIds.has(p.id)) continue;
      if (p.kind === 'missing') {
        const parent = allRows.find((x) => x.id === p.parentId);
        const rec = parent ? read.get(parent.path) : undefined;
        if (rec && !rec.error) gone.add(p.id);
      } else {
        const rec = read.get(p.path);
        if (rec && (rec.error === 'notrepo' || rec.error === 'refused')) gone.add(p.id);
      }
    }
    const logs = new Map(records.flatMap((r) => (r.log ? [[r.path, r.log] as const] : [])));
    // Everything read is compared with what was kept of it, in scope or not (a scan of one repository also reads what it points at).
    const diff = diffScan({ previous: allRows, next: nodes, logs, confirmedGone: gone, initial });

    const at = this.#iso();
    const sessions = this.#safeSessions(ws);
    const pathById = new Map([...allRows, ...nodes].map((n) => [n.id, n.path]));
    const owners = this.#owners([...allRows.filter((r) => !nodeIds.has(r.id)), ...nodes], sessions);
    const sinceOf = (id: string | null): number => {
      const looked = id ? allRows.find((r) => r.id === id)?.scannedAt : undefined;
      return Date.parse(looked ?? info?.scanAt ?? '') || 0;
    };
    const events: NewEvent[] = diff.events.slice(0, MAX_EVENTS_PER_SCAN).map((d) => this.#attribute(ws, d, o, at, pathById, owners, sinceOf));
    const problem = problems.length ? problems.join(' ') : null;
    const scanChanged = !scope && (info?.scanError !== problem || (info?.scanTruncated ?? false) !== (truncated || budgetHit));
    const changed = events.length > 0 || diff.gone.length > 0 || scanChanged || nodes.some((n) => !sameNode(n, prevByPath.get(n.path)));
    this.#db.save(nodes, at);
    this.#db.markRemoved(diff.gone, at);
    this.#db.addEvents(events);
    if (!scope) {
      this.#db.saveScan(ws, at, { ms: this.#now() - t0, error: problem, truncated: truncated || budgetHit });
    }
    this.#fails.delete(ws);
    // Open pages hear of a scan someone asked for, and of any scan that found something; a quiet round of the timer says nothing.
    if (changed || !routine) this.#deps.notify();

    // 4. The worktrees that opted in to "keep synced", at their pace.
    if (o.syncPass && !scope) await this.#syncPass(ws);
  }

  /** One scan of a workspace at a time, so two never read and keep the same repository at once. */
  #exclusive<T>(ws: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.#tails.get(ws) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.#tails.set(ws, next);
    void next.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.#tails.get(ws) === next) this.#tails.delete(ws);
    });
    return next;
  }

  /** A repository that timed out rests for 2^n intervals (at most an hour); one that was read in time is back in the round. */
  #rest(ws: string, path: string, timedOut: boolean): void {
    const id = repoId(ws, path);
    if (!timedOut) {
      this.#slow.delete(id);
      return;
    }
    const n = Math.min(6, (this.#slow.get(id)?.n ?? 0) + 1);
    this.#slow.set(id, { n, until: this.#now() + Math.min(3_600_000, 2 ** n * this.#cfg.intervalS * 1000) });
  }

  /** Runs one host command; a connection that fails reads as the workspace not answering. */
  async #host(ws: string, args: string[]): Promise<{ code: number | null; out: string }> {
    try {
      return await this.#deps.host.run(ws, args);
    } catch {
      throw new ScanProblem('The workspace isn’t reachable.');
    }
  }

  #safeSessions(ws: string): ChatSession[] {
    try {
      return this.#deps.sessions.list({ workspaceId: ws }).filter((s) => s.workspaceId === ws && !s.archivedAt);
    } catch {
      return [];
    }
  }

  /** The chats that could have been at work in each repository, for naming who a change was while it happened. */
  #owners(rows: { id: string; path: string; kind: string }[], sessions: ChatSession[]): Map<string, ChatSession[]> {
    const out = new Map<string, ChatSession[]>();
    for (const s of sessions) {
      const owner = this.#deepest(rows, s.worktree?.path ?? s.cwd);
      if (owner) (out.get(owner.id) ?? out.set(owner.id, []).get(owner.id)!).push(s);
    }
    return out;
  }

  /**
   * Who a change was the doing of. A request the portal made says so itself. What a scan notices is put down to the one chat that
   * was at work in that repository since it was last looked at, if there was exactly one; several, or none, and it is the workspace's
   * own (a terminal, a person, a tool): attributed, never proven (PRD §8, FR14).
   */
  #attribute(ws: string, d: EventDraft, o: ScanOptions, at: string, pathById: ReadonlyMap<string, string>, owners: ReadonlyMap<string, ChatSession[]>, sinceOf: (repoId: string | null) => number): NewEvent {
    let actor = 'workspace';
    let actorLabel: string | null = null;
    let sessionId: string | null = null;
    const data: RepoEventData = { ...d.data };
    if (o.claim) {
      actor = o.actor;
      actorLabel = o.actorLabel ? plain(o.actorLabel, 60) : null;
      const m = /^session:(.+)$/.exec(o.actor);
      sessionId = m ? m[1]! : null;
    } else if (d.attributable && d.repoId) {
      // a worktree's own chats count for the event about it
      const place = typeof d.data.path === 'string' && (d.kind === 'worktree_added' || d.kind === 'worktree_removed') ? [...pathById].find(([, p]) => p === d.data.path)?.[0] : undefined;
      // A chat could have done it if it was at work, or did something, since the repository was last looked at: a parked chat that
      // did nothing since is not to blame for what somebody did in a terminal.
      const since = sinceOf(d.repoId);
      const candidates = (owners.get(place ?? d.repoId) ?? []).filter((s) => s.state === 'working' || s.state === 'waiting' || s.state === 'starting' || Date.parse(s.lastActivityAt) >= since);
      if (candidates.length === 1) {
        actor = `session:${candidates[0]!.id}`;
        sessionId = candidates[0]!.id;
      } else if (candidates.length > 1) data.sessions = candidates.slice(0, 3).map((s) => s.id);
    }
    return { at, workspaceId: ws, repoId: d.repoId, repo: d.repo ? plain(d.repo, 120) : null, kind: d.kind, actor, actorLabel, sessionId, summary: d.summary, data };
  }

  #record(ws: string, repo: { id: string; name: string } | null, kind: RepoEventKind, actor: string, data: RepoEventData, actorLabel?: string): void {
    const m = /^session:(.+)$/.exec(actor);
    this.#db.addEvents([{ at: this.#iso(), workspaceId: ws, repoId: repo?.id ?? null, repo: repo ? plain(repo.name, 120) : null, kind, actor, actorLabel: actorLabel ? plain(actorLabel, 60) : null, sessionId: m ? m[1]! : null, summary: describe(kind, repo?.name ?? null, data), data }]);
  }

  /* ---------- Worktrees ---------- */

  /** The workspace runs and is one whose repositories are looked at (Docker and This machine). */
  #requireRunning(ws: string): Promise<void> {
    return this.#deps.workspaces().then((list) => {
      const w = list.find((x) => x.id === ws);
      if (w && w.supported === false) throw new AppError('CONFLICT', 'Repositories of Kubernetes workspaces aren’t scanned.');
      if (!w?.running) throw new AppError('CONFLICT', 'The workspace isn’t running.');
    });
  }

  /** One thing at a time per repository: a second sync or worktree request while one runs is refused, not queued. */
  async #lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.#busy.has(id)) throw new AppError('CONFLICT', 'Something is already running on this repository.');
    this.#busy.add(id);
    try {
      return await fn();
    } finally {
      this.#busy.delete(id);
    }
  }

  /** Makes a worktree of the repository (the session host's hardened `wt-add`: no hook, filter or fsmonitor of the repository runs). */
  async createWorktree(id: string, req: CreateRepoWorktreeRequest, actor: string, actorLabel?: string): Promise<CreateRepoWorktreeResult> {
    const row = this.#row(id);
    if (row.kind === 'missing') throw new AppError('CONFLICT', 'That submodule isn’t cloned.');
    const ws = row.workspaceId;
    await this.#requireRunning(ws);
    const text = (v: unknown, field: string) => {
      if (v === undefined || v === null || v === '') return undefined;
      if (typeof v !== 'string') throw new AppError('VALIDATION_FAILED', `Check the ${field}.`, { details: { [field]: 'Expected text.' } });
      return v.trim() || undefined;
    };
    const branch = text(req.branch, 'branch') ?? `wt/${randomBytes(3).toString('hex')}`;
    const base = text(req.base, 'base');
    if (req.sync !== undefined && typeof req.sync !== 'boolean') throw new AppError('VALIDATION_FAILED', 'Check the sync setting.', { details: { sync: 'Expected true or false.' } });
    return this.#lock(id, async () => {
      await this.#deps.host.ensure(ws).catch((e: unknown) => {
        throw new AppError('SERVICE_UNAVAILABLE', plain((e as Error)?.message, 200) || 'The workspace can’t be reached.', { expose: true });
      });
      const made = await this.#worktrees.add(ws, { folder: row.path, branch, base: base ?? null });
      // A branch started from a remote branch follows it, as `git worktree add` does for a name (the host was given a commit id).
      if (base) await this.#deps.host.run(ws, ['repo-track', made.path, base]).catch(() => undefined);
      const at = this.#iso();
      const wid = repoId(ws, made.path);
      const mainRow = this.#db.rows(ws).find((r) => r.path === made.repo);
      // Known before the scan reads it, so the scan doesn't announce what the portal itself just did.
      this.#db.save([{ id: wid, workspaceId: ws, path: made.path, name: basename(made.path), kind: 'worktree', parentId: mainRow?.id ?? null, mainId: repoId(ws, made.repo), state: null, error: null, worktree: { locked: false, prunable: false }, submodule: null, drifted: 0 }], at);
      if (req.sync === true) this.#db.setSync(wid, true);
      this.#record(ws, row, 'worktree_created', actor, { path: made.path, branch: made.branch, sha: made.commit, ...(req.sync === true ? { enabled: true } : {}) }, actorLabel);
      await this.#exclusive(ws, () => this.#scan(ws, { actor, ...(actorLabel ? { actorLabel } : {}), scope: { path: made.path, deep: false }, claim: true })).catch(() => undefined);
      this.#deps.notify();
      const nodes = this.#nodes(ws, this.#db.rows(ws));
      const node = nodes.find((n) => n.id === wid);
      if (!node) throw new AppError('SERVICE_UNAVAILABLE', 'The worktree was made but can’t be read yet.', { expose: true });
      return { worktree: node, branch: made.branch, commit: made.commit };
    });
  }

  /** Removes a worktree's folder. `safe` refuses (409 `WORKTREE_DIRTY`) when it has changes; `force` is for a person who was told. The branch goes only when merged. */
  async removeWorktree(id: string, mode: 'safe' | 'force', actor: string): Promise<RemoveRepoWorktreeResult> {
    const row = this.#row(id);
    if (row.kind !== 'worktree') throw new AppError('CONFLICT', 'Only a worktree can be removed here.');
    const ws = row.workspaceId;
    await this.#requireRunning(ws);
    // A chat that hasn't ended (one asleep or interrupted included) wakes up in its folder: end or archive it first.
    const inUse = this.#safeSessions(ws).find((s) => s.state !== 'ended' && within(s.worktree?.path ?? s.cwd, row.path));
    if (inUse) throw new AppError('CONFLICT', 'A chat uses it. End or archive the chat first.');
    return this.#lock(id, async () => {
      await this.#deps.host.ensure(ws).catch((e: unknown) => {
        throw new AppError('SERVICE_UNAVAILABLE', plain((e as Error)?.message, 200) || 'The workspace can’t be reached.', { expose: true });
      });
      const result = await this.#worktrees.remove(ws, row.path, mode);
      this.#db.markRemoved([id], this.#iso());
      this.#record(ws, this.#db.rows(ws).find((r) => r.id === row.parentId) ?? row, 'worktree_deleted', actor, { path: row.path, branch: row.state?.branch ?? undefined, forced: mode === 'force', branchDeleted: result.branchDeleted });
      this.#deps.notify();
      return result;
    });
  }

  /* ---------- Sync ---------- */

  setSync(id: string, enabled: boolean, actor: string): RepoNode {
    const row = this.#row(id);
    if (row.kind !== 'worktree') throw new AppError('CONFLICT', 'Only a worktree can be kept synced.');
    if (typeof enabled !== 'boolean') throw new AppError('VALIDATION_FAILED', 'Turn it on or off.', { details: { enabled: 'Expected true or false.' } });
    if (row.sync.enabled !== enabled) {
      this.#db.setSync(id, enabled);
      this.#record(row.workspaceId, row, 'sync_setting', actor, { enabled });
      this.#deps.notify();
    }
    return this.detail(id).repo;
  }

  /**
   * Brings a repository's checked-out branch up to its upstream when that takes a fetch and a fast-forward and nothing else (the
   * host's `repo-sync`). Asked for: this is the only thing here that reaches a network. Never merges, rebases, stashes or resets.
   */
  async syncNow(id: string, actor: string): Promise<RepoSyncResult> {
    const row = this.#row(id);
    if (row.kind === 'missing') throw new AppError('CONFLICT', 'That submodule isn’t cloned.');
    await this.#requireRunning(row.workspaceId);
    return this.#lock(id, () => this.#sync(row, actor, false, false));
  }

  async #sync(row: StoredRepo, actor: string, auto: boolean, held: boolean): Promise<RepoSyncResult> {
    const ws = row.workspaceId;
    await this.#deps.host.ensure(ws).catch((e: unknown) => {
      throw new AppError('SERVICE_UNAVAILABLE', plain((e as Error)?.message, 200) || 'The workspace can’t be reached.', { expose: true });
    });
    const r = await this.#deps.host.run(ws, ['repo-sync', row.path]).catch(() => ({ code: null as number | null, out: '' }));
    let parsed = r.code === 0 ? parseSync(r.out) : null;
    if (!parsed) {
      parsed = { outcome: 'failed', from: null, to: null, ahead: null, behind: null, note: r.code === 3 ? 'it isn’t a repository any more' : r.code === null ? 'the workspace didn’t answer in time' : 'no answer from the workspace' };
    }
    const note = parsed.note ? this.#clean(ws, parsed.note, 200) || null : null;
    const outcome: RepoSyncOutcome = parsed.outcome;
    const same = row.sync.outcome === outcome && row.sync.note === note;
    this.#db.recordSync(row.id, this.#iso(), outcome, note);
    // A timer's no-ops and repeated refusals aren't news; everything a person asked for is.
    if (!auto || outcome === 'updated' || (outcome === 'failed' && !same)) {
      this.#record(ws, row, 'sync', actor, { outcome, from: parsed.from ? parsed.from.slice(0, 12) : undefined, to: parsed.to ? parsed.to.slice(0, 12) : undefined, ahead: parsed.ahead ?? undefined, behind: parsed.behind ?? undefined, ...(note && outcome !== 'updated' && outcome !== 'current' ? { error: note } : {}) });
    }
    // What the sync changed is read now and put down to whoever asked, not to a chat that happened to be there.
    const reread = () => this.#scan(ws, { actor, scope: { path: row.path, deep: false }, claim: true });
    await (held ? reread() : this.#exclusive(ws, reread)).catch(() => undefined);
    this.#deps.notify();
    const node = this.#nodes(ws, this.#db.rows(ws)).find((n) => n.id === row.id) ?? this.#node(row, 0, []);
    return { outcome, from: parsed.from, to: parsed.to, ahead: parsed.ahead, behind: parsed.behind, note, repo: node };
  }

  /** The "keep synced" worktrees whose turn it is, a few per scan. Only worktrees that opted in; only fast-forwards; a person is told when one fails. */
  async #syncPass(ws: string): Promise<void> {
    let n = 0;
    for (const row of this.#db.rows(ws)) {
      if (this.#closed || n >= SYNCS_PER_SCAN) break;
      if (row.kind !== 'worktree' || !row.sync.enabled || !row.state || this.#busy.has(row.id)) continue;
      if (this.#now() - (row.sync.at ? Date.parse(row.sync.at) : 0) < this.#cfg.syncEveryS * 1000) continue;
      n++;
      await this.#lock(row.id, () => this.#sync(row, 'portal:sync', true, true)).catch(() => undefined);
    }
  }
}

function failedRead(path: string, error: RawRepo['error']): RawRepo {
  return {
    path,
    error,
    gitDir: '',
    commonDir: '',
    superproject: null,
    branch: null,
    detached: false,
    unborn: false,
    oid: null,
    upstream: null,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    untrackedDirs: [],
    head: null,
    stash: 0,
    unpushed: null,
    remotes: [],
    operation: null,
    filters: 0,
    fetchedAtMs: null,
    worktrees: [],
    modules: [],
    gitlinks: [],
    log: null,
  };
}

/** Whether a scan found a repository as it was kept (so a scan that changed nothing says nothing to open pages). */
function sameNode(n: NodeCore, was: StoredRepo | undefined): boolean {
  if (!was) return false;
  return (
    n.name === was.name &&
    n.kind === was.kind &&
    n.parentId === was.parentId &&
    n.mainId === was.mainId &&
    n.error === was.error &&
    n.drifted === was.drifted &&
    JSON.stringify(n.state) === JSON.stringify(was.state) &&
    JSON.stringify(n.worktree) === JSON.stringify(was.worktree) &&
    JSON.stringify(n.submodule) === JSON.stringify(was.submodule)
  );
}

