import { createHash } from 'node:crypto';
import { AppError, newId } from '@isnanme/core';
import { PERSONA_PROPOSAL_LIMITS, POOL_NAME_MAX, type PersonaContent, type PersonaProposal, type PersonaProposalKind, type PersonaProposalStatus } from '@portal/contracts';
import type { PoolService } from '../pools/service.js';
import type { Store } from '../store/store.js';
import type { Avatar } from './avatar.js';
import type { PersonaIdentityStore, PersonaMeta } from './identity.js';
import { CONTROL, INVISIBLE, secretProblem, type PersonaKind } from './kind.js';

// What a session may ask for about its own persona (Persona PRD A10, interface I11). A proposal is a record:
// nothing in it is live, and nothing an agent can call approves it. A person approves it in the portal (one tap),
// except a name or an avatar when the persona's own switch says so; instructions never auto-approve. Approving
// instructions publishes a new revision, built from what is current then, so a rejected or stale proposal never
// reaches the revision history and an edit is always checked against the text it would change.

/** The edits an agent may ask for in its instructions. */
export interface InstructionsPatch {
  /** Text added after the existing instructions. */
  append?: string;
  /** Exact text replaced by other text; each `find` has to occur once, so the edit can't land somewhere else. */
  replace?: { find: string; with: string }[];
}

/** Who is asking, as the agent's token says: never as the arguments say. */
export interface ProposalContext {
  workspaceId: string;
  sessionId: string;
}

interface Row {
  id: string;
  pool_id: string;
  kind: PersonaProposalKind;
  status: PersonaProposalStatus;
  actor: string;
  workspace_id: string;
  session_id: string;
  reason: string;
  payload: string;
  fingerprint: string;
  base_revision: number | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

const bad = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const HOUR_MS = 60 * 60 * 1000;

/** One line of the agent's own words: cleaned of control and invisible characters and never a secret. */
function words(input: unknown, field: string, max: number, opts: { required?: boolean } = {}): string {
  const s = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
  if (!s) {
    if (opts.required) throw bad(field, 'Say why.');
    return '';
  }
  if (s.length > max) throw bad(field, `Use at most ${max} characters.`);
  if (CONTROL.test(s) || INVISIBLE.test(s)) throw bad(field, 'Use plain text without control or invisible characters.');
  const secret = secretProblem(s);
  if (secret) throw bad(field, secret);
  return s;
}

/**
 * The text after `patch`: replacements first, each of an exact piece that occurs once, then the addition. Throws
 * VALIDATION_FAILED, naming the edit, when a piece is missing or ambiguous, and when nothing would change.
 */
export function applyPatch(before: string, patch: InstructionsPatch): string {
  let text = before;
  const edits = patch.replace ?? [];
  edits.forEach((e, n) => {
    const field = `instructions_patch.replace.${n}`;
    if (!e.find) throw bad(field, 'Name the exact text to replace.');
    const found = text.split(e.find).length - 1;
    if (found === 0) throw bad(field, 'That text isn’t in the instructions. Copy it exactly, including punctuation.');
    if (found > 1) throw bad(field, `That text occurs ${found} times. Name more of it so it is unique.`);
    text = text.replace(e.find, () => e.with);
  });
  if (patch.append?.trim()) text = text.trim() ? `${text.replace(/\s+$/, '')}\n\n${patch.append.trim()}` : patch.append.trim();
  if (text === before) throw bad('instructions_patch', 'That changes nothing.');
  return text;
}

/** The patch as the tool gave it, checked for size and for text that must never be proposed. */
export function checkPatch(input: unknown): InstructionsPatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('instructions_patch', 'Send an object with `append` and/or `replace`.');
  const p = input as { append?: unknown; replace?: unknown };
  const out: InstructionsPatch = {};
  let size = 0;
  if (p.append !== undefined) {
    if (typeof p.append !== 'string') throw bad('instructions_patch.append', 'Use text.');
    out.append = p.append.replace(/\r\n/g, '\n');
    size += bytes(out.append);
  }
  if (p.replace !== undefined) {
    if (!Array.isArray(p.replace)) throw bad('instructions_patch.replace', 'Use a list of { find, with }.');
    if (p.replace.length > PERSONA_PROPOSAL_LIMITS.edits) throw bad('instructions_patch.replace', `Use at most ${PERSONA_PROPOSAL_LIMITS.edits} replacements.`);
    out.replace = p.replace.map((raw, n) => {
      const e = raw as { find?: unknown; with?: unknown };
      if (!e || typeof e.find !== 'string' || typeof e.with !== 'string') throw bad(`instructions_patch.replace.${n}`, 'Each replacement needs `find` and `with` as text.');
      size += bytes(e.find) + bytes(e.with);
      return { find: e.find.replace(/\r\n/g, '\n'), with: e.with.replace(/\r\n/g, '\n') };
    });
  }
  if (size > PERSONA_PROPOSAL_LIMITS.instructionsBytes) throw bad('instructions_patch', `Use at most ${PERSONA_PROPOSAL_LIMITS.instructionsBytes / 1024} KB of edits per proposal.`);
  if (!out.append?.trim() && !out.replace?.length) throw bad('instructions_patch', 'Name something to add or replace.');
  // New text only: the text it replaces is the persona's own.
  for (const text of [out.append ?? '', ...(out.replace ?? []).map((e) => e.with)]) {
    if (CONTROL.test(text) || INVISIBLE.test(text)) throw bad('instructions_patch', 'Remove the control and invisible characters.');
    const secret = secretProblem(text);
    if (secret) throw bad('instructions_patch', secret);
  }
  return out;
}

