import { AppError, newId } from '@isnanme/core';
import type {
  McpApproveRequest,
  McpCatalogEntry,
  McpCatalogVersion,
  McpEntryKind,
  McpEntryRequest,
  McpEntryUpdate,
  McpEntryUse,
  McpProposalRequest,
  McpProposalResult,
  McpReviewState,
  McpRiskFlag,
  McpSlot,
  McpVersionRequest,
  McpVersionSpec,
} from '@portal/contracts';
import { MCP_ENTRY_KINDS } from '@portal/contracts';
import { redact } from '../chat/redact.js';
import type { Store } from '../store/store.js';
import { assertPublicUrl, commandOf, exactVersionProblem, parseSlots, parseSpec, riskFlags, serverKeyProblem, targetOf, type UrlCheck } from './spec.js';

export interface EntryRow {
  id: string;
  key: string;
  display_name: string;
  description: string;
  kind: McpEntryKind;
  package: string | null;
  registry_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  id: string;
  entry_id: string;
  version: string;
  spec: string;
  slots: string;
  review_state: McpReviewState;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  proposed_by: string | null;
  proposed_at: string | null;
  proposal_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** Who asked for a version and why, when an agent or a token proposed it (I3). */
interface Proposal {
  by: string;
  reason: string | null;
}

/** A catalog version with its entry, parsed: what sets and the compiler work with. */
export interface CatalogVersion {
  entry: EntryRow;
  row: VersionRow;
  spec: McpVersionSpec;
  slots: McpSlot[];
  /** The launcher target (stdio) or null (remote). */
  target: string | null;
}

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const NOTE_MAX = 500;
/** With one shared admin sign-in, approvals can't name a person (foundation Q10, PRD Q9). */
const REVIEWER = 'Admin';
const EVENT_RETENTION_DAYS = 90;
/** I3: how many proposals may wait for a person at once, per actor and in all, so a stolen token can't bury the review queue. */
const PROPOSALS_PER_ACTOR = 10;
const PROPOSALS_WAITING_MAX = 40;
/** `portal-mcp:<token id>`, `session:<id>`, `ticket:<id>`: who is asking. Recorded as given, so it must hold no secret. */
const ACTOR = /^[a-z][a-z0-9-]{1,24}:[A-Za-z0-9._~-]{1,80}$/;

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const gone = () => new AppError('NOT_FOUND', 'That catalog entry no longer exists.');

/** Characters that hide or reorder text: zero-width, bidirectional, and tag characters (PRD §16). */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\u{e0000}-\u{e007f}]/u;

/**
 * Text that comes with a proposal is untrusted: the reviewer reads it, so it carries no secret (the
 * proposal names the secrets a server needs; it never contains one) and nothing invisible.
 */
function proposalText(input: unknown, field: string, max: number): string {
  if (input === undefined || input === null || input === '') return '';
  const s = cleanText(input, field, max, false);
  if (INVISIBLE.test(s)) throw invalid(field, 'Remove the invisible and direction-changing characters.');
  if (redact(s) !== s) throw invalid(field, 'This looks like a secret. A proposal names the secrets a server needs and never holds one.');
  return s;
}

function cleanText(input: unknown, field: string, max: number, required: boolean): string {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s && required) throw invalid(field, 'Fill this in.');
  if (s.length > max) throw invalid(field, `Use at most ${max} characters.`);
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s)) throw invalid(field, 'Remove the control characters.');
  return s;
}

/**
 * The catalog of reviewed MCP servers (MCP set PRD FR1–FR5, §9): manual npm, remote and command entries,
 * each with pinned versions that move draft → approved → deprecated or revoked. An approved version
 * never changes; editing one means a new draft. Sets point at an entry and one of its versions.
 */
export class McpCatalog {
  /** Where each entry is used; supplied by the set kind, which knows the pools. */
  usage: () => Map<string, { sets: McpEntryUse[]; workspaces: Set<string> }> = () => new Map();
  /** Workspaces a version reaches; supplied by the set kind. */
  versionUse: (versionId: string) => number = () => 0;
  /** Something in the catalog changed (for live pages). */
  onChange: () => void = () => {};
  #lastPrune = 0;

