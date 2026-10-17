// Knowledge: the service the routes and the MCP tools both call (Knowledge PRD §7, §13, §14). It owns the
// registry of vaults (kg_vaults), opens a Vault for each, turns what a Vault knows into the views the UI and
// the tools return, and enforces what is not mechanics: who may change what (the vault's agent policy,
// FR24), the secret scan on agent writes (FR27), the caps on agent writes, the audit of refusals, and the
// context edges of what agents read and write (FR29).

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentPolicy,
  CreateVaultRequest,
  DailyAppendRequest,
  GraphQuery,
  GraphResponse,
  KnowledgeSource,
  NoteAuthor,
  NoteBacklink,
  NoteHistory,
  NoteHistoryEntry,
  NoteLink,
  NoteMention,
  NoteQuickHit,
  NoteSearchHit,
  NoteSearchResult,
  NoteVersion,
  NoteView,
  RenameNoteResult,
  UpdateVaultRequest,
  VaultActivityEntry,
  VaultDaily,
  VaultHealth,
  VaultSettings,
  VaultSummary,
  VaultTagCount,
  VaultTree,
  VaultTreeEntry,
  WriteNoteResult,
} from '@portal/contracts';
import { AGENT_POLICIES, GRAPH_LENSES, WORKSPACE_KEY } from '@portal/contracts';
import type { Store } from '../store/store.js';
import { isDate, serverTimezone, timeIn, todayIn, validTimezone } from './daily.js';
import { Directory } from './directory.js';
import { isKnowledgeError, KnowledgeError } from './errors.js';
import { agenticGraph, contextGraph, docsGraph, parseSince, ticketKey, type Mention } from './graph.js';
import { parseQuery, type VaultIndex } from './indexdb.js';
import { Journal, parseActor, type Actor, type VersionRow } from './journal.js';
import { knowledgeLimits, type KnowledgeLimits } from './limits.js';
import { normHeading, sectionOf } from './markdown.js';
import { cleanPath, folderOf } from './paths.js';
import { makeSnippet } from './snippet.js';
import { Vault } from './vault.js';
import { zipChunks } from './zip.js';

export const UI_ACTOR: Actor = parseActor('ui');

export interface KnowledgeRoot {
  path: string;
  writable: boolean;
}

export interface KnowledgeOptions {
  /** `<data dir>/knowledge`. */
  dir: string;
  /** Where daily vault zips go (`<data dir>/backups`). */
  backupsDir?: string;
  limits?: KnowledgeLimits;
  now?: () => Date;
  /** The folders an operator allowed as sources (`PORTAL_KNOWLEDGE_ROOTS`). */
  roots?: Record<string, KnowledgeRoot>;
  log?: (message: string) => void;
}

/** What a caller may see: an MCP token can be limited to some vaults. Null or missing: all. */
export interface CallerScope {
  vaults?: string[] | null;
}

interface VaultRow {
  id: string;
  name: string;
  kind: 'vault' | 'folder';
  root: string;
  read_only: number;
  agents: AgentPolicy;
  daily_folder: string;
  timezone: string;
  settings: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const DEFAULT_SETTINGS: VaultSettings = { attachmentsFolder: '', rewriteLinksOnRename: true, labels: 'filename', agentWorkspaces: [] };
const DAY = 86_400_000;
/** The most a note embed returns (`![[Note]]` shows a note inside another). */
const EMBED_CHARS = 40_000;

/** Parses `PORTAL_KNOWLEDGE_ROOTS`: `name=/absolute/path` or `name=/absolute/path:rw`, comma separated. */
export function parseRoots(value: string | undefined): Record<string, KnowledgeRoot> {
  const out: Record<string, KnowledgeRoot> = {};
  for (const part of (value ?? '').split(',')) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9_-]{0,39})\s*=\s*(\/[^:]+?)(:rw)?\s*$/.exec(part);
    if (m) out[m[1]!] = { path: m[2]!, writable: m[3] === ':rw' };
  }
  return out;
}

export class KnowledgeService {
  readonly limits: KnowledgeLimits;
  readonly journal: Journal;
  /** Read-only view of the portal's sessions, tickets, Claudes and pools, for the graphs. */
  readonly directory: Directory;
  readonly #opts: KnowledgeOptions;
  readonly #vaults = new Map<string, Vault>();
  readonly #now: () => Date;
  readonly #log: (m: string) => void;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #tables = false;