export class PersonaProposals {
  constructor(
    private readonly store: Store,
    private readonly pools: PoolService,
    private readonly identity: PersonaIdentityStore,
    private readonly kind: PersonaKind,
    /** The portal-wide switch `agents.selfEdit` (settings & policies): off, nothing is accepted. */
    private readonly portalAllows: () => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get #db() {
    const db = this.store.db;
    if (!db || !this.store.writable) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not writable.');
    return db;
  }

  /* ---------- What an agent may ask ---------- */

  /**
   * The persona a session is allowed to propose changes to: the one its workspace has, and only while the portal's
   * switch and the persona's own switch are on. Anything else is refused with what to do about it.
   */
  #gate(ctx: ProposalContext): { poolId: string; meta: PersonaMeta } {
    if (!this.portalAllows()) throw new AppError('FORBIDDEN', 'Agents can’t propose changes to personas in this portal. A person can allow it in Settings.');
    const poolId = this.identity.personaOf(ctx.workspaceId);
    if (!poolId) throw new AppError('NOT_FOUND', 'This workspace has no persona.');
    const meta = this.identity.meta(poolId);
    if (!meta.agentsMayPropose) throw new AppError('FORBIDDEN', 'This persona doesn’t take proposals from agents. A person can allow it in the persona’s editor.');
    return { poolId, meta };
  }

  /** The persona as its own agent may read it, with the switches and the agent's own waiting proposals. */
  getSelf(ctx: ProposalContext) {
    const poolId = this.identity.personaOf(ctx.workspaceId);
    if (!poolId) return null;
    const meta = this.identity.meta(poolId);
    const current = this.pools.currentContent<PersonaContent>(poolId, 'persona');
    const detail = this.pools.get(poolId);
    return {
      poolId,
      name: detail.name,
      description: detail.description,
      revision: detail.revision,
      hasAvatar: !!meta.avatar,
      instructions: current?.content.instructions ?? '',
      styles: current?.content.styles.map((s) => s.name) ?? [],
      subagents: current?.content.agents.map((a) => a.name) ?? [],
      model: current?.content.model ?? null,
      effort: current?.content.effort ?? null,
      allowed: this.portalAllows() && meta.agentsMayPropose,
      autoApproves: this.portalAllows() && meta.agentsMayPropose && meta.autoApproveCosmetic,
      pending: this.list({ poolId, status: 'pending' }).filter((p) => p.actor === `session:${ctx.sessionId}`),
    };
  }

  /**
   * A new name and/or edits to the instructions, with the agent's reason. Everything is checked before anything is
   * recorded, so a call that can't be honoured leaves no half of it behind; each part is its own proposal, so a
   * person can approve the name and turn the text down.
   */
  proposeUpdate(ctx: ProposalContext, input: { name?: unknown; instructionsPatch?: unknown; reason: unknown }) {
    const { poolId, meta } = this.#gate(ctx);
    const reason = words(input.reason, 'reason', PERSONA_PROPOSAL_LIMITS.reasonChars, { required: true });
    if (input.name === undefined && input.instructionsPatch === undefined) throw bad('update', 'Name something to change: a new name, or edits to the instructions.');
    let name: string | null = null;
    if (input.name !== undefined) {
      name = words(input.name, 'name', POOL_NAME_MAX, { required: true });
      if (name === this.pools.get(poolId).name) throw bad('name', 'That is already its name.');
      this.#nameFree(name, poolId);
    }
    let text: { patch: InstructionsPatch; before: string; after: string; revision: number } | null = null;
    if (input.instructionsPatch !== undefined) {
      const patch = checkPatch(input.instructionsPatch);
      const current = this.#current(poolId);
      text = { patch, before: current.content.instructions, after: this.#after(current.content, patch), revision: current.pool.revision };
    }
    const made = [];
    if (name !== null) made.push(this.#create(ctx, poolId, 'name', { name }, reason, meta, null));
    if (text) made.push(this.#create(ctx, poolId, 'instructions', { edits: text.patch, before: text.before, after: text.after }, reason, meta, text.revision));
    return made;
  }

  /** `avatar` has been through `normalizeAvatar` already: what is stored is its PNG. */
  proposeAvatar(ctx: ProposalContext, avatar: Avatar, rawReason: unknown) {
    const { poolId, meta } = this.#gate(ctx);
    const reason = words(rawReason, 'reason', PERSONA_PROPOSAL_LIMITS.reasonChars, { required: true });
    if (meta.avatar === avatar.sha256) throw bad('avatar', 'That is already its avatar.');
    // Checked before the image is kept, so a refused call stores nothing.
    this.#limits(ctx, poolId, null);
    const sha = this.identity.putAvatar(avatar);
    return this.#create(ctx, poolId, 'avatar', { avatar: sha }, reason, meta, null);
  }

  #nameFree(name: string, exceptPool: string) {
    const clash = this.#db.prepare("SELECT id FROM pools WHERE type = 'persona' AND name = ? COLLATE NOCASE AND id <> ?").get(name, exceptPool) as { id: string } | undefined;
    if (clash) throw new AppError('CONFLICT', 'Another persona is called that.', { details: { name: 'Already used.' } });
  }

  #current(poolId: string) {
    const current = this.pools.currentContent<PersonaContent>(poolId, 'persona');
    if (!current) throw new AppError('CONFLICT', 'This persona has no published revision to change.');
    return current;
  }

  /** The instructions after the edit, and only if the persona would still accept them (size, secrets, characters). */
  #after(content: PersonaContent, patch: InstructionsPatch): string {
    const after = applyPatch(content.instructions, patch);
    this.kind.parse({ ...content, instructions: after }, content);
    return after;
  }

  /** At most a few waiting per persona and a few an hour per session, so a looping or injected agent can't bury the queue. */
  #limits(ctx: ProposalContext, poolId: string, fingerprint: string | null) {
    const db = this.#db;
    if (fingerprint && db.prepare("SELECT 1 FROM persona_proposals WHERE pool_id = ? AND fingerprint = ? AND status = 'pending'").get(poolId, fingerprint)) return;
    const pending = db.prepare("SELECT count(*) AS n FROM persona_proposals WHERE pool_id = ? AND status = 'pending'").get(poolId) as { n: number };
    if (Number(pending.n) >= PERSONA_PROPOSAL_LIMITS.pendingPerPersona)
      throw new AppError('RATE_LIMITED', `${PERSONA_PROPOSAL_LIMITS.pendingPerPersona} proposals are waiting for a person to review them. Wait for a decision.`);
    const since = new Date(this.now().getTime() - HOUR_MS).toISOString();
    const hour = db.prepare('SELECT count(*) AS n FROM persona_proposals WHERE actor = ? AND created_at > ?').get(`session:${ctx.sessionId}`, since) as { n: number };
    if (Number(hour.n) >= PERSONA_PROPOSAL_LIMITS.perHour) throw new AppError('RATE_LIMITED', `At most ${PERSONA_PROPOSAL_LIMITS.perHour} proposals an hour. Try again later.`);
  }

  #create(ctx: ProposalContext, poolId: string, kind: PersonaProposalKind, payload: Record<string, unknown>, reason: string, meta: PersonaMeta, base: number | null) {
    const db = this.#db;
    const fingerprint = createHash('sha256').update(JSON.stringify([poolId, kind, kind === 'instructions' ? (payload.edits as unknown) : payload])).digest('hex');
    const same = db.prepare("SELECT * FROM persona_proposals WHERE pool_id = ? AND fingerprint = ? AND status = 'pending'").get(poolId, fingerprint) as unknown as Row | undefined;
    if (same) return { proposal: this.#view(same), duplicate: true };
    this.#limits(ctx, poolId, fingerprint);
    const id = newId();
    const at = this.now().toISOString();
    db.prepare(
      `INSERT INTO persona_proposals (id, pool_id, kind, status, actor, workspace_id, session_id, reason, payload, fingerprint, base_revision, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, poolId, kind, `session:${ctx.sessionId}`, ctx.workspaceId, ctx.sessionId, reason, JSON.stringify(payload), fingerprint, base, at);
    this.pools.onChange();
    // A name or an avatar is cosmetic: the persona's own switch may let it through. Instructions never are.
    if (kind !== 'instructions' && meta.agentsMayPropose && meta.autoApproveCosmetic) return { proposal: this.decide(id, 'approve', 'auto'), duplicate: false };
    return { proposal: this.#view(this.#row(id)), duplicate: false };
  }

  /* ---------- What a person decides ---------- */

  #row(id: string): Row {
    const row = this.#db.prepare('SELECT * FROM persona_proposals WHERE id = ?').get(id) as unknown as Row | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'That proposal no longer exists.');
    return row;
  }

  /** Why a waiting proposal can't be applied now (the persona changed since), or null. */
  #problem(row: Row): string | null {
    if (this.pools.typeOf(row.pool_id) !== 'persona') return 'The persona no longer exists.';
    const payload = JSON.parse(row.payload) as { name?: string; avatar?: string; edits?: InstructionsPatch };
    try {
      if (row.kind === 'name') {
        if (payload.name === this.pools.get(row.pool_id).name) return 'It already has that name.';
        this.#nameFree(payload.name ?? '', row.pool_id);
      } else if (row.kind === 'avatar') {
        if (!payload.avatar || !this.identity.hasAvatar(payload.avatar)) return 'The image is gone. Ask for it again.';
      } else {
        const current = this.#current(row.pool_id);
        this.#after(current.content, payload.edits ?? {});
      }
      return null;
    } catch (e) {
      return e instanceof AppError ? e.message : 'It can’t be applied.';
    }
  }

  #view(row: Row): PersonaProposal {
    const payload = JSON.parse(row.payload) as { name?: string; avatar?: string; edits?: InstructionsPatch; before?: string; after?: string };
    const pending = row.status === 'pending';
    const problem = pending ? this.#problem(row) : null;
    let instructions: PersonaProposal['instructions'] = null;
    if (row.kind === 'instructions') {
      // Waiting: against what is current now, which is what approving would change. Decided: as it was proposed.
      const live = pending ? this.pools.currentContent<PersonaContent>(row.pool_id, 'persona') : null;
      let after = payload.after ?? '';
      if (live) {
        try {
          after = applyPatch(live.content.instructions, payload.edits ?? {});
        } catch {
          // stale: the stored text is the best account of what was asked
        }
      }
      instructions = { before: live ? live.content.instructions : (payload.before ?? ''), after };
    }
    return {
      id: row.id,
      poolId: row.pool_id,
      kind: row.kind,
      status: row.status,
      actor: row.actor,
      workspaceId: row.workspace_id,
      reason: row.reason,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
      name: payload.name ?? null,
      avatar: this.identity.avatarUrl(payload.avatar ?? null),
      instructions,
      problem,
    };
  }

  list(filter: { poolId?: string; status?: PersonaProposalStatus } = {}): PersonaProposal[] {
    const where = [filter.poolId ? 'pool_id = ?' : '1=1', filter.status ? 'status = ?' : '1=1'];
    const params = [filter.poolId, filter.status].filter((v): v is string => v !== undefined);
    const rows = this.#db.prepare(`SELECT * FROM persona_proposals WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`).all(...params) as unknown as Row[];
    return rows.map((r) => this.#view(r));
  }

  /**
   * A person's decision (`by` is `Admin`), or `auto` for the persona's own switch. Approving applies the change; one
   * that can't be applied any more becomes `stale` and is refused with the reason.
   */
  decide(id: string, verb: 'approve' | 'reject', by: string): PersonaProposal {
    const row = this.#row(id);
    if (row.status !== 'pending') throw new AppError('CONFLICT', `That proposal was already ${row.status}.`);
    const db = this.#db;
    const at = this.now().toISOString();
    if (verb === 'reject') {
      db.prepare("UPDATE persona_proposals SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ?").run(at, by, id);
      this.identity.collect(this.now());
      this.pools.onChange();
      return this.#view(this.#row(id));
    }
    const problem = this.#problem(row);
    if (problem) {
      db.prepare("UPDATE persona_proposals SET status = 'stale', decided_at = ?, decided_by = ? WHERE id = ?").run(at, by, id);
      throw new AppError('CONFLICT', problem);
    }
    const payload = JSON.parse(row.payload) as { name?: string; avatar?: string; edits?: InstructionsPatch };
    const who = by === 'auto' ? 'auto-approved' : `approved by ${by}`;
    if (row.kind === 'name') this.pools.update(row.pool_id, { name: payload.name });
    else if (row.kind === 'avatar') this.identity.setAvatar(row.pool_id, payload.avatar ?? null);
    else {
      const current = this.#current(row.pool_id);
      const after = this.#after(current.content, payload.edits ?? {});
      this.pools.update(row.pool_id, { content: { ...current.content, instructions: after }, note: `Proposed by ${row.actor}, ${who}: ${row.reason}`.slice(0, 500) });
    }
    db.prepare("UPDATE persona_proposals SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?").run(at, by, id);
    this.pools.onChange();
    return this.#view(this.#row(id));
  }
}
