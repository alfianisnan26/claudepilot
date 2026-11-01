// The bulk form of relocation (owner request 2026-11-01, decommissioning workspaces): every session of a plan moves off one workspace.
// Mounted in the guarded workspaces group at /api/workspaces; declared in chat/authz.ts (CHAT_RELOCATE_POLICIES).

import { AppError, isAppError, success } from '@isnanme/core';
import {
  CHAT_RELOCATE_PLAN_MAX,
  type ChatRelocation,
  type RelocateSessionsRequest,
  type RelocateSessionsResult,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { actorOf, actorString } from '../authz/seam.js';
import { declareChatRelocatePolicies, requireRelocateRight } from './authz.js';
import type { ChatController } from './controller.js';
import { checkCwdMap } from './relocate.js';

async function body(c: Context): Promise<Partial<RelocateSessionsRequest>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' ? (value as Partial<RelocateSessionsRequest>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

/**
 * POST /api/workspaces/:target/:name/relocate-sessions `RelocateSessionsRequest` → `RelocateSessionsResult`: the platform admin only (anyone
 * else: 404). Each plan item names a session ON THIS workspace (one that is not is refused as missing) and where it goes; each is decided
 * and applied on its own (its own savepoint and audit row), in plan order, so one refusal (a running session, an unknown Claude) never holds
 * up the others and running the same plan again is a no-op for the ones already moved (`unchanged`). `dryRun` changes nothing. The plan
 * itself (shape, size, cwdMap) is checked whole before any item runs. What the ops step copies per session: each item's `files`, and the
 * single route's doc in chat/routes.ts.
 */
export function createSessionRelocateRoutes(controller: ChatController): Hono {
  declareChatRelocatePolicies();
  const app = new Hono();
  app.post('/:target/:name/relocate-sessions', async (c) => {
    const actor = actorOf(c);
    requireRelocateRight(actor);
    const from = `${c.req.param('target')}/${c.req.param('name')}`;
    const req = await body(c);
    const plan = req.plan;
    if (!Array.isArray(plan) || plan.length === 0)
      throw new AppError('VALIDATION_FAILED', 'Give a plan: [{ sessionId, workspaceId, claudeId }].', { details: { plan: 'Required.' } });
    if (plan.length > CHAT_RELOCATE_PLAN_MAX)
      throw new AppError('VALIDATION_FAILED', `At most ${CHAT_RELOCATE_PLAN_MAX} sessions in one plan.`, { details: { plan: 'Too long.' } });
    const shared = checkCwdMap(req.cwdMap);
    const items = plan.map((raw, i) => {
      const item = raw && typeof raw === 'object' ? raw : null;
      if (!item || typeof item.sessionId !== 'string' || !item.sessionId.trim())
        throw new AppError('VALIDATION_FAILED', `Plan item ${i + 1} names no session.`, { details: { plan: `Item ${i + 1}: sessionId is required.` } });
      return { ...item, sessionId: item.sessionId.trim(), cwdMap: checkCwdMap(item.cwdMap) ?? shared };
    });
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.sessionId))
        throw new AppError('VALIDATION_FAILED', 'A session is named twice in the plan.', { details: { plan: `Twice: ${item.sessionId}.` } });
      seen.add(item.sessionId);
    }
    const dryRun = req.dryRun === true;
    const asker = actor.kind === 'user' ? 'ui' : actorString(actor);
    const out: ChatRelocation[] = [];
    for (const item of items) {
      try {
        out.push(
          await controller.relocate(
            item.sessionId,
            { workspaceId: item.workspaceId, claudeId: item.claudeId, ...(item.cwdMap ? { cwdMap: item.cwdMap } : {}) },
            { dryRun, actor: asker, expectFrom: from },
          ),
        );
      } catch (e) {
        if (!isAppError(e)) throw e;
        out.push({ sessionId: item.sessionId, status: 'refused', from: null, to: null, counts: null, files: null, error: { code: e.code, message: e.message } });
      }
    }
    return c.json(success<RelocateSessionsResult>({ dryRun, items: out }));
  });
  return app;
}
