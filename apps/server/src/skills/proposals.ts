import { AppError } from '@isnanme/core';
import { SKILL_PROPOSAL_LIMITS, type SkillProposalInfo, type SkillReviewState, type SkillRisk } from '@portal/contracts';
import { CORE_SCHEMA, dump } from 'js-yaml';
import type { Store } from '../store/store.js';
import { cleanPath, type ArchiveEntry, ArchiveError } from './archive.js';
import type { SkillsLibrary } from './library.js';
import { redactCredentials } from './scan.js';

/**
 * Skill proposals (Skillset PRD FR-P, interface I11): an agent, or a token, proposes a new skill or a changed
 * one for its own workspace. The proposal is an ordinary library version waiting for review: it goes through the
 * same scanner as an upload, `needs_review` is its only state, and no skillset accepts a version that is not
 * approved, so nothing here can deliver anything. Skills are code-like, so a person approves every one; there is
 * no setting that lets a proposal through on its own.
 *
 * What the agent controls is a name, a description, a body and a few text files. The portal writes the
 * frontmatter itself, so a proposal can't smuggle in `allowed-tools`, hooks or other keys; the proposer's own
 * words are recorded as plain text and shown as such; a secret-shaped value anywhere refuses the whole proposal;
 * and the number waiting is capped per proposer, per workspace and in all, so a looping or injected agent can't
 * bury the review queue.
 */

/** `session:<id>`, `portal-mcp:<token id>`: who is asking. Recorded as given, so it must hold no secret. */
const ACTOR = /^[a-z][a-z0-9-]{1,24}:[A-Za-z0-9._~-]{1,80}$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A relative path of up to three plain segments, none hidden. */
const FILE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,2}$/;
/** Control characters except tab and newline, zero-width and bidirectional controls, and tag characters. */
const HIDDEN = /[\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{7F}\u{200B}-\u{200F}\u{2028}-\u{202E}\u{2060}-\u{206F}\u{FEFF}\u{E0000}-\u{E007F}]/u;

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

export interface SkillProposalRequest {
  name?: unknown;
  description?: unknown;
  body?: unknown;
  files?: unknown;
  reason?: unknown;
  replaces?: unknown;
}

export interface SkillProposalResult {
  versionId: string;
  name: string;
  /** `waiting_review` for a new proposal or one still waiting; otherwise what a person already decided about identical content. */
  status: 'waiting_review' | 'approved' | 'rejected' | 'revoked';
  /** The same content was proposed or imported before: nothing new was created. */
  duplicate: boolean;
  scripted: boolean;
  risk: SkillRisk;
  /** Where a person reviews it in the portal. */
  reviewPath: string;
}

/** One proposal as its proposer lists it. */
export interface SkillProposalRow {
  versionId: string;
  name: string;
  state: SkillReviewState;
  reason: string;
  replaces: string | null;
  workspaceId: string | null;
  at: string;
}

const STATUS: Record<SkillReviewState, SkillProposalResult['status']> = { needs_review: 'waiting_review', approved: 'approved', rejected: 'rejected', revoked: 'revoked' };

export class SkillProposals {
  constructor(
    private readonly store: Store,
    private readonly library: SkillsLibrary,
  ) {}

  /** Everything the portal needs to show about the proposals behind these versions (the library's list and review page). */
  info(versionIds: string[]): Map<string, SkillProposalInfo> {
    const out = new Map<string, SkillProposalInfo>();
    const db = this.store.db;
    if (!db || versionIds.length === 0) return out;
    try {
      const one = db.prepare('SELECT actor, workspace_id, reason, replaces, proposed_at FROM skill_proposals WHERE version_id = ?');
      for (const id of versionIds) {
        const r = one.get(id) as { actor: string; workspace_id: string | null; reason: string; replaces: string | null; proposed_at: string } | undefined;
        if (r) out.set(id, { actor: r.actor, workspaceId: r.workspace_id, reason: r.reason, replaces: r.replaces, at: r.proposed_at });
      }
    } catch {
      // An older schema has no proposals table: nothing was proposed.
    }
    return out;
  }

