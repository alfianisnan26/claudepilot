// Chat sessions: the plain HTTP routes (chat-sessions PRD §10.5, CHAT_API). No auth middleware here —
// the owner mounts this under a guarded group (`requireSession`) at /api/chat/sessions.

import { AppError, success } from '@isnanme/core';
import type { CreateChatSessionRequest, CreateWorkspaceClaudeRequest, TransferChatRequest } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import type { ChatController } from './controller.js';

async function body<T>(c: Context): Promise<Partial<T>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' ? (value as Partial<T>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

/** Builds the chat-session routes around a shared {@link ChatController}. Mount under a guarded group. */
export function createChatRoutes(controller: ChatController): Hono {
  const chat = new Hono();

  // GET /api/chat/sessions — sessions, newest activity first.
  chat.get('/', (c) => c.json(success(controller.list())));

  // POST /api/chat/sessions — create one (starts the host in the background); 409 FOLDER_UNTRUSTED with the scan first when the folder needs trusting.
  chat.post('/', async (c) => {
    const req = await body<CreateChatSessionRequest>(c);
    if (typeof req.workspaceId !== 'string' || !req.workspaceId.trim()) throw new AppError('VALIDATION_FAILED', 'Pick a workspace.', { details: { workspaceId: 'Required.' } });
    return c.json(success(await controller.create(req)), 201);
  });

  // GET /api/chat/sessions/:id — one session.
  chat.get('/:id', (c) => {
    const session = controller.get(c.req.param('id'));
    if (!session) throw new AppError('NOT_FOUND', 'No such session.');
    return c.json(success(session));
  });

  // POST /api/chat/sessions/:id/transfer — confirmed context move to another Claude on the same workspace.
  chat.post('/:id/transfer', async (c) => {
    const req = await body<TransferChatRequest>(c);
    if (typeof req.claudeId !== 'string' || !req.claudeId.trim()) throw new AppError('VALIDATION_FAILED', 'Pick a Claude.', { details: { claudeId: 'Required.' } });
    return c.json(success(await controller.transfer(c.req.param('id'), req.claudeId)));
  });

  // DELETE /api/chat/sessions/:id — end it.
  chat.delete('/:id', async (c) => {
    await controller.end(c.req.param('id'));
    return c.json(success({ ok: true }));
  });

  // GET /api/chat/sessions/:id/events?after=<seq> — stored transcript events (history and resume).
  chat.get('/:id/events', (c) => c.json(success(controller.history(c.req.param('id'), Number(c.req.query('after') ?? 0) || 0))));

  // GET /api/chat/sessions/:id/models — what the session can switch to (asks Claude Code; resumes it if needed).
  chat.get('/:id/models', async (c) => c.json(success(await controller.models(c.req.param('id')))));

  // GET /api/chat/sessions/:id/tasks — sub-agents and background tasks.
  chat.get('/:id/tasks', (c) => c.json(success(controller.tasks(c.req.param('id')))));

  // GET /api/chat/sessions/:id/blobs/:blobId — an image's bytes, only when this session links it.
  chat.get('/:id/blobs/:blobId', (c) => {
    const blob = controller.blob(c.req.param('id'), c.req.param('blobId'));
    if (!blob) throw new AppError('NOT_FOUND', 'No such image.');
    return c.body(blob.bytes, 200, {
      'Content-Type': blob.mediaType,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      // Content-addressed: the bytes behind an id never change.
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });

  return chat;
}

/** Claudes on a workspace. Mount at `/api/chat/claudes`. */
export function createClaudeRoutes(controller: ChatController): Hono {
  const claudes = new Hono();
  claudes.get('/', (c) => c.json(success(controller.listClaudes(c.req.query('workspaceId') ?? ''))));
  claudes.post('/', async (c) => {
    const req = await body<CreateWorkspaceClaudeRequest>(c);
    if (typeof req.workspaceId !== 'string' || !req.workspaceId.trim()) throw new AppError('VALIDATION_FAILED', 'Pick a workspace.', { details: { workspaceId: 'Required.' } });
    if (typeof req.name !== 'string') throw new AppError('VALIDATION_FAILED', 'Name the Claude.', { details: { name: 'Required.' } });
    return c.json(success(await controller.createClaude(req.workspaceId, req.name)), 201);
  });
  return claudes;
}
