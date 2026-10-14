// Chat sessions: the plain HTTP routes (chat-sessions PRD §10.5, CHAT_API). No auth middleware here —
// the owner mounts this under a guarded group (`requireSession`) at /api/chat/sessions.

import { AppError, success } from '@isnanme/core';
import { createHash } from 'node:crypto';
import {
  sessionRef,
  type ChatWorktreeRemoval,
  type CreateChatSessionRequest,
  type CreateWorkspaceClaudeRequest,
  type EnterBypassRequest,
  type ReauthRequest,
  type RecoverChatRequest,
  type RestartChatRequest,
  type SwitchChatRequest,
  type UpdateChatSessionRequest,
  type UpdateRestartHintRequest,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { actorOf, actorString, requireCan } from '../authz/seam.js';
import { RateLimiter } from '../rateLimit.js';
import { serveBlob } from './artifacts/index.js';
import type { ChatController } from './controller.js';
import type { Reauth } from './reauth.js';

/** The sign-in a request belongs to: `requireSession` (app.ts) put its token on the context. */
const tokenOf = (c: Context): string | undefined => (c as unknown as Context<{ Variables: { token?: string } }>).get('token');

async function body<T>(c: Context): Promise<Partial<T>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' ? (value as Partial<T>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

/** `?worktree=` of a delete or an archive: keep the chat's worktree (the default), remove it when nothing is lost, or remove it and discard what is there. */
function worktreeMode(raw: string | undefined): ChatWorktreeRemoval {
  if (raw === undefined || raw === '') return 'keep';
  if (raw === 'keep' || raw === 'remove' || raw === 'force') return raw;
  throw new AppError('VALIDATION_FAILED', 'worktree is keep, remove or force.', { details: { worktree: 'Use keep, remove or force.' } });
}

/** `?children=end` on an end, a delete or an archive: also end the sessions this one started; absent, they are left running. */
function childrenMode(raw: string | undefined): 'end' | undefined {
  if (raw === undefined || raw === '' || raw === 'keep') return undefined;
  if (raw === 'end') return 'end';
  throw new AppError('VALIDATION_FAILED', 'children is keep or end.', { details: { children: 'Use keep or end.' } });
}

/** Builds the chat-session routes around a shared {@link ChatController}. Mount under a guarded group. */
export function createChatRoutes(controller: ChatController): Hono {
  const chat = new Hono();

  // GET /api/chat/sessions — sessions, newest activity first.
  chat.get('/', (c) => c.json(success(controller.list({ parentId: c.req.query('parentId') || undefined }))));

  // POST /api/chat/sessions — create one (starts the host in the background); 409 FOLDER_UNTRUSTED with the scan first when the folder needs trusting.
  chat.post('/', async (c) => {
    const req = await body<CreateChatSessionRequest>(c);
    if (typeof req.workspaceId !== 'string' || !req.workspaceId.trim()) throw new AppError('VALIDATION_FAILED', 'Pick a workspace.', { details: { workspaceId: 'Required.' } });
    // Only the person's own request can ask for Bypass to be allowed later in the session (FR20); the policy decides.
    return c.json(success(await controller.create(req, { bypassOptIn: req.allowBypass === true })), 201);
  });

  // GET /api/chat/sessions/:id — one session.
  chat.get('/:id', (c) => {
    const session = controller.get(c.req.param('id'));
    if (!session) throw new AppError('NOT_FOUND', 'No such session.');
    return c.json(success(session));
  });

  // POST /api/chat/sessions/:id/switch — confirmed move of the chat to another Claude on the same workspace (the chat stays this session).
  chat.post('/:id/switch', async (c) => {
    const req = await body<SwitchChatRequest>(c);
    if (typeof req.claudeId !== 'string' || !req.claudeId.trim()) throw new AppError('VALIDATION_FAILED', 'Pick a Claude.', { details: { claudeId: 'Required.' } });
    if (req.model !== undefined && typeof req.model !== 'string') throw new AppError('VALIDATION_FAILED', 'Pick a model.', { details: { model: 'Expected a model name.' } });
    return c.json(success(await controller.switchClaude(c.req.param('id'), req.claudeId, { handoff: req.handoff, ...(req.model ? { model: req.model } : {}) })));
  });

  // GET /api/chat/sessions/:id/switch-options — where it can move and whether each Claude can take it now.
  chat.get('/:id/switch-options', async (c) => c.json(success(await controller.switchOptions(c.req.param('id')))));

  // GET /api/chat/sessions/:id/bypass — where Bypass stands (policy, the session's opt-in, whether it's on, what the confirmation may claim).
  chat.get('/:id/bypass', (c) => c.json(success(controller.bypassState(c.req.param('id'), tokenOf(c)))));
  // POST /api/chat/sessions/:id/bypass — turn it on: the policy, the opt-in, the tick, and the server code checked again.
  chat.post('/:id/bypass', async (c) => {
    const req = await body<EnterBypassRequest>(c);
    return c.json(success(await controller.enterBypass(c.req.param('id'), { acknowledged: req.acknowledged === true, sessionToken: tokenOf(c) })));
  });
  // POST /api/chat/sessions/:id/bypass/allow — restart it so it can enter Bypass (at a turn boundary); the policy must allow it.
  chat.post('/:id/bypass/allow', async (c) => c.json(success(await controller.allowBypass(c.req.param('id')))));
  // POST /api/chat/sessions/:id/restart — stop its process at a turn boundary and resume the same conversation (MCP servers reconnect).
  chat.post('/:id/restart', async (c) => {
    requireCan(actorOf(c), 'operate', sessionRef(c.req.param('id')));
    const req = await body<RestartChatRequest>(c);
    // T-102: `when: 'turn_end'` queues it for the next boundary; `interrupt` lets "Restart now" stop a running turn (the person confirmed it).
    return c.json(success(await controller.restart(c.req.param('id'), { why: req.why, when: req.when, interrupt: req.interrupt === true })));
  });
  // POST /api/chat/sessions/:id/recover — bring a session ended for integrity back in place (T-136): the same row, its conversation resumed.
  // A person's sign-in is a person unless the body says `by: 'agent'` (the dev supervisor), which only makes it stricter: an agent never
  // recovers a suspicious cause, and only a person's `confirm` counts.
  chat.post('/:id/recover', async (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'operate', sessionRef(c.req.param('id')));
    const req = c.req.header('content-length') === '0' ? {} : await body<RecoverChatRequest>(c).catch(() => ({}) as Partial<RecoverChatRequest>);
    const by = req.by === 'agent' || actor.kind !== 'user' ? 'agent' : 'person';
    return c.json(success(await controller.recover(c.req.param('id'), { by, confirm: by === 'person' && req.confirm === true, actor: actor.kind === 'user' ? 'ui' : actorString(actor) })));
  });
  // POST /api/chat/sessions/:id/requests/:requestId/clear — clear a request no process can answer any more (T-284): resolved `stale` with
  // every other stale request of the chat, audited; refused (409) for a request of the live process, which is answered instead.
  chat.post('/:id/requests/:requestId/clear', async (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'operate', sessionRef(c.req.param('id')));
    return c.json(success(await controller.clearRequest(c.req.param('id'), c.req.param('requestId'), { actor: actor.kind === 'user' ? 'ui' : actorString(actor) })));
  });
  // DELETE /api/chat/sessions/:id/restart — cancel a restart that waits for the turn's end (T-102).
  chat.delete('/:id/restart', (c) => {
    requireCan(actorOf(c), 'operate', sessionRef(c.req.param('id')));
    return c.json(success(controller.cancelRestart(c.req.param('id'))));
  });
  // PATCH /api/chat/sessions/:id/restart-hint — the "Tools changed" hint's memory: hidden until the next change, and applying changes by itself (T-102).
  chat.patch('/:id/restart-hint', async (c) => {
    requireCan(actorOf(c), 'operate', sessionRef(c.req.param('id')));
    const req = await body<UpdateRestartHintRequest>(c);
    return c.json(success(controller.setRestartHint(c.req.param('id'), { hidden: req.hidden, autoApply: req.autoApply })));
  });

  // GET /api/chat/sessions/:id/segments — the runs of the chat on Claudes.
  chat.get('/:id/segments', (c) => c.json(success(controller.segments(c.req.param('id')))));

  // PATCH /api/chat/sessions/:id — rename it.
  chat.patch('/:id', async (c) => {
    const req = await body<UpdateChatSessionRequest>(c);
    return c.json(success(controller.rename(c.req.param('id'), req.title)));
  });

  // DELETE /api/chat/sessions/:id — delete it (ending it first): the transcript and its files go.
  chat.delete('/:id', async (c) => c.json(success(await controller.delete(c.req.param('id'), { worktree: worktreeMode(c.req.query('worktree')), children: childrenMode(c.req.query('children')) }))));

  // POST /api/chat/sessions/:id/end — end it.
  chat.post('/:id/end', async (c) => {
    await controller.end(c.req.param('id'), { children: childrenMode(c.req.query('children')) });
    return c.json(success({ ok: true }));
  });

  // POST /api/chat/sessions/:id/archive — archive it (ends it first); DELETE unarchives.
  chat.post('/:id/archive', async (c) => c.json(success(await controller.archive(c.req.param('id'), { worktree: worktreeMode(c.req.query('worktree')), children: childrenMode(c.req.query('children')) }))));
  // GET /api/chat/sessions/:id/worktree — what removing the chat's worktree would lose (null when it has none).
  chat.get('/:id/worktree', async (c) => c.json(success(await controller.worktreeStatus(c.req.param('id')))));
  chat.delete('/:id/archive', (c) => c.json(success(controller.unarchive(c.req.param('id')))));
  // POST /api/chat/sessions/:id/pin — pin it; DELETE unpins.
  chat.post('/:id/pin', (c) => c.json(success(controller.pin(c.req.param('id')))));
  chat.delete('/:id/pin', (c) => c.json(success(controller.unpin(c.req.param('id')))));

  // GET /api/chat/sessions/:id/events?after=<seq> — stored transcript events (history and resume).
  chat.get('/:id/events', (c) => c.json(success(controller.history(c.req.param('id'), Number(c.req.query('after') ?? 0) || 0))));

  // GET /api/chat/sessions/:id/models — what the session can switch to (asks Claude Code; resumes it if needed).
  chat.get('/:id/models', async (c) => c.json(success(await controller.models(c.req.param('id')))));

  // GET /api/chat/sessions/:id/tasks — sub-agents and background tasks.
  chat.get('/:id/tasks', (c) => c.json(success(controller.tasks(c.req.param('id')))));

  // GET /api/chat/sessions/:id/tasks/:taskId/events?after=<seq> — one sub-agent's own transcript (bounded), for whoever may view the session.
  chat.get('/:id/tasks/:taskId/events', (c) => {
    requireCan(actorOf(c), 'view', sessionRef(c.req.param('id')));
    return c.json(success(controller.taskTranscript(c.req.param('id'), c.req.param('taskId'), Number(c.req.query('after') ?? 0) || 0)));
  });

  // GET /api/chat/sessions/:id/blobs/:blobId — a stored file's bytes (attachment, artifact, tool image), only when this
  // session links it: inline for the types a browser may show or play (Range answered), a download for the rest.
  chat.get('/:id/blobs/:blobId', (c) => serveBlob(c.req.raw, controller.blobFile(c.req.param('id'), c.req.param('blobId')), { download: c.req.query('download') === '1' }));

  return chat;
}

