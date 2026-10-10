// Chat sessions: the folder trust routes (CHAT_API.scan, CHAT_API.trust; PRD FR43). No auth middleware
// here — the owner mounts this under a guarded group at /api/chat/trust. Trust is granted only here, by a
// signed-in person; Portal MCP clients have no route to it.

import { AppError, success } from '@isnanme/core';
import type { ChatTrustRequest } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import type { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import type { ChatController } from './controller.js';
import { scanFolder, trustFolder, type TrustOptions } from './trust.js';

export interface ChatTrustRoutesDeps {
  controller: Pick<ChatController, 'installHost'>;
  workspaces: Workspaces;
  store: Store;
}

async function body<T>(c: Context): Promise<Partial<T>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' ? (value as Partial<T>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

/** Builds the folder trust routes. Mount under a guarded group. */
export function createChatTrustRoutes(deps: ChatTrustRoutesDeps): Hono {
  const trust = new Hono();
  // The host must know `trustscan`. Read at call time: the owner sets `installHost` after constructing
  // the controller (it shares one install per workspace), and tests leave it unset.
  const opts: TrustOptions = { install: (workspaceId) => deps.controller.installHost?.(workspaceId) ?? Promise.resolve() };

  // GET /api/chat/trust/scan?workspaceId=&folder= — what the folder would load, and whether that exact scan is trusted.
  trust.get('/scan', async (c) => {
    const workspaceId = c.req.query('workspaceId') ?? '';
    const folder = c.req.query('folder') ?? '';
    return c.json(success(await scanFolder(deps.workspaces, deps.store, workspaceId, folder, opts)));
  });

  // POST /api/chat/trust — trust a folder as scanned; a 409 FOLDER_UNTRUSTED carries the new scan when it changed since.
  trust.post('/', async (c) => {
    const req = await body<ChatTrustRequest>(c);
    await trustFolder(deps.workspaces, deps.store, req, { ...opts, actor: 'ui' });
    return c.json(success({ ok: true }));
  });

  return trust;
}
