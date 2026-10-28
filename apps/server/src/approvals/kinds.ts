// The kinds an approval can be (docs/prd/approvals.md): one schema and ONE executor each. Allow runs the stored payload through its kind's
// executor as the portal; nothing else runs it. A payload names things (a session id, a secret's NAME), never a secret value.

import { AppError } from '@isnanme/core';
import {
  poolRef,
  REAUTH_REQUIRED,
  SECRET_LIMITS,
  secretExposeDefault,
  sessionRef,
  type Actor,
  type ApprovalKind,
  type ApprovalResult,
  type AttentionWhy,
  type ChatSession,
  type PoolDetail,
  type SecretEntryInput,
  type SecretEntryView,
} from '@portal/contracts';
import { z } from 'zod';
import { clip } from '../attention/registry.js';
import { requireCan } from '../authz/seam.js';
import { secretWriteAccess } from '../pools/authz.js';
import type { PoolService } from '../pools/service.js';
import { PASS_TTL_MS, passOf, refusedByJobRun, wasRedacted } from './pass.js';

/** What the chat controller gives the approvals module: Bypass through its own gated path, a session's facts, and messages to a session. */
export interface ApprovalChat {
  enterBypass(rawId: string, req: { acknowledged: boolean; sessionToken: string | undefined; actor?: string; via?: { approvalId: string } }): Promise<ChatSession>;
  get(id: string): Pick<ChatSession, 'id' | 'title' | 'workspaceId' | 'bypassCapable' | 'mode' | 'state'> | null | undefined;
  send(sessionId: string, uuid: string, text: string, opts: { actor: string; actorLabel: string; priority: 'next' | 'later' }): Promise<unknown>;
  /** The server code re-check of the signed-in person (Bypass needs it fresh). Absent: nothing that needs it can be allowed. */
  reauth?: { fresh(token: string | undefined): boolean };
}

/** What the pools service gives the approvals module (pool.secret_set): the same calls pool_secret_set makes. */
export type ApprovalPools = Pick<PoolService, 'types' | 'get' | 'update'>;

/** What delivery gives the approvals module (T-2889): deliver a workspace again, so a new or used pass lands in its passes file. */
export interface ApprovalDelivery {
  passesChanged(workspaceId: string): void;
}

/** The services a kind may use, wired in index.ts (absent in a test that does not need them). */
export interface ApprovalDeps {
  chat: ApprovalChat | null;
  pools: ApprovalPools | null;
  delivery?: ApprovalDelivery | null;
}

/** Who asks, verified (an agent's token), or null when the portal asks for one of its own refusals. */
export interface ApprovalRequester {
  sessionId: string;
  workspaceId: string | null;
  /** The asking agent as the authz seam knows it, for a kind that checks what it may reach (pool.secret_set). */
  actor?: Actor;
}

/** What an executor gets besides its payload. */
export interface ApprovalRunContext extends ApprovalDeps {
  approvalId: string;
  /** The workspace the request came from (null when the portal asked). */
  workspaceId?: string | null;
  /** Now, in ms (the service's clock). */
  now?: number;
  /** The person who clicked Allow. */
  actor: Actor;
  /** Their sign-in, for a kind that needs a fresh server code. */
  sessionToken: string | undefined;
  /** What the person typed on Allow for a kind that needs it (approvalNeedsValue): write-only, held in memory for this call only. */
  value?: string | undefined;
}

export interface ApprovalKindDef {
  kind: ApprovalKind;
  schema: z.ZodType<Record<string, unknown>>;
  /** The Needs you class (D-10) of a request of this kind. */
  why: AttentionWhy;
  /**
   * One line for a person's card and push: fixed words, with any name an agent could write (a session title, a pool or secret name)
   * quoted and clipped. Never the agent's free text (test.echo's text): that is only in the payload, on the card.
   */
  title(payload: Record<string, unknown>, deps: ApprovalDeps): string;
  /** Checked when an agent asks: what it may ask for (throws NOT_FOUND / VALIDATION_FAILED). */
  mayAsk?(payload: Record<string, unknown>, requester: ApprovalRequester | null, deps: ApprovalDeps): void;
  /**
   * Checked at Allow BEFORE the request is consumed (a refusal here leaves it pending, so the person can fix it and click again):
   * the person's rights on the object, a fresh server code.
   */
  precheck?(payload: Record<string, unknown>, ctx: ApprovalRunContext): void;
  /** Runs the payload, once. A failure is a result (`ok: false`), not a throw: the request is consumed either way. */
  run(payload: Record<string, unknown>, ctx: ApprovalRunContext): Promise<ApprovalResult>;
}