/**
 * `/api/chat/reauth`, `/policy` and `/audit`: the server code checked again (guards Bypass), what the chat policy allows,
 * and the audit trail. Mount at `/api/chat` behind the sign-in guard.
 */
export function createChatMetaRoutes(controller: ChatController, reauth: Reauth): Hono {
  const meta = new Hono();
  // Guessing the code through this door is as bad as through the sign-in: a few tries per sign-in.
  const limiter = new RateLimiter(10, 10 * 60_000);
  meta.post('/reauth', async (c) => {
    const token = tokenOf(c);
    const key = createHash('sha256').update(token ?? '').digest('hex');
    if (limiter.blocked(key)) throw new AppError('RATE_LIMITED', 'Too many tries. Wait a few minutes.');
    const req = await body<ReauthRequest>(c);
    if (!reauth.confirm(token, req.code)) {
      limiter.fail(key);
      // Not a 401: the sign-in is fine, and a client takes a 401 to mean it ended.
      throw new AppError('FORBIDDEN', 'That code isn’t right.');
    }
    limiter.reset(key);
    return c.json(success({ ok: true }));
  });
  // GET /api/chat/worktrees?workspaceId=&folder= — a workspace's worktrees; `folder` (in a repository) also lists the others git has.
  meta.get('/worktrees', async (c) => {
    const workspaceId = c.req.query('workspaceId')?.trim();
    if (!workspaceId) throw new AppError('VALIDATION_FAILED', 'Pick a workspace.', { details: { workspaceId: 'Required.' } });
    return c.json(success(await controller.worktrees(workspaceId, c.req.query('folder')?.trim() || undefined)));
  });
  meta.get('/policy', (c) => c.json(success({ bypass: { allowed: controller.bypassAllowed?.() === true } })));
  meta.get('/audit', (c) => {
    const limit = Number(c.req.query('limit'));
    return c.json(success(controller.audit({ kind: c.req.query('kind') || undefined, sessionId: c.req.query('sessionId') || undefined, limit: Number.isFinite(limit) && limit > 0 ? limit : undefined })));
  });
  return meta;
}