  constructor(
    private readonly store: Store,
    private readonly opts: { urlCheck?: () => UrlCheck; resolveDns?: boolean } = {},
  ) {}

  get #db() {
    const db = this.store.db;
    if (!db || !this.store.writable) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not writable.');
    return db;
  }

  #tx<T>(fn: () => T): T {
    const db = this.#db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Records a catalog event (§17): what and when, never a value. */
  event(type: string, ids: { entryId?: string; versionId?: string; workspaceId?: string }, details: Record<string, unknown> = {}) {
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    db.prepare('INSERT INTO mcp_events (at, type, entry_id, version_id, workspace_id, details) VALUES (?, ?, ?, ?, ?, ?)').run(
      new Date().toISOString(),
      type,
      ids.entryId ?? null,
      ids.versionId ?? null,
      ids.workspaceId ?? null,
      JSON.stringify(details),
    );
    const now = Date.now();
    if (now - this.#lastPrune > 60 * 60_000) {
      this.#lastPrune = now;
      db.prepare('DELETE FROM mcp_events WHERE at < ?').run(new Date(now - EVENT_RETENTION_DAYS * 86_400_000).toISOString());
    }
  }

  /* ---------- Reading ---------- */

  #entry(id: string): EntryRow {
    const row = this.store.db?.prepare('SELECT * FROM mcp_catalog WHERE id = ?').get(id) as EntryRow | undefined;
    if (!row) throw gone();
    return row;
  }

  #versionRow(entryId: string, versionId: string): VersionRow {
    const row = this.store.db?.prepare('SELECT * FROM mcp_catalog_versions WHERE id = ? AND entry_id = ?').get(versionId, entryId) as VersionRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'That version no longer exists.');
    return row;
  }

  static parsed(entry: EntryRow, row: VersionRow): CatalogVersion {
    const spec = JSON.parse(row.spec) as McpVersionSpec;
    return { entry, row, spec, slots: JSON.parse(row.slots) as McpSlot[], target: targetOf(entry.kind, row.version, spec) };
  }

  /** An entry's version by its version string (how sets name it), or null. */
  find(entryId: string, version: string): CatalogVersion | null {
    const db = this.store.db;
    if (!db) return null;
    const entry = db.prepare('SELECT * FROM mcp_catalog WHERE id = ?').get(entryId) as EntryRow | undefined;
    const row = entry && (db.prepare('SELECT * FROM mcp_catalog_versions WHERE entry_id = ? AND version = ?').get(entryId, version) as VersionRow | undefined);
    return entry && row ? McpCatalog.parsed(entry, row) : null;
  }

  findById(versionId: string): CatalogVersion | null {
    const db = this.store.db;
    const row = db?.prepare('SELECT * FROM mcp_catalog_versions WHERE id = ?').get(versionId) as VersionRow | undefined;
    const entry = row && (db!.prepare('SELECT * FROM mcp_catalog WHERE id = ?').get(row.entry_id) as EntryRow | undefined);
    return entry && row ? McpCatalog.parsed(entry, row) : null;
  }

  /** An entry by its key (keys are unique), or null: the built-in catalogue looks for what an earlier Add made. */
  findByKey(key: string): EntryRow | null {
    return (this.store.db?.prepare('SELECT * FROM mcp_catalog WHERE key = ?').get(key) as EntryRow | undefined) ?? null;
  }

  /** An entry's versions parsed, newest first, without the usage numbers `get` adds: for callers that compare definitions. */
  versionsOf(entryId: string): CatalogVersion[] {
    const db = this.store.db;
    const entry = db?.prepare('SELECT * FROM mcp_catalog WHERE id = ?').get(entryId) as EntryRow | undefined;
    if (!db || !entry) return [];
    const rows = db.prepare('SELECT * FROM mcp_catalog_versions WHERE entry_id = ? ORDER BY created_at DESC, rowid DESC').all(entryId) as unknown as VersionRow[];
    return rows.map((row) => McpCatalog.parsed(entry, row));
  }

  /**
   * What a version of this kind would be, checked exactly as `create` and `addVersion` check it (parse, the URL rules, the
   * SSRF guard) but stored nowhere: the built-in catalogue's preview, and the definitions it compares before adding a version.
   */
  async check(kind: McpEntryKind, spec: unknown, slots?: unknown): Promise<{ spec: McpVersionSpec; slots: McpSlot[]; flags: McpRiskFlag[] }> {
    const parsed = await this.#spec(kind, spec);
    return { spec: parsed, slots: parseSlots(kind, slots, parsed), flags: riskFlags(kind, parsed) };
  }

  /** The newest approved version of an entry, for "Upgrade available" (FR4). */
  newestApproved(entryId: string): VersionRow | null {
    return (
      (this.store.db?.prepare("SELECT * FROM mcp_catalog_versions WHERE entry_id = ? AND review_state = 'approved' ORDER BY created_at DESC LIMIT 1").get(entryId) as
        | VersionRow
        | undefined) ?? null
    );
  }

  /** Revoked versions, newest first. */
  revoked(): { entry: EntryRow; row: VersionRow }[] {
    const db = this.store.db;
    if (!db) return [];
    const rows = db.prepare("SELECT * FROM mcp_catalog_versions WHERE review_state = 'revoked' ORDER BY revoked_at DESC").all() as unknown as VersionRow[];
    return rows.flatMap((row) => {
      const entry = db.prepare('SELECT * FROM mcp_catalog WHERE id = ?').get(row.entry_id) as EntryRow | undefined;
      return entry ? [{ entry, row }] : [];
    });
  }

  version(entry: EntryRow, row: VersionRow): McpCatalogVersion {
    const { spec, slots, target } = McpCatalog.parsed(entry, row);
    return {
      id: row.id,
      entryId: row.entry_id,
      version: row.version,
      spec,
      slots,
      reviewState: row.review_state,
      reviewedAt: row.reviewed_at,
      reviewedBy: row.reviewed_by,
      reviewNote: row.review_note,
      revokedAt: row.revoked_at,
      proposal: row.proposed_by ? { by: row.proposed_by, at: row.proposed_at ?? row.created_at, reason: row.proposal_reason } : null,
      command: commandOf(entry.kind, row.version, spec),
      target,
      flags: riskFlags(entry.kind, spec),
      workspaces: row.review_state === 'draft' ? 0 : this.versionUse(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #view(entry: EntryRow, usage = this.usage()): McpCatalogEntry {
    const rows = this.store.db!.prepare('SELECT * FROM mcp_catalog_versions WHERE entry_id = ? ORDER BY created_at DESC, rowid DESC').all(entry.id) as unknown as VersionRow[];
    const used = usage.get(entry.id);
    return {
      id: entry.id,
      key: entry.key,
      displayName: entry.display_name,
      description: entry.description,
      kind: entry.kind,
      registryName: entry.registry_name,
      versions: rows.map((r) => this.version(entry, r)),
      sets: used?.sets ?? [],
      workspaces: used?.workspaces.size ?? 0,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at,
    };
  }

  list(): McpCatalogEntry[] {
    const rows = (this.store.db?.prepare('SELECT * FROM mcp_catalog ORDER BY display_name COLLATE NOCASE').all() ?? []) as unknown as EntryRow[];
    const usage = this.usage();
    return rows.map((r) => this.#view(r, usage));
  }

  get(id: string): McpCatalogEntry {
    return this.#view(this.#entry(id));
  }

  /* ---------- Writing ---------- */

  async #spec(kind: McpEntryKind, input: unknown): Promise<McpVersionSpec> {
    const spec = parseSpec(kind, input, this.opts.urlCheck?.() ?? {});
    if (spec.url && this.opts.resolveDns !== false) await assertPublicUrl(spec.url, !!spec.allowPrivateNetwork);
    return spec;
  }

  /** The version string a new draft gets: the package's exact version, or the next `vN`. */
  #versionFor(entry: Pick<EntryRow, 'id' | 'kind'>, input: unknown, exceptId?: string): string {
    const db = this.#db;
    if (entry.kind === 'npm' || entry.kind === 'pypi') {
      const v = typeof input === 'string' ? input.trim() : '';
      const problem = exactVersionProblem(v);
      if (problem) throw invalid('version', problem);
      const clash = db.prepare('SELECT id FROM mcp_catalog_versions WHERE entry_id = ? AND version = ?').get(entry.id, v) as { id: string } | undefined;
      if (clash && clash.id !== exceptId) throw new AppError('CONFLICT', `Version ${v} is already in the catalog.`, { details: { version: 'Already in the catalog.' } });
      return v;
    }
    if (exceptId) return (db.prepare('SELECT version FROM mcp_catalog_versions WHERE id = ?').get(exceptId) as { version: string }).version;
    const rows = db.prepare('SELECT version FROM mcp_catalog_versions WHERE entry_id = ?').all(entry.id) as { version: string }[];
    const n = Math.max(0, ...rows.map((r) => Number(/^v(\d+)$/.exec(r.version)?.[1] ?? 0)));
    return `v${n + 1}`;
  }

  /** "Add manually" (US1): an entry and its first version, a draft until someone reviews it. */
  async create(req: Partial<McpEntryRequest>): Promise<McpCatalogEntry> {
    return this.get((await this.#createEntry(req)).entryId);
  }

  async #createEntry(req: Partial<McpEntryRequest>, proposal?: Proposal): Promise<{ entryId: string; versionId: string; version: string }> {
    const kind = req.kind as McpEntryKind;
    if (!MCP_ENTRY_KINDS.includes(kind)) throw invalid('kind', 'Pick npm, remote or command.');
    const key = typeof req.key === 'string' ? req.key.trim() : '';
    const keyProblem = serverKeyProblem(key);
    if (keyProblem) throw invalid('key', keyProblem);
    const displayName = cleanText(req.displayName, 'displayName', NAME_MAX, true);
    const description = cleanText(req.description, 'description', DESCRIPTION_MAX, false);
    const spec = await this.#spec(kind, req.spec);
    const slots = parseSlots(kind, req.slots, spec);
    const pkg = spec.package ?? spec.path ?? null;
    const id = newId();
    const versionId = newId();
    const now = new Date().toISOString();
    let version = '';
    this.#tx(() => {
      const db = this.#db;
      if (db.prepare('SELECT 1 FROM mcp_catalog WHERE key = ?').get(key)) throw new AppError('CONFLICT', `An entry with the key “${key}” already exists.`, { details: { key: 'Already used.' } });
      if (pkg) {
        const other = db.prepare('SELECT display_name FROM mcp_catalog WHERE kind = ? AND package = ?').get(kind, pkg) as { display_name: string } | undefined;
        if (other) throw new AppError('CONFLICT', `${pkg} is already in the catalog as ${other.display_name}. Add a version there.`, { details: { 'spec.package': 'Already in the catalog.' } });
      }
      db.prepare('INSERT INTO mcp_catalog (id, key, display_name, description, kind, package, registry_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)').run(
        id,
        key,
        displayName,
        description,
        kind,
        pkg,
        now,
        now,
      );
      version = this.#versionFor({ id, kind }, req.version);
      db.prepare(
        `INSERT INTO mcp_catalog_versions (id, entry_id, version, spec, slots, review_state, proposed_by, proposed_at, proposal_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      ).run(versionId, id, version, JSON.stringify(spec), JSON.stringify(slots), proposal?.by ?? null, proposal ? now : null, proposal?.reason ?? null, now, now);
    });
    this.event('entry_created', { entryId: id, versionId }, { key, kind, ...(proposal ? { proposedBy: proposal.by } : {}) });
    this.onChange();
    return { entryId: id, versionId, version };
  }

  /** Name and description: shown only in the portal, so no review. */
  update(id: string, req: Partial<McpEntryUpdate>): McpCatalogEntry {
    const entry = this.#entry(id);
    const displayName = req.displayName === undefined ? entry.display_name : cleanText(req.displayName, 'displayName', NAME_MAX, true);
    const description = req.description === undefined ? entry.description : cleanText(req.description, 'description', DESCRIPTION_MAX, false);
    this.#db.prepare('UPDATE mcp_catalog SET display_name = ?, description = ?, updated_at = ? WHERE id = ?').run(displayName, description, new Date().toISOString(), id);
    this.onChange();
    return this.get(id);
  }

  /** A new draft version (FR4: approved versions never change). */
  async addVersion(id: string, req: Partial<McpVersionRequest>): Promise<McpCatalogEntry> {
    await this.#addVersion(id, req);
    return this.get(id);
  }

  async #addVersion(id: string, req: Partial<McpVersionRequest>, proposal?: Proposal): Promise<{ versionId: string; version: string }> {
    const entry = this.#entry(id);
    const spec = await this.#spec(entry.kind, req.spec);
    this.#samePackage(entry, spec);
    const slots = parseSlots(entry.kind, req.slots, spec);
    const versionId = newId();
    const now = new Date().toISOString();
    let version = '';
    this.#tx(() => {
      version = this.#versionFor(entry, req.version);
      this.#db
        .prepare(
          `INSERT INTO mcp_catalog_versions (id, entry_id, version, spec, slots, review_state, proposed_by, proposed_at, proposal_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
        )
        .run(versionId, id, version, JSON.stringify(spec), JSON.stringify(slots), proposal?.by ?? null, proposal ? now : null, proposal?.reason ?? null, now, now);
      this.#db.prepare('UPDATE mcp_catalog SET updated_at = ? WHERE id = ?').run(now, id);
    });
    this.event('version_created', { entryId: id, versionId }, proposal ? { proposedBy: proposal.by } : {});
    this.onChange();
    return { versionId, version };
  }

  /** Changes a draft; anything reviewed is fixed. */
  async updateVersion(id: string, versionId: string, req: Partial<McpVersionRequest>): Promise<McpCatalogEntry> {
    const entry = this.#entry(id);
    const row = this.#versionRow(id, versionId);
    if (row.review_state !== 'draft') throw new AppError('CONFLICT', `${row.version} is ${row.review_state}: it can’t change. Add a new version instead.`);
    const spec = await this.#spec(entry.kind, req.spec);
    this.#samePackage(entry, spec);
    const slots = parseSlots(entry.kind, req.slots, spec);
    const now = new Date().toISOString();
    this.#tx(() => {
      const version = this.#versionFor(entry, req.version ?? row.version, versionId);
      this.#db
        .prepare("UPDATE mcp_catalog_versions SET version = ?, spec = ?, slots = ?, updated_at = ? WHERE id = ? AND review_state = 'draft'")
        .run(version, JSON.stringify(spec), JSON.stringify(slots), now, versionId);
    });
    this.onChange();
    return this.get(id);
  }

  /** An entry is one package: its versions can't switch to another (revocation finds processes by package). */
  #samePackage(entry: EntryRow, spec: McpVersionSpec) {
    const pkg = spec.package ?? spec.path ?? null;
    if (entry.package && pkg !== entry.package)
      throw invalid(spec.path ? 'spec.path' : 'spec.package', `This entry is ${entry.package}. Add another package as its own entry.`);
  }

  removeVersion(id: string, versionId: string) {
    const row = this.#versionRow(id, versionId);
    if (row.review_state !== 'draft') throw new AppError('CONFLICT', 'Only drafts can be deleted: reviewed versions stay on record. Deprecate or revoke it instead.');
    this.#db.prepare("DELETE FROM mcp_catalog_versions WHERE id = ? AND review_state = 'draft'").run(versionId);
    this.onChange();
  }

  /* ---------- Proposals (I3: the global "add MCP" flow) ---------- */

  /**
   * An agent or a token asks for a server. The same checks and the same tables as "Add manually", with
   * who asked and why recorded on the version. It can only ever make a DRAFT: no set accepts a draft
   * (`McpSetKind`), the only way out of draft is `approve`, and that is a portal route behind the
   * sign-in, not something a proposal reaches. A proposal is never edited afterwards (a person might be
   * reading it); the proposer withdraws it or proposes another version. Secrets appear as slot names
   * only: nothing credential-shaped is accepted in any text.
   */
  async propose(actor: unknown, req: Partial<McpProposalRequest>): Promise<McpProposalResult> {
    const by = typeof actor === 'string' ? actor.trim() : '';
    if (!ACTOR.test(by)) throw invalid('actor', 'Say who is asking, like portal-mcp:<token id> or session:<id>.');
    const kind = req.kind as McpEntryKind;
    if (!MCP_ENTRY_KINDS.includes(kind)) throw invalid('kind', 'Pick npm, remote or command.');
    const reason = proposalText(req.reason, 'reason', NOTE_MAX) || null;
    proposalText(req.displayName, 'displayName', NAME_MAX);
    proposalText(req.description, 'description', DESCRIPTION_MAX);
    if (Array.isArray(req.slots)) req.slots.forEach((slot, i) => proposalText((slot as { description?: unknown } | null)?.description, `slots.${i}.description`, 300));

    const db = this.#db;
    const waiting = db.prepare("SELECT proposed_by AS by FROM mcp_catalog_versions WHERE proposed_by IS NOT NULL AND review_state = 'draft'").all() as { by: string }[];
    if (waiting.filter((w) => w.by === by).length >= PROPOSALS_PER_ACTOR)
      throw new AppError('RATE_LIMITED', `${by} already has ${PROPOSALS_PER_ACTOR} proposals waiting for a person. They need reviewing, or withdrawing, first.`);
    if (waiting.length >= PROPOSALS_WAITING_MAX)
      throw new AppError('RATE_LIMITED', `${PROPOSALS_WAITING_MAX} proposals are waiting for a person to review them. Ask for those to be reviewed first.`);

    const key = typeof req.key === 'string' ? req.key.trim() : '';
    const entry = key ? (db.prepare('SELECT * FROM mcp_catalog WHERE key = ?').get(key) as EntryRow | undefined) : undefined;
    const proposal: Proposal = { by, reason };
    let out: { entryId: string; versionId: string; version: string };
    let duplicate = false;
    if (!entry) out = await this.#createEntry(req, proposal);
    else {
      if (entry.kind !== kind) throw new AppError('CONFLICT', `${key} is already in the catalog as a ${entry.kind} entry.`, { details: { key: 'Already used.' } });
      // The same proposal again (an agent retrying) is the one already waiting, not a second one.
      const spec = JSON.stringify(await this.#spec(kind, req.spec));
      const slots = JSON.stringify(parseSlots(kind, req.slots, JSON.parse(spec) as McpVersionSpec));
      const same = (db.prepare("SELECT id, version, spec, slots FROM mcp_catalog_versions WHERE entry_id = ? AND review_state = 'draft' AND proposed_by = ?").all(entry.id, by) as {
        id: string;
        version: string;
        spec: string;
        slots: string;
      }[]).find((v) => v.spec === spec && v.slots === slots && (kind === 'remote' || kind === 'command' || v.version === (typeof req.version === 'string' ? req.version.trim() : '')));
      if (same) {
        out = { entryId: entry.id, versionId: same.id, version: same.version };
        duplicate = true;
      } else out = { entryId: entry.id, ...(await this.#addVersion(entry.id, req, proposal)) };
    }
    this.event('proposed', { entryId: out.entryId, versionId: out.versionId }, { by, key, kind, version: out.version, newEntry: !entry, duplicate, reason });
    return {
      entryId: out.entryId,
      versionId: out.versionId,
      key,
      version: out.version,
      status: 'waiting_review',
      newEntry: !entry,
      duplicate,
      proposedBy: by,
      reviewPath: `/admin/pools/mcp/catalog/${out.entryId}`,
    };
  }

  /** The proposer takes back its own proposal while it still waits; reviewed versions stay on record. */
  withdrawProposal(actor: unknown, versionId: string): void {
    const by = typeof actor === 'string' ? actor.trim() : '';
    const row = this.#db.prepare('SELECT * FROM mcp_catalog_versions WHERE id = ?').get(versionId) as VersionRow | undefined;
    if (!row || row.review_state !== 'draft' || !row.proposed_by) throw new AppError('NOT_FOUND', 'That proposal isn’t waiting for review.');
    if (row.proposed_by !== by) throw new AppError('CONFLICT', 'Only whoever proposed it can withdraw it. A person can delete it in the catalog.');
    this.#db.prepare("DELETE FROM mcp_catalog_versions WHERE id = ? AND review_state = 'draft'").run(versionId);
    // An entry that existed only for this proposal goes with it.
    const left = this.#db.prepare('SELECT count(*) AS n FROM mcp_catalog_versions WHERE entry_id = ?').get(row.entry_id) as { n: number };
    if (Number(left.n) === 0) this.#db.prepare('DELETE FROM mcp_catalog WHERE id = ?').run(row.entry_id);
    this.event('proposal_withdrawn', { entryId: row.entry_id, versionId }, { by });
    this.onChange();
  }

  /** Proposals waiting for a person (the Catalog's "to review" count). */
  waitingReview(): number {
    const row = this.store.db?.prepare("SELECT count(*) AS n FROM mcp_catalog_versions WHERE proposed_by IS NOT NULL AND review_state = 'draft'").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Refused while a set uses it. */
  remove(id: string) {
    const entry = this.#entry(id);
    const used = this.usage().get(id);
    if (used?.sets.length) throw new AppError('CONFLICT', `In use by ${used.sets.map((s) => s.poolName).join(', ')}. Take it out of those sets first.`);
    const reviewed = this.#db.prepare("SELECT count(*) AS n FROM mcp_catalog_versions WHERE entry_id = ? AND review_state <> 'draft'").get(id) as { n: number };
    if (Number(reviewed.n) > 0) throw new AppError('CONFLICT', 'It has reviewed versions, which stay on record. Deprecate or revoke them instead.');
    this.#db.prepare('DELETE FROM mcp_catalog WHERE id = ?').run(id);
    this.event('entry_deleted', { entryId: id }, { key: entry.key });
    this.onChange();
  }

  /** Approval (FR3): the reviewer saw the exact command or URL and ticked that they checked it and its source. */
  approve(id: string, versionId: string, req: Partial<McpApproveRequest>): McpCatalogEntry {
    this.#entry(id);
    const row = this.#versionRow(id, versionId);
    if (row.review_state !== 'draft') throw new AppError('CONFLICT', `${row.version} is already ${row.review_state}.`);
    if (req.reviewed !== true) throw invalid('reviewed', 'Tick “I reviewed the command and its source” first.');
    const note = cleanText(req.note, 'note', NOTE_MAX, false);
    const now = new Date().toISOString();
    this.#db
      .prepare("UPDATE mcp_catalog_versions SET review_state = 'approved', reviewed_at = ?, reviewed_by = ?, review_note = ?, updated_at = ? WHERE id = ? AND review_state = 'draft'")
      .run(now, REVIEWER, note || null, now, versionId);
    this.event('version_approved', { entryId: id, versionId }, { version: row.version, note: note || null });
    this.onChange();
    return this.get(id);
  }

  /** Deprecated versions keep working where they are but can't be added (FR13). */
  deprecate(id: string, versionId: string): McpCatalogEntry {
    this.#entry(id);
    const row = this.#versionRow(id, versionId);
    if (row.review_state !== 'approved') throw new AppError('CONFLICT', `Only approved versions can be deprecated; ${row.version} is ${row.review_state}.`);
    const now = new Date().toISOString();
    this.#db.prepare("UPDATE mcp_catalog_versions SET review_state = 'deprecated', updated_at = ? WHERE id = ?").run(now, versionId);
    this.event('version_deprecated', { entryId: id, versionId }, { version: row.version });
    this.onChange();
    return this.get(id);
  }

  /** Marks a version revoked (FR13b). The set kind takes it out of every delivery; see McpSets.revoke. */
  markRevoked(id: string, versionId: string, reason: unknown): CatalogVersion {
    const entry = this.#entry(id);
    const row = this.#versionRow(id, versionId);
    if (row.review_state === 'draft') throw new AppError('CONFLICT', 'A draft never reached a workspace: delete it instead.');
    if (row.review_state === 'revoked') throw new AppError('CONFLICT', `${row.version} is already revoked.`);
    const why = cleanText(reason, 'reason', NOTE_MAX, false);
    const now = new Date().toISOString();
    this.#db
      .prepare("UPDATE mcp_catalog_versions SET review_state = 'revoked', revoked_at = ?, revoke_reason = ?, updated_at = ? WHERE id = ?")
      .run(now, why || null, now, versionId);
    this.onChange();
    return McpCatalog.parsed(entry, this.#versionRow(id, versionId));
  }
}
