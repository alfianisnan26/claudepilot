// The kinds an approval can be (docs/prd/approvals.md): one schema and ONE executor each. Allow runs the stored payload through its kind's
// executor as the portal; nothing else runs it. A payload names things (a session id, a secret's NAME), never a secret value.

import { AppError } from '@isnanme/core';
import { REAUTH_REQUIRED, sessionRef, type Actor, type ApprovalKind, type ApprovalResult, type AttentionWhy, type ChatSession } from '@portal/contracts';
import { z } from 'zod';
import { requireCan } from '../authz/seam.js';

/** What the chat controller gives the approvals module: Bypass through its own gated path, a session's facts, and messages to a session. */
export interface ApprovalChat {
  enterBypass(rawId: string, req: { acknowledged: boolean; sessionToken: string | undefined; actor?: string; via?: { approvalId: string } }): Promise<ChatSession>;
  get(id: string): Pick<ChatSession, 'id' | 'title' | 'workspaceId' | 'bypassCapable' | 'mode' | 'state'> | null | undefined;
  send(sessionId: string, uuid: string, text: string, opts: { actor: string; actorLabel: string; priority: 'next' | 'later' }): Promise<unknown>;
  /** The server code re-check of the signed-in person (Bypass needs it fresh). Absent: nothing that needs it can be allowed. */
  reauth?: { fresh(token: string | undefined): boolean };
}

/** Who asks, verified (an agent's token), or null when the portal asks for one of its own refusals. */
export interface ApprovalRequester {
  sessionId: string;
  workspaceId: string | null;
}

/** What an executor gets besides its payload. */
export interface ApprovalRunContext {
  approvalId: string;
  /** The person who clicked Allow. */
  actor: Actor;
  /** Their sign-in, for a kind that needs a fresh server code. */
  sessionToken: string | undefined;
  chat: ApprovalChat | null;
}

export interface ApprovalKindDef {
  kind: ApprovalKind;
  schema: z.ZodType<Record<string, unknown>>;
  /** The Needs you class (D-10) of a request of this kind. */
  why: AttentionWhy;
  /** One line for the card and the push: names and facts only. */
  title(payload: Record<string, unknown>, chat: ApprovalChat | null): string;
  /** Checked when an agent asks: what it may ask for (throws NOT_FOUND / VALIDATION_FAILED). */
  mayAsk?(payload: Record<string, unknown>, requester: ApprovalRequester | null): void;
  /**
   * Checked at Allow BEFORE the request is consumed (a refusal here leaves it pending, so the person can fix it and click again):
   * the person's rights on the object, a fresh server code.
   */
  precheck?(payload: Record<string, unknown>, ctx: ApprovalRunContext): void;
  /** Runs the payload, once. A failure is a result (`ok: false`), not a throw: the request is consumed either way. */
  run(payload: Record<string, unknown>, ctx: ApprovalRunContext): Promise<ApprovalResult>;
}

const SESSION_ID = z.string().trim().min(1).max(200);

const testEcho: ApprovalKindDef = {
  kind: 'test.echo',
  schema: z.object({ text: z.string().max(200) }).strict(),
  why: 'gate',
  title: (p) => `Test: ${String(p.text ?? '')}`,
  run: async (p) => ({ ok: true, message: 'Echoed.', output: { text: String(p.text ?? '') } }),
};

const sessionBypass: ApprovalKindDef = {
  kind: 'session.bypass',
  schema: z.object({ sessionId: SESSION_ID }).strict(),
  why: 'secrets_permissions',
  title: (p, chat) => {
    const id = String(p.sessionId ?? '');
    const s = chat?.get(id);
    return `Bypass for ${s?.title?.trim() || `session ${id.slice(0, 8)}`}`;
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

export const APPROVAL_KIND_DEFS: Record<ApprovalKind, ApprovalKindDef> = {
  'test.echo': testEcho,
  'session.bypass': sessionBypass,
};
