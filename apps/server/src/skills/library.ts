import { createHash } from 'node:crypto';
import { AppError, newId } from '@isnanme/core';
import {
  SKILL_FILE_PAGE_LINES,
  SKILLSET_MIN_CLAUDE_VERSION,
  type SkillFileContent,
  type SkillFileInfo,
  type SkillFinding,
  type SkillImportItem,
  type SkillImportResult,
  type SkillLibrary,
  type SkillProposalInfo,
  type SkillReviewRecord,
  type SkillReviewRequest,
  type SkillReviewState,
  type SkillRisk,
  type SkillSourceKind,
  type SkillSourceSummary,
  type SkillVersionDetail,
  type SkillVersionSummary,
} from '@portal/contracts';
import type { Store } from '../store/store.js';
import type { ArchiveEntry } from './archive.js';
import type { BlobStore } from './blobs.js';
import { checkSkill, findingCounts, findSkills } from './importer.js';
import { isText, redactCredentials } from './scan.js';

interface VersionRow {
  id: string;
  source_id: string;
  name: string;
  path_in_source: string;
  tree_hash: string;
  frontmatter: string;
  description: string;
  license: string | null;
  size_bytes: number;
  file_count: number;
  scripted: number;
  risk: SkillRisk;
  findings: string;
  listing_chars: number;
  details: string;
  imported_at: string;
}

interface SourceRow {
  id: string;
  kind: SkillSourceKind;
  label: string;
  url: string | null;
  ref: string | null;
  resolved: string | null;
  created_at: string;
  checked_at: string | null;
  removed_at: string | null;
}

export interface FileRow {
  version_id: string;
  path: string;
  blob_sha256: string;
  size: number;
  mode: number;
  kind: SkillFileInfo['kind'];
  interpreter: string | null;
}

interface ReviewRow {
  tree_hash: string;
  decision: 'approved' | 'rejected' | 'revoked';
  note: string;
  acknowledged: string;
  session: string | null;
  at: string;
}

/** What the review page shows besides findings, stored as `skill_versions.details`. */
interface VersionDetails {
  convertedFrom?: string | null;
  requirements?: string[];
  licenseFiles?: string[];
  openSourceLicense?: boolean;
  network?: boolean;
  hooks?: boolean;
  allowedTools?: boolean;
  warnings?: string[];
}

/** A version as the skillset kind needs it: identity, review state and files. */
export interface LibraryVersion {
  id: string;
  name: string;
  treeHash: string;
  description: string;
  scripted: boolean;
  risk: SkillRisk;
  allowedTools: boolean;
  listingChars: number;
}

const NOTE_MAX = 1000;
const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};
/** One shared admin sign-in (Q6): reviews record which session decided, as a short hash of its token. */
export const sessionTag = (token: string | undefined) => (token ? createHash('sha256').update(token).digest('hex').slice(0, 12) : null);

/**
 * The skill library (Skillset PRD §8 FR1–FR11, §11): skill versions and their sources, review decisions
 * per tree hash, and the files behind each version. Skillsets (the pool kind) read from here; changes
 * that affect what workspaces get are passed on through `hooks`.
 */
export class SkillsLibrary {
  /** Set by the module: approvals release waiting set revisions, revocations recompile workspaces. */
  hooks: {
    changed: () => void;
    approved: (treeHash: string) => void;
    revoked: (treeHash: string) => void;
    /** Skillsets whose newest or current revision lists each version (for "In N sets" and removal). */
    setsUsing: () => Map<string, { poolId: string; poolName: string; revisions: number[]; listed: boolean }[]>;
  } = { changed: () => {}, approved: () => {}, revoked: () => {}, setsUsing: () => new Map() };

  /** Who proposed each version that came as a proposal (set by the module: an agent's or a token's skill proposal, I11). */
  proposals: (versionIds: string[]) => Map<string, SkillProposalInfo> = () => new Map();

