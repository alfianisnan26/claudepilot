// Chat sessions: the plain HTTP routes (chat-sessions PRD §10.5, CHAT_API). No auth middleware here —
// the owner mounts this under a guarded group (`requireSession`) at /api/chat/sessions.

import { AppError, success } from '@isnanme/core';
import type { CreateChatSessionRequest } from '@portal/contracts';
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

  // POST /api/chat/sessions — create one (starts the host in the background).
  chat.post('/', async (c) => {
    const req = await body<CreateChatSessionRequest>(c);
    if (typeof req.workspaceId !== 'string' || !req.workspaceId.trim()) throw new AppError('VALIDATION_FAILED', 'Pick a workspace.', { details: { workspaceId: 'Required.' } });
    return c.json(success(controller.create(req)), 201);
  });

  // GET /api/chat/sessions/:id — one session.
  chat.get('/:id', (c) => {
    const session = controller.get(c.req.param('id'));
    if (!session) throw new AppError('NOT_FOUND', 'No such session.');
    return c.json(success(session));
  });

  // DELETE /api/chat/sessions/:id — end it.
  chat.delete('/:id', async (c) => {
    await controller.end(c.req.param('id'));
    return c.json(success({ ok: true }));
  });

  // GET /api/chat/sessions/:id/events?after=<seq> — stored transcript events (history and resume).
  chat.get('/:id/events', (c) => c.json(success(controller.history(c.req.param('id'), Number(c.req.query('after') ?? 0) || 0))));

  return chat;
}
