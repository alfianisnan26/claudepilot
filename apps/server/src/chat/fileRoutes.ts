// Chat sessions: the Files and Diff routes (CHAT_API.files, .download, .diff). No auth middleware here —
// the owner mounts this under the guarded chat group at /api/chat/sessions, next to createChatRoutes.

import { AppError, success } from '@isnanme/core';
import { Hono } from 'hono';
import type { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import type { ChatController } from './controller.js';
import { listFolder, openDownload, readDiff, sessionFolder, type FilesOptions } from './files.js';

export interface ChatFileRoutesDeps {
  controller: Pick<ChatController, 'get' | 'installHost'>;
  workspaces: Workspaces;
  store: Store;
}

/** Characters RFC 5987 lets stand in `filename*`; everything else is percent-encoded. */
const encode5987 = (s: string) => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * `attachment; filename="<name>"` with the name made safe for a quoted header value (printable ASCII,
 * no quote, backslash or percent). When that changed it, `filename*` carries the real name in UTF-8.
 */
export function attachmentHeader(name: string): string {
  const real = [...name].slice(0, 200).join('');
  const safe = real.replace(/[^\x20-\x7e]|["\\%]/g, '_').trim() || 'download';
  return safe === real ? `attachment; filename="${safe}"` : `attachment; filename="${safe}"; filename*=UTF-8''${encode5987(real)}`;
}

/** Builds the Files and Diff routes. Mount under a guarded group. */
export function createChatFileRoutes(deps: ChatFileRoutesDeps): Hono {
  const files = new Hono();

  // One host install at a time per workspace. Read at call time: the owner sets `installHost` after
  // constructing the controller, and tests leave it unset.
  const installing = new Map<string, Promise<void>>();
  const install = (workspaceId: string): Promise<void> => {
    const installHost = deps.controller.installHost;
    if (!installHost) return Promise.resolve();
    let running = installing.get(workspaceId);
    if (!running) {
      running = Promise.resolve()
        .then(() => installHost(workspaceId))
        .finally(() => installing.delete(workspaceId));
      installing.set(workspaceId, running);
    }
    return running;
  };
  const opts: FilesOptions = { install };

  /** The session's workspace and folder; 404 when there's no such session. */
  const session = (id: string) => {
    const s = deps.controller.get(id);
    const folder = s ? sessionFolder(deps.store, id) : null;
    if (!s || !folder) throw new AppError('NOT_FOUND', 'No such session.');
    return { workspaceId: s.workspaceId, folder };
  };

  // GET /api/chat/sessions/:id/files?path= — a folder's entries (default: the session's folder).
  files.get('/:id/files', async (c) => {
    const s = session(c.req.param('id'));
    const path = c.req.query('path') || s.folder;
    return c.json(success(await listFolder(deps.workspaces, s.workspaceId, path, opts)));
  });

  // GET /api/chat/sessions/:id/files/download?path= — a file's bytes, as an attachment.
  files.get('/:id/files/download', async (c) => {
    const s = session(c.req.param('id'));
    const path = c.req.query('path');
    if (!path) throw new AppError('BAD_REQUEST', 'Say which file to download.');
    const file = await openDownload(deps.workspaces, s.workspaceId, path, opts);
    return c.body(file.body, 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': attachmentHeader(file.name),
      'X-Content-Type-Options': 'nosniff',
      // Opened directly instead of saved, it still can't run anything.
      'Content-Security-Policy': 'sandbox',
      'Cache-Control': 'no-store',
    });
  });

  // GET /api/chat/sessions/:id/diff — what changed in the session's folder (git).
  files.get('/:id/diff', async (c) => {
    const s = session(c.req.param('id'));
    return c.json(success(await readDiff(deps.workspaces, s.workspaceId, s.folder, opts)));
  });

  return files;
}