const SESSION_ID = z.string().trim().min(1).max(200);

/** A name an agent could have written, for a title: one line, clipped, in quotes so it reads as a name and not as the portal's words. */
export const quoted = (s: string, max = 60): string => `“${clip(s, max)}”`;

const testEcho: ApprovalKindDef = {
  kind: 'test.echo',
  schema: z.object({ text: z.string().max(200) }).strict(),
  why: 'gate',
  // The text is the agent's: it stays in the payload (the card shows it), never in a title, a push or Needs you.
  title: () => 'Test request',
  run: async (p) => ({ ok: true, message: 'Echoed.', output: { text: String(p.text ?? '') } }),
};

const sessionBypass: ApprovalKindDef = {
  kind: 'session.bypass',
  schema: z.object({ sessionId: SESSION_ID }).strict(),
  why: 'secrets_permissions',
  title: (p, { chat }) => {
    const id = String(p.sessionId ?? '');
    const t = chat?.get(id)?.title?.trim();
    return `Bypass for ${t ? quoted(t) : `session ${id.slice(0, 8)}`}`;
  },
  // An agent asks for its own session only; the portal may ask for any.
  mayAsk(p, requester) {
    if (requester && requester.sessionId !== p.sessionId) throw new AppError('NOT_FOUND', 'An agent may ask for Bypass on its own session only.');
  },
  // The person must be able to operate the session and have checked the server code within 10 minutes, as on the Bypass route itself.
  precheck(p, ctx) {
    const id = String(p.sessionId);
    requireCan(ctx.actor, 'operate', sessionRef(id));
    if (!ctx.chat) throw new AppError('SERVICE_UNAVAILABLE', 'Sessions are not available.');
    if (ctx.chat.reauth?.fresh(ctx.sessionToken) !== true) throw new AppError(REAUTH_REQUIRED, 'Enter the server code again to allow Bypass.', { status: 403 });
  },
  // The existing gated path (policy, capable, acknowledgement, fresh code), with the person's click as the acknowledgement; it audits
  // bypass.entered with actor ui and `via: approval`. A refusal (not capable, blocked by policy) is the result.
  async run(p, ctx): Promise<ApprovalResult> {
    const id = String(p.sessionId);
    try {
      const s = await ctx.chat!.enterBypass(id, { acknowledged: true, sessionToken: ctx.sessionToken, actor: 'ui', via: { approvalId: ctx.approvalId } });
      return { ok: s.mode === 'bypassPermissions', message: s.mode === 'bypassPermissions' ? 'Bypass is on.' : 'Bypass did not turn on.', output: { mode: s.mode } };
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'ERROR';
      const message = e instanceof AppError ? e.message : 'Bypass could not be turned on.';
      return { ok: false, message, output: { code } };
    }
  },
};

/** The one not-found answer for a pool, the same words pool_secret_set uses, so asking never tells a pool elsewhere exists. */
const noPool = (ref: string) => new AppError('NOT_FOUND', `No pool “${ref}”. List them with pool_list.`);

/** The secrets pool by id, or the not-found answer (also for a pool of another type, or no Secrets & env). */
function secretsPool(pools: ApprovalPools | null, id: string): PoolDetail {
  if (!pools || !pools.types().includes('secrets')) throw noPool(id);
  let p: PoolDetail;
  try {
    p = pools.get(id);
  } catch {
    throw noPool(id);
  }
  if (p.type !== 'secrets') throw noPool(id);
  return p;
}

const SECRET_NAME = z.string().trim().min(1).max(64);

/**
 * PILOT-1000: set one secret in a secrets pool the agent may not write itself (a protected pool: pool_secret_set refuses it with a hint
 * to ask here). The payload names the pool (its id), the secret, expose and the revision the agent read: NEVER the value. The person types
 * the value on Allow; it goes to this executor in memory, into the pool's encrypted store, and nowhere else (not the row, the result, the
 * audit or the message). Decided on T-2867: the alternatives (the agent sends the value; a one-shot pass for the agent) both put a
 * protected credential in an agent's hands.
 */