  constructor(
    private readonly store: Store,
    private readonly blobs: BlobStore,
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
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /* ---------- Review state ---------- */

  /** The latest decision for each tree hash (none: needs review). */
  reviewStates(hashes: Iterable<string>): Map<string, { state: SkillReviewState; at: string | null }> {
    const out = new Map<string, { state: SkillReviewState; at: string | null }>();
    const db = this.store.db;
    const one = db?.prepare('SELECT decision, at FROM skill_reviews WHERE tree_hash = ? ORDER BY id DESC LIMIT 1');
    for (const h of hashes) {
      if (out.has(h)) continue;
      const row = one?.get(h) as { decision: ReviewRow['decision']; at: string } | undefined;
      out.set(h, row ? { state: row.decision, at: row.at } : { state: 'needs_review', at: null });
    }
    return out;
  }

  reviewState(treeHash: string): SkillReviewState {
    return this.reviewStates([treeHash]).get(treeHash)!.state;
  }

  /** Tree hashes revoked at or after `since`, with when (their latest decision is the revocation). */
  revokedSince(since: Date): Map<string, string> {
    const rows = (this.store.db?.prepare("SELECT tree_hash, max(id) AS id FROM skill_reviews WHERE decision = 'revoked' AND at >= ? GROUP BY tree_hash").all(since.toISOString()) ?? []) as {
      tree_hash: string;
    }[];
    const out = new Map<string, string>();
    for (const r of rows) {
      const latest = this.store.db!.prepare('SELECT decision, at FROM skill_reviews WHERE tree_hash = ? ORDER BY id DESC LIMIT 1').get(r.tree_hash) as { decision: string; at: string };
      if (latest.decision === 'revoked') out.set(r.tree_hash, latest.at);
    }
    return out;
  }

  /** Every tree hash whose latest decision is a revocation. */
  revokedHashes(): Set<string> {
    const rows = (this.store.db?.prepare(
      "SELECT r.tree_hash FROM skill_reviews r WHERE r.decision = 'revoked' AND r.id = (SELECT max(id) FROM skill_reviews WHERE tree_hash = r.tree_hash)",
    ).all() ?? []) as { tree_hash: string }[];
    return new Set(rows.map((r) => r.tree_hash));
  }

  /* ---------- Versions ---------- */

  versions(ids: Iterable<string>): Map<string, LibraryVersion> {
    const out = new Map<string, LibraryVersion>();
    const one = this.store.db?.prepare('SELECT * FROM skill_versions WHERE id = ?');
    for (const id of ids) {
      if (out.has(id)) continue;
      const r = one?.get(id) as VersionRow | undefined;
      if (!r) continue;
      const d = json<VersionDetails>(r.details, {});
      out.set(id, {
        id: r.id,
        name: r.name,
        treeHash: r.tree_hash,
        description: r.description,
        scripted: !!r.scripted,
        risk: r.risk,
        allowedTools: !!d.allowedTools,
        listingChars: r.listing_chars,
      });
    }
    return out;
  }

  files(versionId: string): FileRow[] {
    return (this.store.db?.prepare('SELECT * FROM skill_files WHERE version_id = ? ORDER BY path').all(versionId) ?? []) as unknown as FileRow[];
  }

  /** A file's bytes from the blob store; null when the blob is gone or damaged. */
  blob(sha: string): Buffer | null {
    return this.blobs.get(sha);
  }

  #summary(r: VersionRow, source: SourceRow | undefined, review: { state: SkillReviewState; at: string | null }, sets: number, proposal: SkillProposalInfo | null = null): SkillVersionSummary {
    const d = json<VersionDetails>(r.details, {});
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      sourceId: r.source_id,
      sourceLabel: source?.label ?? 'Removed source',
      sourceKind: source?.kind ?? 'upload',
      pathInSource: r.path_in_source,
      treeHash: r.tree_hash,
      license: r.license,
      sizeBytes: r.size_bytes,
      fileCount: r.file_count,
      scripted: !!r.scripted,
      risk: r.risk,
      network: !!d.network,
      hooks: !!d.hooks,
      review: review.state,
      reviewedAt: review.at,
      sets,
      listingChars: r.listing_chars,
      allowedTools: !!d.allowedTools,
      convertedFrom: d.convertedFrom ?? null,
      importedAt: r.imported_at,
      proposal,
    };
  }

  /** `GET /api/skills/library`: every version, newest first within a name, and the sources. */
  library(): SkillLibrary {
    const db = this.store.db;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not available.');
    const rows = db.prepare('SELECT * FROM skill_versions ORDER BY name COLLATE NOCASE, imported_at DESC').all() as unknown as VersionRow[];
    const sources = new Map((db.prepare('SELECT * FROM skill_sources').all() as unknown as SourceRow[]).map((s) => [s.id, s]));
    const reviews = this.reviewStates(rows.map((r) => r.tree_hash));
    const using = this.hooks.setsUsing();
    const proposed = this.proposals(rows.map((r) => r.id));
    const versions = rows.map((r) => this.#summary(r, sources.get(r.source_id), reviews.get(r.tree_hash)!, (using.get(r.id) ?? []).filter((s) => s.listed).length, proposed.get(r.id) ?? null));
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.source_id, (counts.get(r.source_id) ?? 0) + 1);
    return {
      versions,
      sources: [...sources.values()]
        .filter((s) => !s.removed_at)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(
          (s): SkillSourceSummary => ({
            id: s.id,
            kind: s.kind,
            label: s.label,
            url: s.url,
            ref: s.ref,
            resolved: s.resolved,
            createdAt: s.created_at,
            checkedAt: s.checked_at,
            versions: counts.get(s.id) ?? 0,
          }),
        ),
      toReview: versions.filter((v) => v.review === 'needs_review').length,
      minClaudeVersion: SKILLSET_MIN_CLAUDE_VERSION,
    };
  }

  #row(id: string): VersionRow {
    const r = this.store.db?.prepare('SELECT * FROM skill_versions WHERE id = ?').get(id) as VersionRow | undefined;
    if (!r) throw new AppError('NOT_FOUND', 'That skill version no longer exists.');
    return r;
  }

  /** `GET /api/skills/versions/:id`: everything the review page shows. */
  detail(id: string): SkillVersionDetail {
    const r = this.#row(id);
    const db = this.store.db!;
    const source = db.prepare('SELECT * FROM skill_sources WHERE id = ?').get(r.source_id) as SourceRow | undefined;
    const reviews = (db.prepare('SELECT * FROM skill_reviews WHERE tree_hash = ? ORDER BY id DESC').all(r.tree_hash) as unknown as ReviewRow[]).map((x): SkillReviewRecord => {
      const ack = json<{ findings?: string[]; license?: boolean }>(x.acknowledged, {});
      return { decision: x.decision, note: x.note, acknowledged: ack.findings ?? [], licenseConfirmed: !!ack.license, session: x.session, at: x.at };
    });
    const latest = reviews[0];
    const using = this.hooks.setsUsing().get(r.id) ?? [];
    const d = json<VersionDetails>(r.details, {});
    return {
      ...this.#summary(r, source, latest ? { state: latest.decision, at: latest.at } : { state: 'needs_review', at: null }, using.filter((s) => s.listed).length, this.proposals([r.id]).get(r.id) ?? null),
      files: this.files(r.id).map((f) => ({ path: f.path, size: f.size, mode: f.mode, kind: f.kind, interpreter: f.interpreter, binary: f.kind === 'asset' })),
      findings: json<SkillFinding[]>(r.findings, []),
      frontmatter: json<Record<string, unknown>>(r.frontmatter, {}),
      requirements: d.requirements ?? [],
      licenseFiles: d.licenseFiles ?? [],
      openSourceLicense: !!d.openSourceLicense,
      reviews,
      inSets: using.map((s) => ({ poolId: s.poolId, poolName: s.poolName, revisions: s.revisions })),
    };
  }

  /** One page of a file, as plain text with credentials masked. Only paths the version lists. */
  file(id: string, path: unknown, offset: unknown): SkillFileContent {
    this.#row(id);
    if (typeof path !== 'string' || !path) throw new AppError('BAD_REQUEST', 'Name a file.');
    const f = this.store.db!.prepare('SELECT * FROM skill_files WHERE version_id = ? AND path = ?').get(id, path) as FileRow | undefined;
    if (!f) throw new AppError('NOT_FOUND', 'That file isn’t part of this skill.');
    const bytes = this.blobs.get(f.blob_sha256);
    if (!bytes) throw new AppError('NOT_FOUND', 'The file’s content is missing from the blob store.');
    if (!isText(bytes)) return { path, size: f.size, binary: true, totalLines: 0, offset: 0, lines: [] };
    const lines = bytes.toString('utf8').split('\n');
    const start = Math.max(0, Math.min(Number.isInteger(Number(offset)) ? Number(offset) : 0, Math.max(0, lines.length - 1)));
    return {
      path,
      size: f.size,
      binary: false,
      totalLines: lines.length,
      offset: start,
      lines: lines.slice(start, start + SKILL_FILE_PAGE_LINES).map((l) => redactCredentials(l)),
    };
  }

  /* ---------- Import ---------- */

  /**
   * Stores what an upload holds (FR1, FR5, FR6): new versions with their files as blobs, one source for
   * the upload. Content imported before (same tree hash and name) reuses its version and review.
   */
  importUpload(entries: ArchiveEntry[], label: string, rootName: string | null): SkillImportResult {
    const found = findSkills(entries, rootName);
    const refused = [...found.refused];
    const checked = found.skills.flatMap((f) => {
      const r = checkSkill(f);
      if ('refused' in r) {
        refused.push({ path: f.pathInSource, reason: r.refused.join(' ') });
        return [];
      }
      return [r.skill];
    });
    if (!checked.length && !refused.length) throw new AppError('VALIDATION_FAILED', 'No skills found: the upload has no SKILL.md folders, plugins or command files.');
    const now = new Date().toISOString();
    const items: SkillImportItem[] = [];
    let sourceId: string | null = null;
    const db = this.#db;
    // Blobs first (outside the transaction: a rollback leaves only unreferenced blobs, which expire).
    const blobOf = new Map<object, string>();
    for (const c of checked) for (const f of c.scan.files) blobOf.set(f, this.blobs.put(f.data));
    this.#tx(() => {
      for (const c of checked) {
        const existing = db.prepare('SELECT id FROM skill_versions WHERE tree_hash = ? AND name = ?').get(c.treeHash, c.name) as { id: string } | undefined;
        let versionId = existing?.id;
        if (!versionId) {
          if (!sourceId) {
            sourceId = newId();
            db.prepare("INSERT INTO skill_sources (id, kind, label, created_at) VALUES (?, 'upload', ?, ?)").run(sourceId, label.slice(0, 120) || 'Upload', now);
          }
          versionId = newId();
          const details: VersionDetails = {
            convertedFrom: c.found.command?.from ?? null,
            requirements: c.scan.requirements,
            licenseFiles: c.scan.licenseFiles,
            openSourceLicense: c.scan.openSourceLicense,
            network: c.scan.network,
            hooks: c.scan.hooks,
            allowedTools: c.scan.allowedTools,
            warnings: c.scan.warnings,
          };
          db.prepare(
            `INSERT INTO skill_versions (id, source_id, name, path_in_source, tree_hash, frontmatter, description, license, size_bytes, file_count, scripted, risk, findings, listing_chars, details, imported_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            versionId,
            sourceId,
            c.name,
            c.found.pathInSource,
            c.treeHash,
            redactCredentials(JSON.stringify(c.frontmatter)),
            redactCredentials(c.scan.description).slice(0, 4000),
            c.scan.license ? redactCredentials(c.scan.license).slice(0, 200) : null,
            c.scan.files.reduce((n, f) => n + f.size, 0),
            c.scan.files.length,
            c.scan.scripted ? 1 : 0,
            c.scan.risk,
            JSON.stringify(c.scan.findings),
            c.scan.listingChars,
            JSON.stringify(details),
            now,
          );
          const insert = db.prepare('INSERT INTO skill_files (version_id, path, blob_sha256, size, mode, kind, interpreter) VALUES (?, ?, ?, ?, ?, ?, ?)');
          for (const f of c.scan.files) insert.run(versionId, f.path, blobOf.get(f)!, f.size, f.mode, f.kind, f.interpreter);
        }
        items.push({
          name: c.name,
          versionId,
          treeHash: c.treeHash,
          status: existing ? 'existing' : 'new',
          review: this.reviewState(c.treeHash),
          scripted: c.scan.scripted,
          findings: findingCounts(c.scan),
          command: c.found.command ? { from: c.found.command.from, to: `/<prefix>:${c.name}` } : null,
          warnings: c.scan.warnings,
        });
      }
    });
    if (items.length) this.hooks.changed();
    return { sourceId, skills: items, refused, notImported: found.notImported };
  }

  /* ---------- Decisions ---------- */

  #decide(treeHash: string, decision: ReviewRow['decision'], note: string, acknowledged: object, session: string | null) {
    this.#db
      .prepare('INSERT INTO skill_reviews (tree_hash, decision, note, acknowledged, session, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(treeHash, decision, redactCredentials(note).slice(0, NOTE_MAX), JSON.stringify(acknowledged), session, new Date().toISOString());
  }

  /**
   * Approve or reject (§11.2). Approving needs: no credential finding (those can't be acknowledged);
   * with any High finding, every flagged item ticked and a note; and, without a recognized open-source
   * license, the reviewer's confirmation. Rejecting needs a note. A revoked version stays revoked.
   */
  review(id: string, req: Partial<SkillReviewRequest>, session: string | null): SkillVersionDetail {
    const r = this.#row(id);
    const state = this.reviewState(r.tree_hash);
    const note = typeof req.note === 'string' ? req.note.trim() : '';
    if (state === 'revoked') throw new AppError('CONFLICT', 'This version was revoked and stays revoked.');
    if (req.decision === 'rejected') {
      if (state === 'approved') throw new AppError('CONFLICT', 'It’s approved: revoke it instead, so workspaces lose it.');
      if (state === 'rejected') return this.detail(id);
      if (!note) throw invalid('note', 'Say why it’s rejected.');
      this.#decide(r.tree_hash, 'rejected', note, {}, session);
      this.hooks.changed();
      return this.detail(id);
    }
    if (req.decision !== 'approved') throw invalid('decision', 'Approve or reject it.');
    if (state === 'approved') return this.detail(id);
    const findings = json<SkillFinding[]>(r.findings, []);
    const details = json<VersionDetails>(r.details, {});
    if (findings.some((f) => f.code === 'credential')) throw new AppError('CONFLICT', 'It contains credential material, which can’t be approved. Reject it, or import it again without that file.');
    const acked = new Set(Array.isArray(req.acknowledged) ? req.acknowledged.filter((x): x is string => typeof x === 'string') : []);
    const high = findings.filter((f) => f.needsAck);
    const missing = high.filter((f) => !acked.has(f.id));
    if (missing.length) throw invalid('acknowledged', `Tick every flagged item first (${missing.length} left).`);
    if (high.length && !note) throw invalid('note', 'Add a note: what you checked in the flagged items.');
    if (!details.openSourceLicense && req.licenseConfirmed !== true) throw invalid('licenseConfirmed', 'Confirm the license allows this use: it isn’t a recognized open-source license.');
    this.#decide(r.tree_hash, 'approved', note, { findings: high.map((f) => f.id), license: !details.openSourceLicense }, session);
    this.hooks.approved(r.tree_hash);
    this.hooks.changed();
    return this.detail(id);
  }

  /**
   * Revocation (§11.3): the version leaves every workspace at once, pinned ones included, and the
   * revisions that list it can't deliver it again. Only an approved version can be revoked.
   */
  revoke(id: string, noteInput: unknown, session: string | null): SkillVersionDetail {
    const r = this.#row(id);
    const state = this.reviewState(r.tree_hash);
    if (state === 'revoked') return this.detail(id);
    if (state !== 'approved') throw new AppError('CONFLICT', 'Only approved versions can be revoked; reject this one instead.');
    const note = typeof noteInput === 'string' ? noteInput.trim() : '';
    if (!note) throw invalid('note', 'Say why it’s revoked.');
    this.#decide(r.tree_hash, 'revoked', note, {}, session);
    this.hooks.revoked(r.tree_hash);
    this.hooks.changed();
    return this.detail(id);
  }

  /**
   * Removes a source from the list. Its versions stay (they're immutable and may be in sets), unless
   * `withVersions`, which is refused while any skillset revision lists one of them.
   */
  removeSource(id: string, withVersions: boolean): void {
    const s = this.store.db?.prepare('SELECT * FROM skill_sources WHERE id = ?').get(id) as SourceRow | undefined;
    if (!s) throw new AppError('NOT_FOUND', 'That source no longer exists.');
    if (!withVersions) {
      this.#db.prepare('UPDATE skill_sources SET removed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      this.hooks.changed();
      return;
    }
    const versions = (this.#db.prepare('SELECT id, name FROM skill_versions WHERE source_id = ?').all(id) as { id: string; name: string }[]).map((v) => ({ ...v }));
    const using = this.hooks.setsUsing();
    const inUse = versions.filter((v) => (using.get(v.id) ?? []).length > 0);
    if (inUse.length) throw new AppError('CONFLICT', `${inUse.map((v) => v.name).join(', ')} ${inUse.length === 1 ? 'is' : 'are'} in a skillset. Remove ${inUse.length === 1 ? 'it' : 'them'} from every revision’s set first, or remove the source only.`);
    this.#tx(() => {
      this.#db.prepare('DELETE FROM skill_versions WHERE source_id = ?').run(id);
      this.#db.prepare('DELETE FROM skill_sources WHERE id = ?').run(id);
    });
    this.hooks.changed();
  }

  /** Blob hashes skill files reference (the blob store keeps these). */
  *referencedBlobs(): Iterable<string> {
    const rows = (this.store.db?.prepare('SELECT DISTINCT blob_sha256 FROM skill_files').all() ?? []) as { blob_sha256: string }[];
    for (const r of rows) yield r.blob_sha256;
  }
}