/** Claudes on a workspace. Mount at `/api/chat/claudes`. */
/** `GET /api/chat/usage?range=&claudeId=&tz=`: usage over time, for the Usage charts. */
export function createUsageRoutes(controller: ChatController): Hono {
  const usage = new Hono();
  usage.get('/', (c) => {
    const tz = Number(c.req.query('tz'));
    return c.json(success(controller.usage(c.req.query('range'), { claudeId: c.req.query('claudeId') || undefined, tzOffsetMin: Number.isFinite(tz) ? tz : 0 })));
  });
  return usage;
}

export function createClaudeRoutes(controller: ChatController): Hono {
  const claudes = new Hono();
  claudes.get('/', async (c) => c.json(success(await controller.claudesOf(c.req.query('workspaceId') ?? ''))));
  claudes.post('/', async (c) => {
    const req = await body<CreateWorkspaceClaudeRequest>(c);
    if (typeof req.workspaceId !== 'string' || !req.workspaceId.trim()) throw new AppError('VALIDATION_FAILED', 'Pick a workspace.', { details: { workspaceId: 'Required.' } });
    if (typeof req.name !== 'string') throw new AppError('VALIDATION_FAILED', 'Name the Claude.', { details: { name: 'Required.' } });
    return c.json(success(await controller.createClaude(req.workspaceId, req.name)), 201);
  });
  return claudes;
}