const poolSecretSet: ApprovalKindDef = {
  kind: 'pool.secret_set',
  schema: z
    .object({
      pool: z.string().trim().min(1).max(100),
      name: SECRET_NAME,
      expose: z.boolean().optional(),
      baseRevision: z.number().int().min(0),
    })
    .strict(),
  why: 'secrets_permissions',
  title: (p) => `Set ${quoted(String(p.name ?? ''), 64)} in a secrets pool`,
  // An agent asks only for a pool its own workspace gets (pool_secret_set's reach; a shared pool too, since a person decides): anything
  // else is the same NOT_FOUND as a pool that does not exist.
  mayAsk(p, requester, { pools }) {
    const pool = secretsPool(pools, String(p.pool));
    if (!requester) return;
    if (!requester.actor || secretWriteAccess(requester.actor, { id: pool.id, workspaces: pool.assignedTo.map((a) => a.workspaceId) }) === 'not_found')
      throw noPool(String(p.pool));
  },
  // The person must manage the pool, type a value, and the pool must still be at the revision the agent read (else the agent asks again).
  precheck(p, ctx) {
    const pool = secretsPool(ctx.pools, String(p.pool));
    requireCan(ctx.actor, 'manage', poolRef(pool.id, 'secrets'));
    const v = ctx.value;
    if (typeof v !== 'string' || v.length === 0) throw new AppError('VALIDATION_FAILED', 'Type the value to allow it.', { details: { value: 'Required.' } });
    if (Buffer.byteLength(v) > SECRET_LIMITS.secretBytes) throw new AppError('VALIDATION_FAILED', 'The value is too large.', { details: { value: 'Too large.' } });
    if (pool.latestRevision !== p.baseRevision)
      throw new AppError('CONFLICT', `The pool is at revision ${pool.latestRevision}, not ${String(p.baseRevision)}: deny this, and the agent asks again.`);
    const existing = secretEntries(pool).find((e) => e.name === p.name);
    if (existing && existing.kind !== 'secret') throw new AppError('CONFLICT', `${String(p.name)} is a plain variable in this pool, not a secret.`);
  },
  async run(p, ctx): Promise<ApprovalResult> {
    const name = String(p.name);
    try {
      const pool = secretsPool(ctx.pools, String(p.pool));
      const entries = secretEntries(pool);
      const at = entries.findIndex((e) => e.name === name);
      const found = at >= 0 ? entries[at]! : undefined;
      // An existing secret keeps its expose unless the payload names one (its stored options omit a false expose); a new one takes the
      // name's default, as pool_secret_set does.
      const keep = found?.kind === 'secret' ? found.options?.expose === true : secretExposeDefault(name);
      const expose = typeof p.expose === 'boolean' ? p.expose : keep;
      const target: SecretEntryInput = found ? { ...found, kind: 'secret', options: { ...(found.kind === 'secret' ? found.options : {}), expose }, newValue: ctx.value! } : { kind: 'secret', name, options: { expose }, newValue: ctx.value! };
      if (found) entries[at] = target;
      else entries.push(target);
      const updated = ctx.pools!.update(pool.id, { content: { entries }, note: `${name} set via approval ${ctx.approvalId}`, baseRevision: Number(p.baseRevision) });
      return { ok: true, message: `${name} set in ${updated.name}: revision ${updated.latestRevision} is ${updated.status}.`, output: { pool: updated.id, name, revision: updated.latestRevision, expose } };
    } catch (e) {
      // A refusal is the result; its words are the service's, never the value (checked, in case a message ever quoted its input).
      const said = e instanceof AppError ? e.message : 'The secret could not be set.';
      const message = ctx.value && said.includes(ctx.value) ? 'The secret could not be set.' : said;
      return { ok: false, message, output: { code: e instanceof AppError ? e.code : 'ERROR' } };
    }
  },
};

/** A secrets pool's entries as the input pool_update takes (values stay where they are; only `newValue` writes one). */
function secretEntries(p: PoolDetail): SecretEntryInput[] {
  return ((p.content as { entries?: SecretEntryView[] } | null)?.entries ?? []).map((e): SecretEntryInput =>
    e.kind === 'variable' ? { id: e.id, kind: 'variable', name: e.name, value: e.value, confirmed: e.confirmed } : { id: e.id, kind: 'secret', name: e.name, options: e.options ?? {} },
  );
}