  constructor(
    private readonly store: Store,
    opts: KnowledgeOptions,
  ) {
    this.#opts = opts;
    this.limits = opts.limits ?? knowledgeLimits();
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? (() => {});
    this.journal = new Journal(store, this.limits, this.#now);
    this.directory = new Directory(() => this.store.db);
  }

  /** The folders, made when first needed: a portal that can't write its data directory still starts and explains itself. */
  #dirs(): void {
    for (const d of ['vaults', 'index', 'trash']) mkdirSync(join(this.#opts.dir, d), { recursive: true, mode: 0o700 });
  }

  /** The database holds the knowledge tables (it may not: a migration failed, or it is from a newer portal). */
  #ready(): boolean {
    const db = this.store.db;
    if (!db) return false;
    if (this.#tables) return true;
    try {
      this.#tables = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kg_vaults'").get();
    } catch {
      this.#tables = false;
    }
    return this.#tables;
  }

  /**
   * Opens every vault in the background (one scan at a time) and starts the daily upkeep. Only on a database
   * that can be trusted with changes (writable, tables present, delivery allowed): a frozen or locked portal
   * starts and explains itself, and nothing here may take it down (QA-011).
   */
  start(): void {
    try {
      if (!this.store.writable || !this.store.deliveryAllowed || !this.#ready()) return;
      void this.#scanAll().catch((e: unknown) => this.#log(`[knowledge] start-up scan failed: ${(e as Error).message}`));
      const upkeep = () => void this.maintain().catch((e: unknown) => this.#log(`[knowledge] upkeep failed: ${(e as Error).message}`));
      const first = setTimeout(upkeep, 30_000);
      first.unref();
      this.#timer = setInterval(upkeep, 6 * 60 * 60_000);
      this.#timer.unref();
    } catch (e) {
      this.#log(`[knowledge] not started: ${(e as Error).message}`);
    }
  }

  async #scanAll(): Promise<void> {
    for (const row of this.#rows()) {
      if (this.#stopped) return;
      try {
        await this.#open(row).scan();
      } catch (e) {
        this.#log(`[knowledge] ${row.name}: could not be opened: ${(e as Error).message}`);
      }
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    for (const v of this.#vaults.values()) v.close();
    this.#vaults.clear();
  }

  /* ---------- Registry ---------- */

  #rows(): VaultRow[] {
    if (!this.#ready()) return [];
    return this.store
      .db!.prepare('SELECT * FROM kg_vaults WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE')
      .all() as unknown as VaultRow[];
  }

  #row(id: string): VaultRow {
    if (!this.#ready())
      throw new KnowledgeError('UNAVAILABLE', 'The portal’s database isn’t ready for notes (it is frozen, or from a newer portal).');
    const row = this.store.db!.prepare('SELECT * FROM kg_vaults WHERE id = ? AND deleted_at IS NULL').get(id) as VaultRow | undefined;
    if (!row) throw new KnowledgeError('NOT_FOUND', 'That vault doesn’t exist.');
    return row;
  }

  sources(): KnowledgeSource[] {
    return Object.entries(this.#opts.roots ?? {}).map(([name, r]) => ({ name, writable: r.writable }));
  }

  #settings(row: VaultRow): VaultSettings {
    try {
      const raw = JSON.parse(row.settings) as Partial<VaultSettings>;
      return {
        attachmentsFolder: typeof raw.attachmentsFolder === 'string' ? raw.attachmentsFolder : DEFAULT_SETTINGS.attachmentsFolder,
        rewriteLinksOnRename:
          typeof raw.rewriteLinksOnRename === 'boolean' ? raw.rewriteLinksOnRename : DEFAULT_SETTINGS.rewriteLinksOnRename,
        labels: raw.labels === 'heading' ? 'heading' : 'filename',
        agentWorkspaces: Array.isArray(raw.agentWorkspaces) ? raw.agentWorkspaces.filter((w): w is string => typeof w === 'string') : [],
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  /** Where a vault's files are. A folder source resolves its root and subfolder and must stay inside the root. */
  #location(row: VaultRow): { path: string; readOnly: boolean; fileMode: number } {
    if (row.kind === 'vault') return { path: join(this.#opts.dir, 'vaults', row.root), readOnly: row.read_only === 1, fileMode: 0o600 };
    const slash = row.root.indexOf('/');
    const key = slash < 0 ? row.root : row.root.slice(0, slash);
    const sub = slash < 0 ? '' : row.root.slice(slash + 1);
    const root = this.#opts.roots?.[key];
    if (!root)
      throw new KnowledgeError('UNAVAILABLE', `The folder “${key}” isn’t one the operator allows as a source (PORTAL_KNOWLEDGE_ROOTS).`);
    let real: string;
    try {
      real = realpathSync(root.path);
    } catch {
      throw new KnowledgeError('UNAVAILABLE', `The folder for “${key}” isn’t there.`);
    }
    const target = sub ? join(real, ...cleanPath(sub, { strict: false, folder: true }).split('/')) : real;
    let realTarget: string;
    try {
      realTarget = realpathSync(target);
    } catch {
      throw new KnowledgeError('UNAVAILABLE', `The folder “${key}/${sub}” isn’t there.`);
    }
    if (realTarget !== real && !realTarget.startsWith(`${real}/`))
      throw new KnowledgeError('INVALID_PATH', 'That folder is outside the allowed folder.');
    return { path: realTarget, readOnly: row.read_only === 1 || !root.writable, fileMode: 0o644 };
  }

  #open(row: VaultRow): Vault {
    const existing = this.#vaults.get(row.id);
    if (existing) return existing;
    const loc = this.#location(row);
    if (row.kind === 'vault') this.#dirs();
    const vault = new Vault({
      id: row.id,
      root: loc.path,
      readOnly: loc.readOnly,
      indexFile: join(this.#opts.dir, 'index', `${row.id}.db`),
      journal: this.journal,
      limits: this.limits,
      now: this.#now,
      fileMode: loc.fileMode,
      log: this.#log,
    });
    this.#vaults.set(row.id, vault);
    return vault;
  }

  /** T-436: called after a vault's list of agent workspaces changes, so the live agent tokens are rebound (index.ts wires it). */
  onAgentWorkspacesChange?: () => void;
  /** T-436 S2: called when that rebind throws: shut every live agent token out of the vaults (none, never all) until a rebind works. */
  onAgentWorkspacesFailClosed?: () => void;

  /** T-436: the ids of the vaults whose agent workspaces list names this workspace: what a session token of that workspace is bound to. Empty when none does. */
  vaultsForWorkspace(workspaceId: string): string[] {
    return this.#rows()
      .filter((r) => (this.#settings(r).agentWorkspaces ?? []).includes(workspaceId))
      .map((r) => r.id);
  }

  /** A vault by id or exact name, among those the caller may see. */
  resolve(ref: string | undefined | null, scope?: CallerScope | null): VaultRow {
    if (!this.#ready())
      throw new KnowledgeError('UNAVAILABLE', 'The portal’s database isn’t ready for notes (it is frozen, or from a newer portal).');
    const rows = this.#rows().filter((r) => !scope?.vaults || scope.vaults.includes(r.id));
    const text = (ref ?? '').trim();
    if (!text) {
      if (rows.length === 1) return rows[0]!;
      throw new KnowledgeError(
        'INVALID_INPUT',
        rows.length ? `Name the vault: ${rows.map((r) => r.name).join(', ')}.` : 'There are no vaults yet.',
      );
    }
    const byId = rows.find((r) => r.id === text);
    if (byId) return byId;
    const named = rows.filter((r) => r.name.toLowerCase() === text.toLowerCase());
    if (named.length === 1) return named[0]!;
    throw new KnowledgeError('NOT_FOUND', 'That vault doesn’t exist.');
  }

  vault(id: string): Vault {
    return this.#open(this.#row(id));
  }

  list(scope?: CallerScope | null): VaultSummary[] {
    return this.#rows()
      .filter((r) => !scope?.vaults || scope.vaults.includes(r.id))
      .map((r) => this.#summary(r));
  }

  summary(id: string): VaultSummary {
    return this.#summary(this.#row(id));
  }

  #summary(row: VaultRow): VaultSummary {
    const settings = this.#settings(row);
    let counts = { notes: 0, files: 0, folders: 0, tags: 0, unresolved: 0, bytes: 0 };
    let lastChangeAt: string | null = null;
    let readOnly = row.read_only === 1;
    let state: 'scanning' | 'ready' = 'ready';
    let scannedAt: string | null = null;
    let problem: string | null = null;
    let location = '';
    try {
      const vault = this.#open(row);
      const s = vault.index.stats();
      counts = { notes: s.notes, files: s.files, folders: s.folders, tags: s.tags, unresolved: s.unresolved, bytes: s.bytes };
      lastChangeAt = s.lastChangeMs ? new Date(s.lastChangeMs).toISOString() : null;
      readOnly = vault.readOnly;
      state = vault.scanning || vault.lastScanAt === 0 ? 'scanning' : 'ready';
      scannedAt = vault.lastScanAt ? new Date(vault.lastScanAt).toISOString() : null;
      location = vault.root;
    } catch (e) {
      problem = isKnowledgeError(e) ? e.message : (e as Error).message;
      readOnly = true;
    }
    const slash = row.root.indexOf('/');
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      readOnly,
      agents: row.agents,
      dailyFolder: row.daily_folder,
      timezone: row.timezone,
      settings,
      counts,
      lastChangeAt,
      agentWrites7d: this.#ready() ? this.journal.agentWritesSince(row.id, new Date(this.#now().getTime() - 7 * DAY)) : 0,
      indexState: state,
      problem,
      scannedAt,
      source:
        row.kind === 'folder'
          ? { root: slash < 0 ? row.root : row.root.slice(0, slash), sub: slash < 0 ? '' : row.root.slice(slash + 1) }
          : null,
      location,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #validName(name: unknown, exceptId?: string): string {
    if (typeof name !== 'string') throw new KnowledgeError('INVALID_INPUT', 'A vault needs a name.');
    const n = name.trim().replace(/\s+/g, ' ');
    // eslint-disable-next-line no-control-regex
    if (!n || n.length > 60 || /[\u0000-\u001f\u007f]/.test(n))
      throw new KnowledgeError('INVALID_INPUT', 'A vault’s name is 1 to 60 characters, with no control characters.');
    if (this.#rows().some((r) => r.id !== exceptId && r.name.toLowerCase() === n.toLowerCase()))
      throw new KnowledgeError('EXISTS', 'Another vault has that name.');
    return n;
  }

  #validPolicy(v: unknown): AgentPolicy {
    if (typeof v !== 'string' || !(AGENT_POLICIES as readonly string[]).includes(v))
      throw new KnowledgeError('INVALID_INPUT', `Agent access is one of ${AGENT_POLICIES.join(', ')}.`);
    return v as AgentPolicy;
  }

  #validDaily(v: unknown): string {
    if (typeof v !== 'string') throw new KnowledgeError('INVALID_INPUT', 'The daily notes folder must be text.');
    return cleanPath(v.trim(), { strict: true, folder: true });
  }

  #validTz(v: unknown): string {
    if (typeof v !== 'string' || !validTimezone(v))
      throw new KnowledgeError('INVALID_INPUT', 'That isn’t a time zone name (for example Europe/Berlin).');
    return v;
  }

  create(req: Partial<CreateVaultRequest>, actor: Actor = UI_ACTOR): VaultSummary {
    const db = this.store.db;
    if (!db || !this.#ready() || !this.store.writable)
      throw new KnowledgeError('UNAVAILABLE', 'The portal’s database isn’t available for changes.');
    this.#dirs();
    const at = this.#now().toISOString();
    let kind: 'vault' | 'folder' = 'vault';
    let id = randomBytes(6).toString('hex');
    let root = id;
    let readOnly = 0;
    let name = req.name;
    let agents: AgentPolicy = req.agents ? this.#validPolicy(req.agents) : 'write-own';
    if (req.source) {
      const key = String(req.source.root ?? '');
      const allowed = this.#opts.roots?.[key];
      if (!allowed) throw new KnowledgeError('INVALID_INPUT', 'Pick one of the folders the operator allows as a source.');
      const sub = req.source.sub ? cleanPath(String(req.source.sub), { strict: false, folder: true }) : '';
      kind = 'folder';
      root = sub ? `${key}/${sub}` : key;
      readOnly = allowed.writable ? 0 : 1;
      name = name ?? (sub ? `${key}/${sub}` : key);
      agents = req.agents ? agents : 'read';
    }
    const n = this.#validName(name);
    const daily = req.dailyFolder === undefined ? 'Daily' : this.#validDaily(req.dailyFolder);
    const tz = req.timezone === undefined ? serverTimezone() : this.#validTz(req.timezone);
    const row: VaultRow = {
      id,
      name: n,
      kind,
      root,
      read_only: readOnly,
      agents,
      daily_folder: daily,
      timezone: tz,
      settings: JSON.stringify(kind === 'folder' ? { ...DEFAULT_SETTINGS, labels: 'heading' } : DEFAULT_SETTINGS),
      created_at: at,
      updated_at: at,
      deleted_at: null,
    };
    // A source must open before it is recorded: a typo shouldn't leave a vault that can never open.
    if (kind === 'folder') this.#location(row);
    db.prepare(
      'INSERT INTO kg_vaults (id, name, kind, root, read_only, agents, daily_folder, timezone, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, n, kind, root, readOnly, agents, daily, tz, row.settings, at, at);
    const vault = this.#open(row);
    void vault.scan().catch((e: unknown) => this.#log(`[knowledge] ${n}: scan failed: ${(e as Error).message}`));
    this.journal.audit({
      vaultId: id,
      actor: actor.id,
      op: 'vault.create',
      outcome: 'ok',
      detail: kind === 'folder' ? `source ${root}` : '',
    });
    return this.#summary(row);
  }

  update(id: string, req: UpdateVaultRequest, actor: Actor = UI_ACTOR): VaultSummary {
    const row = this.#row(id);
    const db = this.store.db!;
    if (!this.store.writable) throw new KnowledgeError('UNAVAILABLE', 'The portal’s database isn’t available for changes.');
    const next = { ...row };
    const changes: string[] = [];
    let rebind = false;
    let wsChange = '';
    if (req.name !== undefined) {
      next.name = this.#validName(req.name, id);
      changes.push('name');
    }
    if (req.agents !== undefined) {
      next.agents = this.#validPolicy(req.agents);
      changes.push(`agents ${row.agents} -> ${next.agents}`);
    }
    if (req.dailyFolder !== undefined) {
      next.daily_folder = this.#validDaily(req.dailyFolder);
      changes.push('daily folder');
    }
    if (req.timezone !== undefined) {
      next.timezone = this.#validTz(req.timezone);
      changes.push('time zone');
    }
    if (req.settings) {
      const cur = this.#settings(row);
      const s = req.settings;
      if (s.attachmentsFolder !== undefined)
        cur.attachmentsFolder =
          typeof s.attachmentsFolder === 'string'
            ? cleanPath(s.attachmentsFolder.trim(), { strict: true, folder: true })
            : cur.attachmentsFolder;
      if (s.rewriteLinksOnRename !== undefined) cur.rewriteLinksOnRename = s.rewriteLinksOnRename === true;
      if (s.labels !== undefined) cur.labels = s.labels === 'heading' ? 'heading' : 'filename';
      if (s.agentWorkspaces !== undefined) {
        if (!Array.isArray(s.agentWorkspaces))
          throw new KnowledgeError('INVALID_INPUT', 'Agent workspaces are a list of `<target>/<name>`.');
        const bad = [
          ...new Set(s.agentWorkspaces.map((w) => (typeof w === 'string' ? w : String(w))).filter((w) => !WORKSPACE_KEY.test(w))),
        ];
        if (bad.length)
          throw new KnowledgeError(
            'INVALID_INPUT',
            `Agent workspaces must look like \`<target>/<name>\`. Not valid: ${bad.map((w) => JSON.stringify(w.slice(0, 80))).join(', ')}.`,
          );
        const before = new Set(cur.agentWorkspaces ?? []);
        cur.agentWorkspaces = [...new Set(s.agentWorkspaces)].sort();
        const now = new Set(cur.agentWorkspaces);
        const added = [...now].filter((w) => !before.has(w));
        const removed = [...before].filter((w) => !now.has(w));
        wsChange = `workspaces${added.length ? ` +${added.join(' +')}` : ''}${removed.length ? ` -${removed.join(' -')}` : ''}${added.length || removed.length ? '' : ' unchanged'}`;
        rebind = true;
      }
      next.settings = JSON.stringify(cur);
      changes.push(wsChange ? `settings (${wsChange})` : 'settings');
    }
    next.updated_at = this.#now().toISOString();
    db.prepare('UPDATE kg_vaults SET name = ?, agents = ?, daily_folder = ?, timezone = ?, settings = ?, updated_at = ? WHERE id = ?').run(
      next.name,
      next.agents,
      next.daily_folder,
      next.timezone,
      next.settings,
      next.updated_at,
      id,
    );
    if (changes.length) this.journal.audit({ vaultId: id, actor: actor.id, op: 'vault.update', outcome: 'ok', detail: changes.join(', ') });
    let warning: string | undefined;
    if (rebind) {
      try {
        this.onAgentWorkspacesChange?.();
      } catch (e) {
        // The list is saved. A token must not keep a wider reach than it: shut live tokens out until a rebind works.
        const why = (e as Error)?.message ?? 'unknown';
        let closed = true;
        try {
          this.onAgentWorkspacesFailClosed?.();
        } catch {
          closed = false;
        }
        this.#log(
          `[knowledge] rebind of agent tokens failed after saving vault ${id}: ${why}${closed ? '; live tokens are shut out of vaults' : '; closing them failed too'}`,
        );
        this.journal.audit({
          vaultId: id,
          actor: actor.id,
          op: 'vault.rebind',
          outcome: 'error',
          detail: `${why}${closed ? ' (tokens closed)' : ' (closing failed)'}`,
        });
        warning = 'Saved, but live agent sessions could not be updated: they are shut out of the vaults until it is retried.';
      }
    }
    return warning ? { ...this.#summary(next), warning } : this.#summary(next);
  }

  /** Deletes a vault. A vault the portal made goes to `trash/` for 14 days; a folder source is only forgotten. */
  remove(id: string, confirmName: string, actor: Actor = UI_ACTOR): void {
    const row = this.#row(id);
    if (confirmName !== row.name) throw new KnowledgeError('INVALID_INPUT', 'Type the vault’s name to delete it.');
    const db = this.store.db!;
    const vault = this.#vaults.get(id);
    vault?.close();
    this.#vaults.delete(id);
    const at = this.#now();
    if (row.kind === 'vault') {
      const from = join(this.#opts.dir, 'vaults', row.root);
      if (existsSync(from)) renameSync(from, join(this.#opts.dir, 'trash', `${id}-${at.toISOString().replace(/[-:.]/g, '').slice(0, 15)}`));
    }
    for (const f of [`${id}.db`, `${id}.db-wal`, `${id}.db-shm`]) rmSync(join(this.#opts.dir, 'index', f), { force: true });
    db.prepare('UPDATE kg_vaults SET deleted_at = ?, name = ? WHERE id = ?').run(
      at.toISOString(),
      `${row.name} (deleted ${at.toISOString().slice(0, 10)} ${id})`,
      id,
    );
    this.journal.audit({ vaultId: id, actor: actor.id, op: 'vault.delete', outcome: 'ok', detail: row.kind });
  }

  /* ---------- Policy ---------- */

  #asAgent(actor: Actor): boolean {
    return actor.kind === 'agent';
  }

  /** Every call by an agent starts here: the vault must be open to agents at all. */
  #access(row: VaultRow, actor: Actor, need: 'read' | 'write'): void {
    if (!this.#asAgent(actor)) return;
    if (row.agents === 'off') throw new KnowledgeError('VAULT_UNAVAILABLE', 'This vault isn’t available to agents.');
    if (need === 'write' && row.agents === 'read')
      throw new KnowledgeError('NOT_ALLOWED_BY_POLICY', 'This vault lets agents read, not write.');
  }

  /** `write-own`: an agent may change only a note agents wrote; anything else is for a person. */
  #mayChange(row: VaultRow, vault: Vault, actor: Actor, path: string, action: 'create' | 'change' | 'daily'): void {
    if (vault.readOnly) throw new KnowledgeError('READ_ONLY', 'This vault is read-only.');
    if (!this.#asAgent(actor)) return;
    this.#access(row, actor, 'write');
    if (row.agents === 'write' || action === 'create' || action === 'daily') return;
    const a = this.journal.authorship(row.id, path);
    if (!(a.count > 0 && a.agentOnly))
      throw new KnowledgeError(
        'NOT_ALLOWED_BY_POLICY',
        'In this vault agents can change only notes that agents wrote. Create a new note instead, or ask the admin to allow edits.',
      );
  }

  #checkAgentText(actor: Actor, ...texts: (string | undefined)[]): void {
    if (!this.#asAgent(actor)) return;
    for (const t of texts) {
      if (t === undefined) continue;
      if (Buffer.byteLength(t) > this.limits.agentWriteBytes)
        throw new KnowledgeError('TOO_LARGE', `An agent can write at most ${Math.round(this.limits.agentWriteBytes / 1024)} KB at a time.`);
      if (Vault.looksSecret(t))
        throw new KnowledgeError(
          'SECRET_IN_CONTENT',
          'This text looks like it contains a secret (an API key, token or private key). Notes can’t hold secrets: remove it, or keep it in Secrets & env.',
        );
    }
  }

  /** Runs one operation, auditing what is refused; reads and ordinary successes leave no audit row (history and edges are their record). */
  #run<T>(row: VaultRow, actor: Actor, op: string, path: string | null, fn: () => T): T {
    const audit = (e: unknown) => {
      if (!isKnowledgeError(e)) return;
      const outcome =
        e.reason === 'CONFLICT' || e.reason === 'EXISTS' || e.reason === 'NOT_UNIQUE'
          ? 'conflict'
          : e.reason === 'NOT_ALLOWED_BY_POLICY' || e.reason === 'VAULT_UNAVAILABLE' || e.reason === 'READ_ONLY'
            ? 'denied'
            : 'refused';
      // A person's conflicts and typos are ordinary; an agent's refusals are what the admin wants to see.
      if (this.#asAgent(actor) || outcome === 'denied')
        this.journal.audit({ vaultId: row.id, actor: actor.id, op, path, outcome, detail: e.reason });
    };
    try {
      const r = fn();
      if (r instanceof Promise) return r.catch((e: unknown) => (audit(e), Promise.reject(e))) as T;
      return r;
    } catch (e) {
      audit(e);
      throw e;
    }
  }

  #edge(row: VaultRow, path: string, actor: Actor, kind: 'read' | 'created' | 'edited' | 'appended' | 'deleted'): void {
    if (this.#asAgent(actor) || (actor.kind === 'user' && kind !== 'read')) {
      try {
        this.journal.edge(row.id, path, actor, kind);
      } catch {
        // an edge is a note about the note; it never fails the write
      }
    }
  }

  /* ---------- Reading ---------- */

  #use(ref: string, actor: Actor, need: 'read' | 'write' = 'read', scope?: CallerScope | null): { row: VaultRow; vault: Vault } {
    const row = this.resolve(ref, scope);
    this.#access(row, actor, 'read');
    const vault = this.#open(row);
    // A read-only vault says so before a policy does: no one can write here, whatever they're allowed.
    if (need === 'write' && vault.readOnly) throw new KnowledgeError('READ_ONLY', 'This vault is read-only.');
    this.#access(row, actor, need);
    return { row, vault };
  }

  tree(ref: string, folder: string, actor: Actor = UI_ACTOR, scope?: CallerScope | null): VaultTree {
    const { row, vault } = this.#use(ref, actor, 'read', scope);
    vault.scanIfStale();
    const f = cleanPath(folder ?? '', { strict: false, folder: true });
    const { folders, files } = vault.index.listFolder(f);
    const notePaths = files.filter((x) => x.kind === 'note').map((x) => x.path);
    const agentOnly = this.journal.agentOnlyPaths(row.id, notePaths);
    const entries: VaultTreeEntry[] = [
      ...folders.map((d): VaultTreeEntry => ({ kind: 'folder', name: d.name, path: d.path, count: d.count })),
      ...files.map((x): VaultTreeEntry => ({
        kind: x.kind,
        name: x.name,
        path: x.path,
        size: x.size,
        mtime: new Date(x.mtimeMs).toISOString(),
        ...(x.kind === 'note' ? { title: x.headingTitle, agent: agentOnly.has(x.path) } : {}),
      })),
    ];
    return { folder: f, entries };
  }

  #author(vaultId: string, path: string): { author: NoteAuthor | null; agentOnly: boolean } {
    const a = this.journal.authorship(vaultId, path);
    return {
      author: a.lastActor && a.lastKind && a.lastAt ? { actor: a.lastActor, kind: a.lastKind, at: a.lastAt } : null,
      agentOnly: a.count > 0 && a.agentOnly,
    };
  }

  #view(row: VaultRow, vault: Vault, r: ReturnType<Vault['readNote']>): NoteView {
    const parsed = vault.parse(r.text);
    const file = r.file;
    const links: NoteLink[] = vault.index.outgoing(file.id).map((l) => ({
      style: l.style,
      embed: l.embed,
      target: l.target,
      heading: l.heading,
      block: l.block,
      alias: l.alias,
      entity: l.entity,
      line: l.line,
      to: l.to,
      ambiguous: l.ambiguous,
      anchorMissing: l.anchorMissing,
    }));
    const { author, agentOnly } = this.#author(row.id, r.path);
    return {
      vaultId: row.id,
      path: r.path,
      name: file.name,
      folder: file.folder,
      title: file.headingTitle,
      content: r.text.replace(/^﻿/, ''),
      version: r.version,
      size: r.size,
      mtime: new Date(r.mtimeMs).toISOString(),
      frontmatter: {
        raw: parsed.frontmatterRaw,
        props: parsed.frontmatter,
        error: parsed.frontmatterError,
        bodyOffset: parsed.bodyStart - (r.text.startsWith('\uFEFF') ? 1 : 0),
      },
      tags: vault.index.tagsOf(file.id),
      aliases: vault.index.aliasesOf(file.id),
      headings: vault.index.headingsOf(file.id),
      links,
      backlinkCount: vault.index.backlinkCount(file.id),
      author,
      agentOnly,
      secretShaped: file.secret,
      readOnly: vault.readOnly,
    };
  }

  getNote(ref: string, path: string, actor: Actor = UI_ACTOR, scope?: CallerScope | null): NoteView {
    const { row, vault } = this.#use(ref, actor, 'read', scope);
    const r = vault.readNote(path);
    this.#edge(row, r.path, actor, 'read');
    return this.#view(row, vault, r);
  }

  /** The text under a heading of a note already read (null when there is no such heading): no second read, no second edge. */
  sectionText(view: NoteView, heading: string): string | null {
    const vault = this.vault(view.vaultId);
    const parsed = vault.parse(view.content);
    const s = sectionOf(view.content, parsed, normHeading(heading.replace(/^#+\s*/, '')));
    return s ? view.content.slice(s.start, s.end) : null;
  }

  /** The text under a heading or a block of a note, for rendering `![[Note#Heading]]`. */
  embed(
    ref: string,
    path: string,
    heading: string | null,
    block: string | null,
    actor: Actor = UI_ACTOR,
    scope?: CallerScope | null,
  ): { path: string; text: string } {
    const { row, vault } = this.#use(ref, actor, 'read', scope);
    const r = vault.readNote(path);
    this.#edge(row, r.path, actor, 'read');
    const text = r.text.replace(/^﻿/, '');
    const parsed = vault.parse(r.text);
    const body = r.text.slice(parsed.bodyStart);
    let out = body;
    if (heading) {
      const s = sectionOf(r.text, parsed, normHeading(heading.split('#').pop()!));
      out = s ? r.text.slice(s.start, s.end) : '';
    } else if (block) {
      const lines = text.split('\n');
      const i = lines.findIndex((l) => new RegExp(`(?:^|\\s)\\^${block.replace(/[^A-Za-z0-9-]/g, '')}\\s*$`).test(l.replace(/\r$/, '')));
      if (i >= 0) {
        let start = i;
        while (start > 0 && lines[start - 1]!.trim() !== '') start--;
        out = lines
          .slice(start, i + 1)
          .join('\n')
          .replace(/\s*\^[A-Za-z0-9-]+\s*$/, '');
      } else out = '';
    }
    return { path: r.path, text: out.slice(0, EMBED_CHARS) };
  }

  backlinks(ref: string, path: string, actor: Actor = UI_ACTOR, scope?: CallerScope | null): NoteBacklink[] {
    const { vault } = this.#use(ref, actor, 'read', scope);
    const r = vault.readNote(path);
    return vault.index.backlinks(r.file.id);
  }

  mentions(ref: string, path: string, actor: Actor = UI_ACTOR, scope?: CallerScope | null): NoteMention[] {
    const { vault } = this.#use(ref, actor, 'read', scope);
    const r = vault.readNote(path);
    return vault.index.mentions(r.file.id, [r.file.name, ...vault.index.aliasesOf(r.file.id)]);
  }

  search(
    ref: string,
    q: string,
    o: { limit?: number; offset?: number; tag?: string; folder?: string } = {},
    actor: Actor = UI_ACTOR,
    scope?: CallerScope | null,
  ): NoteSearchResult {
    const started = performance.now();
    const { row, vault } = this.#use(ref, actor, 'read', scope);
    vault.scanIfStale();
    const text = String(q ?? '').slice(0, this.limits.queryChars);
    const cap = this.#asAgent(actor) ? this.limits.searchMcpLimit : this.limits.searchApiLimit;
    const limit = Math.max(1, Math.min(cap, Math.floor(o.limit ?? 20)));
    const parsed = parseQuery(`${text}${o.tag ? ` tag:${o.tag}` : ''}${o.folder ? ` folder:${o.folder}` : ''}`);
    const { rows, total } = vault.index.search(parsed, limit, Math.max(0, Math.floor(o.offset ?? 0)));
    const agentOnly = this.journal.agentOnlyPaths(
      row.id,
      rows.map((r) => r.path),
    );
    const words = [...parsed.words, ...parsed.phrases.flat()];
    const hits: NoteSearchHit[] = rows.map((r) => {
      let snippet: NoteSearchHit['snippet'] = null;
      try {
        const read = vault.readNote(r.path);
        const body = read.text.slice(vault.parse(read.text).bodyStart);
        snippet = makeSnippet(body, words);
      } catch {
        // gone since the index looked
      }
      const file = vault.index.get(r.path);
      return {
        path: r.path,
        name: r.name,
        title: r.headingTitle,
        folder: folderOf(r.path),
        tags: file ? vault.index.tagsOf(file.id) : [],
        snippet,
        mtime: new Date(r.mtimeMs).toISOString(),
        agent: agentOnly.has(r.path),
      };
    });
    return { hits, total, tookMs: Math.round((performance.now() - started) * 10) / 10 };
  }

  quick(ref: string, q: string, actor: Actor = UI_ACTOR, scope?: CallerScope | null): NoteQuickHit[] {
    const { vault } = this.#use(ref, actor, 'read', scope);
    vault.scanIfStale();
    return vault.index
      .quick(String(q ?? '').slice(0, this.limits.queryChars), 12, 'all')
      .map((h) => ({ path: h.path, name: h.name, kind: h.kind, alias: h.alias }));
  }

  tags(ref: string, prefix = '', actor: Actor = UI_ACTOR, scope?: CallerScope | null): VaultTagCount[] {
    const { vault } = this.#use(ref, actor, 'read', scope);
    vault.scanIfStale();
    return vault.index.tags(prefix);
  }

  health(ref: string, actor: Actor = UI_ACTOR): VaultHealth {
    const { vault } = this.#use(ref, actor, 'read');
    vault.scanIfStale();
    return vault.index.health();
  }

  recent(ref: string, limit = 20, actor: Actor = UI_ACTOR, scope?: CallerScope | null): VaultTreeEntry[] {
    const { row, vault } = this.#use(ref, actor, 'read', scope);
    vault.scanIfStale();
    const files = vault.index.recent(Math.max(1, Math.min(100, limit)));
    const agentOnly = this.journal.agentOnlyPaths(
      row.id,
      files.map((f) => f.path),
    );
    return files.map((x): VaultTreeEntry => ({
      kind: 'note',
      name: x.name,
      path: x.path,
      size: x.size,
      mtime: new Date(x.mtimeMs).toISOString(),
      title: x.headingTitle,
      agent: agentOnly.has(x.path),
    }));
  }

  /* ---------- Graphs ---------- */

  /** The vaults a graph may draw from: the one asked for, or every vault the caller may see and (for agents) that is open to them. */
  #graphVaults(ref: string | undefined, actor: Actor, scope?: CallerScope | null): VaultRow[] {
    if (ref) {
      const row = this.resolve(ref, scope);
      this.#access(row, actor, 'read');
      return [row];
    }
    return this.#rows().filter((r) => (!scope?.vaults || scope.vaults.includes(r.id)) && !(this.#asAgent(actor) && r.agents === 'off'));
  }

  /**
   * One of the three graphs (Knowledge PRD §12). Docs draws one vault's notes. Context and agentic draw across the
   * portal; the agents inside workspaces get the docs graph only (what other sessions did is for the admin).
   */
  graph(q: GraphQuery, actor: Actor = UI_ACTOR, scope?: CallerScope | null): GraphResponse {
    if (!(GRAPH_LENSES as readonly string[]).includes(q.lens)) throw new KnowledgeError('INVALID_INPUT', 'Pick docs, context or agentic.');
    if (q.lens === 'docs') {
      const { row, vault } = this.#use(q.vault ?? '', actor, 'read', scope);
      vault.scanIfStale();
      const labels = this.#settings(row).labels;
      const build = () => docsGraph({ vaultId: row.id, index: vault.index, labels, q });
      // A whole-vault graph is the costly one (a few hundred milliseconds at 10,000 notes): the same question about the same index is answered once.
      if (q.around) return build();
      const key = [labels, q.folder, q.tag, q.tags, q.unresolved, q.attachments, q.hideOrphans, q.cap]
        .map((x) => String(x ?? ''))
        .join('|');
      return this.#cached(vault.index, key, build);
    }
    if (actor.id.startsWith('session:') || actor.id.startsWith('ticket:'))
      throw new KnowledgeError('NOT_ALLOWED_BY_POLICY', 'Agents can use the docs graph.');
    const rows = this.#graphVaults(q.vault, actor, scope);
    if (q.lens === 'context') return this.#contextGraph(q, rows);
    return this.#agenticGraph(q, rows);
  }

  readonly #graphCache = new WeakMap<VaultIndex, { generation: number; entries: Map<string, GraphResponse> }>();

  #cached(index: VaultIndex, key: string, build: () => GraphResponse): GraphResponse {
    let c = this.#graphCache.get(index);
    if (!c || c.generation !== index.generation) {
      c = { generation: index.generation, entries: new Map() };
      this.#graphCache.set(index, c);
    }
    const hit = c.entries.get(key);
    if (hit) return hit;
    const value = build();
    if (c.entries.size >= 6) c.entries.delete(c.entries.keys().next().value as string);
    c.entries.set(key, value);
    return value;
  }

  #contextGraph(q: GraphQuery, rows: VaultRow[]): GraphResponse {
    const since = new Date(this.#now().getTime() - parseSince(q.since));
    const kinds =
      q.access === 'read'
        ? (['read'] as const)
        : q.access === 'write'
          ? (['created', 'edited', 'appended', 'deleted'] as const)
          : undefined;
    const touches = this.#ready()
      ? this.journal.touches(since, { vaults: rows.map((r) => r.id), kinds: kinds ? [...kinds] : undefined, limit: 20_000 })
      : [];
    const of = (kind: string) => touches.filter((t) => t.sourceKind === kind).map((t) => t.sourceId);
    const sessions = this.directory.sessionsByIds(of('session'));
    const tickets = this.directory.ticketsByIds([...of('ticket'), ...[...sessions.values()].map((s) => s.ticketId ?? '')]);
    const tokens = this.directory.tokenLabels(of('token'));
    const indexes = new Map<string, VaultIndex | null>();
    const exists = (vaultId: string, path: string): boolean => {
      let idx = indexes.get(vaultId);
      if (idx === undefined) {
        try {
          idx = this.#open(this.#row(vaultId)).index;
        } catch {
          idx = null;
        }
        indexes.set(vaultId, idx);
      }
      return idx ? !!idx.get(path) : false;
    };
    return contextGraph({ touches, sessions, tickets, tokens, exists, q });
  }

  #agenticGraph(q: GraphQuery, rows: VaultRow[]): GraphResponse {
    const since = new Date(this.#now().getTime() - parseSince(q.since, 30)).toISOString();
    const sessions = this.directory.recentSessions(400, since);
    const tickets = this.directory.recentTickets(300, since);
    const mentions: Mention[] = [];
    for (const row of rows) {
      if (mentions.length >= 20_000) break;
      try {
        for (const m of this.#open(row).index.graphEntities())
          mentions.push({ vaultId: row.id, note: m, type: m.type, key: m.key, count: m.n });
      } catch {
        // a vault that can't be opened has nothing to add
      }
    }
    // What the recent things point at, from outside the window: a ticket's session, a session's parent and ticket, what notes mention.
    const have = new Set(tickets.map((t) => t.id));
    const wantTickets = [...sessions.map((s) => s.ticketId ?? ''), ...mentions.filter((m) => m.type === 'ticket').map((m) => m.key)]
      .filter(Boolean)
      .map(ticketKey)
      .filter((id) => !have.has(id));
    for (const t of this.directory.ticketsByIds(wantTickets.slice(0, 200)).values()) tickets.push(t);
    const wantSessions = [
      ...sessions.map((s) => s.parentId ?? ''),
      ...tickets.filter((t) => t.assigneeKind === 'session').map((t) => t.assigneeRef ?? ''),
      ...mentions.filter((m) => m.type === 'session').map((m) => m.key.trim()),
    ].filter(Boolean);
    const known = this.directory.sessionsByIds(wantSessions.slice(0, 400));
    return agenticGraph({ sessions, known, tickets, claudes: this.directory.claudes(), pools: this.directory.poolUses(null), mentions, q });
  }

  /* ---------- History ---------- */

  #entry(r: VersionRow): NoteHistoryEntry {
    return {
      id: r.id,
      at: r.at,
      op: r.op,
      actor: r.actor,
      actorKind: r.actorKind,
      size: r.size,
      note: r.note,
      fromPath: r.fromPath,
      hasContent: r.hasContent,
    };
  }

  history(ref: string, path: string, actor: Actor = UI_ACTOR): NoteHistory {
    const { row } = this.#use(ref, actor, 'read');
    const rel = cleanPath(path, { strict: false });
    return { path: rel, entries: this.journal.history(row.id, rel).map((r) => this.#entry(r)) };
  }

  version(ref: string, path: string, id: number, actor: Actor = UI_ACTOR): NoteVersion {
    const { row } = this.#use(ref, actor, 'read');
    const rel = cleanPath(path, { strict: false });
    const v = this.journal.version(row.id, id);
    if (!v || v.row.path !== rel) throw new KnowledgeError('NOT_FOUND', 'That version doesn’t exist.');
    const prev = this.journal.before(row.id, id);
    return { entry: this.#entry(v.row), content: v.content, previous: prev?.content ?? null };
  }

  deleted(ref: string): { path: string; at: string }[] {
    const { vault } = this.#use(ref, UI_ACTOR, 'read');
    return vault.deletedNotes();
  }

  /* ---------- Writing ---------- */

  putNote(
    ref: string,
    path: string,
    req: { content: string; baseVersion?: string | null; create?: boolean },
    actor: Actor = UI_ACTOR,
    scope?: CallerScope | null,
  ): WriteNoteResult {
    const { row, vault } = this.#use(ref, actor, 'write', scope);
    return this.#run(row, actor, 'note.write', path, () => {
      const existing = vault.has(path);
      this.#mayChange(row, vault, actor, existing ?? path, existing ? 'change' : 'create');
      this.#checkAgentText(actor, req.content);
      const r = vault.writeNote(path, req.content, { actor, baseVersion: req.baseVersion ?? null, create: req.create });
      if (!r.unchanged) this.#edge(row, r.path, actor, r.created ? 'created' : 'edited');
      const warnings =
        !this.#asAgent(actor) && Vault.looksSecret(req.content)
          ? [
              'This note contains something that looks like a secret (a key or token). Notes aren’t encrypted; keep real secrets in Secrets & env instead.',
            ]
          : [];
      return { path: r.path, version: r.version, created: r.created, unchanged: r.unchanged, size: r.size, warnings };
    });
  }

  editNote(
    ref: string,
    path: string,
    oldText: string,
    newText: string,
    baseVersion: string,
    actor: Actor = UI_ACTOR,
    scope?: CallerScope | null,
  ): WriteNoteResult {
    const { row, vault } = this.#use(ref, actor, 'write', scope);
    return this.#run(row, actor, 'note.edit', path, () => {
      const existing = vault.has(path);
      this.#mayChange(row, vault, actor, existing ?? path, 'change');
      this.#checkAgentText(actor, newText);
      const r = vault.editNote(path, oldText, newText, { actor, baseVersion });
      if (!r.unchanged) this.#edge(row, r.path, actor, 'edited');
      return { path: r.path, version: r.version, created: false, unchanged: r.unchanged, size: r.size, warnings: [] };
    });
  }

  appendNote(
    ref: string,
    path: string,
    text: string,
    heading: string | undefined,
    actor: Actor = UI_ACTOR,
    scope?: CallerScope | null,
  ): WriteNoteResult {
    const { row, vault } = this.#use(ref, actor, 'write', scope);
    return this.#run(row, actor, 'note.append', path, () => {
      const existing = vault.has(path);
      this.#mayChange(row, vault, actor, existing ?? path, existing ? 'change' : 'create');
      this.#checkAgentText(actor, text, heading);
      const r = vault.appendNote(path, text, { actor, heading: heading ?? null });
      if (!r.unchanged) this.#edge(row, r.path, actor, r.created ? 'created' : 'appended');
      const warnings =
        !this.#asAgent(actor) && Vault.looksSecret(text) ? ['The text you added looks like it contains a secret (a key or token).'] : [];
      return { path: r.path, version: r.version, created: r.created, unchanged: r.unchanged, size: r.size, warnings };
    });
  }

  renameNote(
    ref: string,
    from: string,
    to: string,
    o: { rewriteLinks?: boolean } = {},
    actor: Actor = UI_ACTOR,
  ): Promise<RenameNoteResult> {
    const { row, vault } = this.#use(ref, actor, 'write');
    return this.#run(row, actor, 'note.rename', from, () => {
      if (this.#asAgent(actor)) throw new KnowledgeError('NOT_ALLOWED_BY_POLICY', 'Agents can’t rename notes.');
      return vault
        .renameNote(from, to, { actor, rewriteLinks: o.rewriteLinks ?? this.#settings(row).rewriteLinksOnRename })
        .then((r) => ({ path: r.path, rewritten: r.rewritten }));
    });
  }

  deleteNote(ref: string, path: string, actor: Actor = UI_ACTOR): void {
    const { row, vault } = this.#use(ref, actor, 'write');
    this.#run(row, actor, 'note.delete', path, () => {
      if (this.#asAgent(actor)) throw new KnowledgeError('NOT_ALLOWED_BY_POLICY', 'Agents can’t delete notes.');
      vault.deleteNote(path, { actor });
      this.#edge(row, path, actor, 'deleted');
    });
  }

  restore(ref: string, path: string, versionId: number, actor: Actor = UI_ACTOR): WriteNoteResult {
    const { row, vault } = this.#use(ref, actor, 'write');
    return this.#run(row, actor, 'note.restore', path, () => {
      if (this.#asAgent(actor)) throw new KnowledgeError('NOT_ALLOWED_BY_POLICY', 'Agents can’t restore versions.');
      const r = vault.restoreVersion(path, versionId, { actor });
      this.#edge(row, r.path, actor, 'edited');
      return { path: r.path, version: r.version, created: r.created, unchanged: r.unchanged, size: r.size, warnings: [] };
    });
  }

  /* ---------- Daily notes ---------- */

  dailyPath(row: VaultRow, date: string): string {
    return row.daily_folder ? `${row.daily_folder}/${date}.md` : `${date}.md`;
  }

  daily(ref: string, date: string | undefined, actor: Actor = UI_ACTOR, scope?: CallerScope | null): VaultDaily {
    const { row, vault } = this.#use(ref, actor, 'read', scope);
    const d = date && date.trim() ? date.trim() : todayIn(row.timezone, this.#now());
    if (!isDate(d)) throw new KnowledgeError('INVALID_INPUT', 'A date is written YYYY-MM-DD.');
    const path = this.dailyPath(row, d);
    const has = vault.has(path);
    if (!has) return { date: d, path, exists: false, note: null };
    const r = vault.readNote(has);
    this.#edge(row, r.path, actor, 'read');
    return { date: d, path: r.path, exists: true, note: this.#view(row, vault, r) };
  }

  appendDaily(
    ref: string,
    req: DailyAppendRequest,
    actor: Actor = UI_ACTOR,
    scope?: CallerScope | null,
  ): WriteNoteResult & { date: string } {
    const { row, vault } = this.#use(ref, actor, 'write', scope);
    const now = this.#now();
    const d = req.date && req.date.trim() ? req.date.trim() : todayIn(row.timezone, now);
    if (!isDate(d)) throw new KnowledgeError('INVALID_INPUT', 'A date is written YYYY-MM-DD.');
    const path = this.dailyPath(row, d);
    return this.#run(row, actor, 'daily.append', path, () => {
      this.#checkAgentText(actor, req.text);
      const body = String(req.text ?? '').replace(/\s+$/, '');
      if (!body) throw new KnowledgeError('INVALID_INPUT', 'Say what to add.');
      const lines = body.split(/\r?\n/);
      const stamp = req.time === false ? '' : `${timeIn(row.timezone, now)} `;
      const bullet = `- ${stamp}${lines[0]}${lines
        .slice(1)
        .map((l) => `\n  ${l}`)
        .join('')}`;
      const existing = vault.has(path);
      this.#mayChange(row, vault, actor, existing ?? path, 'daily');
      const r = vault.appendNote(path, bullet, { actor });
      this.#edge(row, r.path, actor, r.created ? 'created' : 'appended');
      return { path: r.path, version: r.version, created: r.created, unchanged: r.unchanged, size: r.size, warnings: [], date: d };
    });
  }

  /* ---------- Attachments ---------- */

  openFile(ref: string, path: string, actor: Actor = UI_ACTOR) {
    const { vault } = this.#use(ref, actor, 'read');
    return vault.openFile(path);
  }

  putFile(ref: string, path: string, bytes: Buffer, actor: Actor = UI_ACTOR) {
    const { row, vault } = this.#use(ref, actor, 'write');
    return this.#run(row, actor, 'file.upload', path, () => {
      if (this.#asAgent(actor)) throw new KnowledgeError('NOT_ALLOWED_BY_POLICY', 'Agents can’t upload files.');
      return vault.writeFile(path, bytes, { actor });
    });
  }

  makeFolder(ref: string, path: string, actor: Actor = UI_ACTOR): void {
    const { row, vault } = this.#use(ref, actor, 'write');
    this.#run(row, actor, 'folder.create', path, () => {
      if (this.#asAgent(actor)) throw new KnowledgeError('NOT_ALLOWED_BY_POLICY', 'Agents can’t make folders.');
      vault.makeFolder(path);
    });
  }

  /* ---------- Activity, rescan, export ---------- */

  activity(ref: string, limit = 60, actor: Actor = UI_ACTOR): VaultActivityEntry[] {
    const { row } = this.#use(ref, actor, 'read');
    // A note's "original" row is bookkeeping (the text before the portal first changed it), not an event.
    const versions = this.journal
      .activity(row.id, limit * 2)
      .filter((v) => v.note !== 'original')
      .slice(0, limit)
      .map((v): VaultActivityEntry => ({ at: v.at, actor: v.actor, op: v.op, path: v.path, outcome: 'ok', detail: v.note }));
    const audits = this.journal
      .recentAudit(row.id, limit)
      .map((a): VaultActivityEntry => ({ at: a.at, actor: a.actor, op: a.op, path: a.path, outcome: a.outcome, detail: a.detail }));
    return [...versions, ...audits].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
  }

  async rescan(ref: string): Promise<VaultSummary> {
    const { row, vault } = this.#use(ref, UI_ACTOR, 'read');
    await vault.scan();
    return this.#summary(row);
  }

  /** The vault as a zip: a download name and the stream of chunks, with one top-level folder named for the vault. */
  exportZip(ref: string, actor: Actor = UI_ACTOR): { filename: string; chunks: Generator<Buffer> } {
    const { row, vault } = this.#use(ref, actor, 'read');
    const top =
      row.name
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
        .replace(/^\.+/, '')
        .trim() || 'vault';
    const entries = (function* () {
      for (const e of vault.exportEntries()) yield { ...e, name: `${top}/${e.name}` };
    })();
    this.journal.audit({
      vaultId: row.id,
      actor: actor.id,
      op: 'vault.export',
      outcome: 'ok',
      detail: `${vault.index.stats().notes} notes`,
    });
    return { filename: `${top}.zip`, chunks: zipChunks(entries) };
  }

  /* ---------- Upkeep ---------- */

  /** History and audit within their caps, old trash and deleted vaults gone, a zip of each changed vault kept (last three). */
  async maintain(): Promise<void> {
    if (!this.store.writable || !this.store.deliveryAllowed || !this.#ready()) return;
    this.#dirs();
    this.journal.pruneAudit(90);
    for (const row of this.#rows()) {
      try {
        this.journal.prune(row.id);
      } catch (e) {
        this.#log(`[knowledge] ${row.name}: history upkeep failed: ${(e as Error).message}`);
      }
    }
    this.#purge();
    await this.#backups();
  }

  #purge(): void {
    const cutoff = this.#now().getTime() - this.limits.trashVaultDays * DAY;
    const trash = join(this.#opts.dir, 'trash');
    for (const name of existsSync(trash) ? readdirSync(trash) : []) {
      try {
        if (statSync(join(trash, name)).mtimeMs < cutoff) rmSync(join(trash, name), { recursive: true, force: true });
      } catch {
        // already gone
      }
    }
    this.store.db!.prepare('DELETE FROM kg_vaults WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(new Date(cutoff).toISOString());
  }

  async #backups(): Promise<void> {
    const dir = this.#opts.backupsDir;
    if (!dir) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const row of this.#rows()) {
      if (row.kind !== 'vault') continue;
      let vault: Vault;
      try {
        vault = this.#open(row);
      } catch {
        continue;
      }
      const prefix = `knowledge-${row.id}-`;
      const have = readdirSync(dir)
        .filter((n) => n.startsWith(prefix) && n.endsWith('.zip'))
        .sort();
      const newest = have.at(-1);
      const last = newest ? statSync(join(dir, newest)).mtimeMs : 0;
      const changed = vault.index.stats().lastChangeMs ?? 0;
      if (!changed || changed <= last) continue;
      const stamp = this.#now()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z');
      const file = join(dir, `${prefix}${stamp}.zip`);
      const tmp = `${file}.tmp`;
      try {
        await new Promise<void>((resolve, reject) => {
          const out = createWriteStream(tmp, { mode: 0o600 });
          out.on('error', reject);
          out.on('finish', resolve);
          try {
            for (const chunk of zipChunks(vault.exportEntries())) out.write(chunk);
          } catch (e) {
            reject(e as Error);
            return;
          }
          out.end();
        });
        renameSync(tmp, file);
        for (const old of [...have, `${prefix}${stamp}.zip`].sort().slice(0, -3)) rmSync(join(dir, old), { force: true });
        this.#log(`[knowledge] ${row.name}: kept a zip of the vault (${file})`);
      } catch (e) {
        rmSync(tmp, { force: true });
        this.#log(`[knowledge] ${row.name}: zip backup failed: ${(e as Error).message}`);
      }
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  /* ---------- Used by the importer ---------- */

  /** Makes a vault for an import and returns it opened. */
  createForImport(name: string, actor: Actor): { summary: VaultSummary; vault: Vault; row: VaultRow } {
    const summary = this.create({ name }, actor);
    const row = this.#row(summary.id);
    return { summary, vault: this.#open(row), row };
  }

  openForImport(ref: string, scope?: CallerScope | null): { vault: Vault; row: VaultRow } {
    const row = this.resolve(ref, scope);
    const vault = this.#open(row);
    return { vault, row };
  }

  setDailyFolder(id: string, folder: string): void {
    this.store
      .db!.prepare('UPDATE kg_vaults SET daily_folder = ?, updated_at = ? WHERE id = ?')
      .run(this.#validDaily(folder), this.#now().toISOString(), id);
  }
}