  /** Proposals still waiting for a person: who made them and for which workspace. */
  #waiting(): { actor: string; workspaceId: string | null }[] {
    const db = this.store.db;
    if (!db) return [];
    const rows = db
      .prepare('SELECT p.actor AS actor, p.workspace_id AS workspaceId, v.tree_hash AS hash FROM skill_proposals p JOIN skill_versions v ON v.id = p.version_id')
      .all() as { actor: string; workspaceId: string | null; hash: string }[];
    const states = this.library.reviewStates(rows.map((r) => r.hash));
    return rows.filter((r) => states.get(r.hash)?.state === 'needs_review').map((r) => ({ actor: r.actor, workspaceId: r.workspaceId }));
  }

  /** The text of a request field: a string within `max` characters with no hidden characters. */
  #text(value: unknown, field: string, label: string, max: number, opts: { optional?: boolean; multiline?: boolean } = {}): string {
    if ((value === undefined || value === null || value === '') && opts.optional) return '';
    if (typeof value !== 'string' || !value.trim()) throw invalid(field, `${label} is required.`);
    const s = value.replace(/\r\n?/g, '\n');
    if (s.length > max) throw invalid(field, `${label} may be at most ${max} characters.`);
    if (HIDDEN.test(s)) throw invalid(field, `${label} has control or invisible characters. Remove them.`);
    if (!opts.multiline && s.includes('\n')) throw invalid(field, `${label} must be one line.`);
    if (redactCredentials(s) !== s) throw invalid(field, `${label} looks like it holds a secret. Never put a credential in a skill; name what it needs and let a person provide it.`);
    return s;
  }

  /**
   * A new skill, or a new version of one, proposed by `actor` for `workspaceId` (verified by the caller from the
   * agent's token; null for an admin's token). Throws VALIDATION_FAILED with a field for what to fix, RATE_LIMITED
   * when too many proposals wait. Never approves, publishes or delivers.
   */
  propose(actor: string, workspaceId: string | null, req: SkillProposalRequest): SkillProposalResult {
    if (!ACTOR.test(actor) || redactCredentials(actor) !== actor) throw new AppError('VALIDATION_FAILED', 'The proposer is not recorded in a form the portal accepts.');
    const db = this.store.db;
    if (!db || !this.store.writable) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not writable.');

    const name = typeof req.name === 'string' ? req.name.trim() : '';
    if (!NAME.test(name) || name.length > 64) throw invalid('name', 'Use lowercase letters, digits and single dashes, at most 64 characters (like code-review).');
    const description = this.#text(req.description, 'description', 'The description', SKILL_PROPOSAL_LIMITS.descriptionChars);
    const body = this.#text(req.body, 'body', 'The instructions', SKILL_PROPOSAL_LIMITS.skillMdBytes, { multiline: true });
    if (body.trimStart().startsWith('---')) throw invalid('body', 'Leave out the frontmatter: the portal writes the name and description itself.');
    const reason = this.#text(req.reason, 'reason', 'The reason', SKILL_PROPOSAL_LIMITS.reasonChars, { optional: true });
    const replaces = this.#text(req.replaces, 'replaces', 'The name of the skill it changes', 64, { optional: true });
    if (replaces && !NAME.test(replaces)) throw invalid('replaces', 'Name the skill it changes the way its folder is named (like code-review).');

    const skillMd = `---\n${dump({ name, description }, { schema: CORE_SCHEMA, lineWidth: -1, noRefs: true })}---\n${body.endsWith('\n') ? body : `${body}\n`}`;
    if (bytes(skillMd) > SKILL_PROPOSAL_LIMITS.skillMdBytes) throw invalid('body', `SKILL.md may be at most ${SKILL_PROPOSAL_LIMITS.skillMdBytes / 1024} KB.`);
    const entries: ArchiveEntry[] = [{ path: `${name}/SKILL.md`, type: 'file', mode: 0o644, data: Buffer.from(skillMd) }];

    const files = req.files === undefined || req.files === null ? [] : req.files;
    if (!Array.isArray(files)) throw invalid('files', 'Send the extra files as a list of { path, content }.');
    if (files.length > SKILL_PROPOSAL_LIMITS.files) throw invalid('files', `At most ${SKILL_PROPOSAL_LIMITS.files} extra files.`);
    let total = bytes(skillMd);
    const seen = new Set<string>(['skill.md']);
    files.forEach((f: unknown, i) => {
      const field = `files.${i}`;
      if (!f || typeof f !== 'object' || Array.isArray(f)) throw invalid(field, 'Each file is { path, content }.');
      const { path, content, executable } = f as { path?: unknown; content?: unknown; executable?: unknown };
      if (typeof path !== 'string') throw invalid(`${field}.path`, 'A file needs a path.');
      let clean: string;
      try {
        clean = cleanPath(path);
      } catch (e) {
        throw invalid(`${field}.path`, e instanceof ArchiveError ? e.message : 'That path is not allowed.');
      }
      if (!FILE_PATH.test(clean)) throw invalid(`${field}.path`, 'Use a short relative path of plain names, at most three folders deep, like scripts/check.sh. No hidden files.');
      if (seen.has(clean.toLowerCase())) throw invalid(`${field}.path`, `${clean} is listed twice (or is SKILL.md, which the instructions already are).`);
      seen.add(clean.toLowerCase());
      const text = this.#text(content, `${field}.content`, clean, SKILL_PROPOSAL_LIMITS.fileBytes, { multiline: true });
      total += bytes(text);
      if (total > SKILL_PROPOSAL_LIMITS.totalBytes) throw invalid('files', `A proposal may hold at most ${SKILL_PROPOSAL_LIMITS.totalBytes / 1024} KB in all.`);
      entries.push({ path: `${name}/${clean}`, type: 'file', mode: executable === true ? 0o755 : 0o644, data: Buffer.from(text) });
    });

    // The queue first: refused before anything is stored.
    const waiting = this.#waiting();
    if (waiting.filter((w) => w.actor === actor).length >= SKILL_PROPOSAL_LIMITS.waitingPerActor)
      throw new AppError('RATE_LIMITED', `${SKILL_PROPOSAL_LIMITS.waitingPerActor} of your skill proposals are already waiting for a person. They need reviewing first.`);
    if (workspaceId !== null && waiting.filter((w) => w.workspaceId === workspaceId).length >= SKILL_PROPOSAL_LIMITS.waitingPerWorkspace)
      throw new AppError('RATE_LIMITED', `${SKILL_PROPOSAL_LIMITS.waitingPerWorkspace} skill proposals for this workspace are already waiting for a person to review them.`);
    if (waiting.length >= SKILL_PROPOSAL_LIMITS.waitingTotal) throw new AppError('RATE_LIMITED', `${SKILL_PROPOSAL_LIMITS.waitingTotal} skill proposals are waiting for a person to review them. Ask for those to be reviewed first.`);

    // The same scanner and checks as an upload: a refusal there (a path, a size, a script that can't be read) refuses the proposal.
    const result = this.library.importUpload(entries, `Proposed by ${actor}`.slice(0, 120), null);
    const item = result.skills[0];
    if (!item) throw new AppError('VALIDATION_FAILED', result.refused[0]?.reason ?? 'The skill was refused.');
    const version = db.prepare('SELECT scripted, risk FROM skill_versions WHERE id = ?').get(item.versionId) as { scripted: number; risk: SkillRisk };
    const known = db.prepare('SELECT 1 AS x FROM skill_proposals WHERE version_id = ?').get(item.versionId);
    // Identical content is one version: someone else's proposal, an import, or this one again. Only a version that
    // is new gets a proposal record; an existing import stays an import.
    if (item.status === 'new') {
      db.prepare('INSERT INTO skill_proposals (version_id, actor, workspace_id, reason, replaces, proposed_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        item.versionId,
        actor,
        workspaceId,
        reason,
        replaces || null,
        new Date().toISOString(),
      );
    }
    return {
      versionId: item.versionId,
      name,
      status: STATUS[item.review],
      duplicate: item.status === 'existing' || !!known,
      scripted: !!version.scripted,
      risk: version.risk,
      reviewPath: `/admin/pools/skills/review/${item.versionId}`,
    };
  }

  /** Proposals for a workspace (an agent's own) or all of them (an admin's token), newest first. */
  list(filter: { workspaceId?: string | null; limit?: number } = {}): SkillProposalRow[] {
    const db = this.store.db;
    if (!db) return [];
    try {
      const rows = (
        filter.workspaceId
          ? db.prepare('SELECT p.version_id, p.workspace_id, p.reason, p.replaces, p.proposed_at, v.name, v.tree_hash FROM skill_proposals p JOIN skill_versions v ON v.id = p.version_id WHERE p.workspace_id = ? ORDER BY p.proposed_at DESC LIMIT ?').all(filter.workspaceId, filter.limit ?? 20)
          : db.prepare('SELECT p.version_id, p.workspace_id, p.reason, p.replaces, p.proposed_at, v.name, v.tree_hash FROM skill_proposals p JOIN skill_versions v ON v.id = p.version_id ORDER BY p.proposed_at DESC LIMIT ?').all(filter.limit ?? 20)
      ) as { version_id: string; workspace_id: string | null; reason: string; replaces: string | null; proposed_at: string; name: string; tree_hash: string }[];
      const states = this.library.reviewStates(rows.map((r) => r.tree_hash));
      return rows.map((r) => ({
        versionId: r.version_id,
        name: r.name,
        state: states.get(r.tree_hash)?.state ?? 'needs_review',
        reason: r.reason,
        replaces: r.replaces,
        workspaceId: r.workspace_id,
        at: r.proposed_at,
      }));
    } catch {
      return [];
    }
  }
}