/**
 * T-2889: Allow on a refused call issues a one-time pass for exactly that call (approvals/pass.ts). The portal does not run the command
 * itself (decided on T-2885, c43584: the job-run case would need the secret's value in a portal exec, and the output would flow back): it
 * stores the pass in the result and delivers the workspace again; the agent runs the same call, and job-run or the guard lets it through.
 */
async function issuePass(kind: ApprovalKind, p: Record<string, unknown>, ctx: ApprovalRunContext): Promise<ApprovalResult> {
  // T-2885 review M1: the outbox line is the workspace's word, not proof of a refusal. Two checks keep a forged line from buying a pass
  // for a call that was never refused: here, the request must describe a call the refuser would refuse (job-run: the name is deny-listed
  // and the arguments pass it as --pool-env; guard: nothing redacted out of it); and at use, job-run and the guard consult the pass only
  // on their own refusal path (job-run's deny branch, the guard's refuse()), after their own verdict refused that call again.
  if (kind === 'jobrun.pool_env' && !refusedByJobRun(p)) return { ok: false, message: 'No pass: job-run would not refuse this run (the name is not deny-listed, or the arguments do not pass it).' };
  if (kind === 'guard.refusal' && wasRedacted(p)) return { ok: false, message: 'No pass: parts of this call were redacted, so it is not the exact call that was refused.' };
  const pass = passOf(kind, p);
  if (!pass || !ctx.workspaceId) return { ok: false, message: 'No pass: this request has no workspace to deliver it to.' };
  if (!ctx.delivery) return { ok: false, message: 'No pass: delivery is not available; ask again later.' };
  // The service asks delivery to run once the result (which holds the pass) is stored, so the reconciler reads it.
  const until = (ctx.now ?? Date.now()) + PASS_TTL_MS;
  return {
    ok: true,
    message: `A one-time pass for this exact call reaches the workspace within a minute and lasts until ${new Date(until).toISOString()}: run the same call again, in the same folder with the same arguments; any other call is still refused.`,
    output: { pass, until: new Date(until).toISOString(), used: false },
  };
}

/** Only an agent session's refusal files these (through the outbox, or approval_request): the portal never asks for one. */
const agentOnly = (_p: Record<string, unknown>, requester: ApprovalRequester | null) => {
  if (!requester) throw new AppError('VALIDATION_FAILED', 'Only an agent session asks for this.');
};

/**
 * job-run.sh refused a deny-listed `--pool-env` name (write, admin, production or master credentials, the runner's own tokens). The
 * payload is that NAME, the run's exact arguments and its folder: what a person allows is exactly this run.
 */
const jobrunPoolEnv: ApprovalKindDef = {
  kind: 'jobrun.pool_env',
  schema: z
    .object({
      name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      args: z.array(z.string().max(2000)).min(1).max(80),
      cwd: z.string().min(1).max(300),
    })
    .strict(),
  why: 'secrets_permissions',
  title: (p) => `job-run with ${quoted(String(p.name ?? ''), 64)}`,
  mayAsk: agentOnly,
  run: (p, ctx) => issuePass('jobrun.pool_env', p, ctx),
};

/** The rule guard (D-60) refused a tool call. The payload is the tool, its exact input, the folder and the guard's form, unclipped. */
const guardRefusal: ApprovalKindDef = {
  kind: 'guard.refusal',
  schema: z
    .object({
      tool: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
      input: z.record(z.string(), z.unknown()),
      cwd: z.string().max(300),
      form: z.string().max(80),
    })
    .strict(),
  why: 'secrets_permissions',
  title: (p) => `Refused ${quoted(String(p.tool ?? ''), 40)} call`,
  mayAsk: agentOnly,
  run: (p, ctx) => issuePass('guard.refusal', p, ctx),
};

export const APPROVAL_KIND_DEFS: Record<ApprovalKind, ApprovalKindDef> = {
  'test.echo': testEcho,
  'session.bypass': sessionBypass,
  'pool.secret_set': poolSecretSet,
  'jobrun.pool_env': jobrunPoolEnv,
  'guard.refusal': guardRefusal,
};
