// Chat sessions: the Files and Diff routes (CHAT_API.files, .download, .diff). No auth middleware here —
// the owner mounts this under the guarded chat group at /api/chat/sessions, next to createChatRoutes.

import { AppError, success } from '@isnanme/core';
import { CHAT_MAX_UPLOAD_BYTES, CHAT_MAX_ZIP_ENTRIES } from '@portal/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import { blobFileFor, textPreview } from './artifacts/serve.js';
import { dispositionHeader } from './artifacts/names.js';
import { eventFiles } from './artifacts/records.js';
import { discardUpload, receiveUpload } from './artifacts/uploads.js';
import { zipStream, type ZipItem } from './artifacts/zip.js';
import type { ChatController } from './controller.js';
import { listFolder, openDownload, readDiff, sessionFolder, type FilesOptions } from './files.js';

export interface ChatFileRoutesDeps {
  controller: Pick<ChatController, 'get' | 'installHost' | 'blobFile' | 'scrub'>;
  workspaces: Workspaces;
  store: Store;
}

/** Characters RFC 5987 lets stand in `filename*`; everything else is percent-encoded. */
const encode5987 = (s: string) => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * `attachment; filename="<name>"` with the name made safe for a quoted header value (printable ASCII,
 * no quote, backslash or percent). When that changed it, `filename*` carries the real name in UTF-8.
 * For a file in the workspace, whose name is whatever the file system holds (a backslash included); the
 * names of chat content come through `dispositionHeader`, which also drops anything path-like.
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
    const folder = s ? sessionFolder(deps.store, s.id) : null; // s.id: a folded session’s old id resolves to the chat that took it in
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

  /** The session by id (or an alias of it); 404 when there's no such session. */
  const chat = (id: string) => {
    const s = deps.controller.get(id);
    if (!s) throw new AppError('NOT_FOUND', 'No such session.');
    return s;
  };

  // POST /api/chat/sessions/:id/uploads — one file to attach, as the raw request body (chat content, FR30).
  // Its own limit (QA-028): a file up to the cap, refused by its announced size before a byte is read; opaque bytes, never JSON.
  const uploadLimit = bodyLimit({
    maxSize: CHAT_MAX_UPLOAD_BYTES + 64 * 1024,
    onError: (c) => {
      const e = new AppError('PAYLOAD_TOO_LARGE', `That file is over ${CHAT_MAX_UPLOAD_BYTES / 1_000_000} MB.`);
      return c.json(e.toJSON(), e.status as 413);
    },
  });
  files.post('/:id/uploads', uploadLimit, async (c) => {
    const s = chat(c.req.param('id'));
    if (s.state === 'ended') throw new AppError('CONFLICT', 'This session has ended.');
    let name: string | null = null;
    try {
      name = decodeURIComponent(c.req.header('x-file-name') ?? '') || null;
    } catch {
      name = null; // not valid percent-encoding: the file is still welcome, under a name of the portal's making
    }
    const declared = Number(c.req.header('content-length'));
    const upload = await receiveUpload(deps.store, s.id, { body: c.req.raw.body, name, declaredSize: Number.isFinite(declared) && c.req.header('content-length') ? declared : null });
    return c.json(success(upload), 201);
  });

  // DELETE /api/chat/sessions/:id/uploads/:uploadId — an attachment that was removed before it was sent.
  files.delete('/:id/uploads/:uploadId', (c) => {
    const s = chat(c.req.param('id'));
    discardUpload(deps.store, s.id, c.req.param('uploadId'));
    return c.json(success({ ok: true }));
  });

  // GET /api/chat/sessions/:id/blobs/:blobId/preview — a text file's start, secrets hidden (FR32).
  files.get('/:id/blobs/:blobId/preview', (c) => {
    const s = chat(c.req.param('id'));
    const file = deps.controller.blobFile(s.id, c.req.param('blobId'));
    if (!file) throw new AppError('NOT_FOUND', 'No such file.');
    // The workspace's secret values go first, then credential shapes (the same hiding as the transcript's).
    return c.json(success(textPreview(file, (text) => deps.controller.scrub(s.workspaceId, text))));
  });

  // GET /api/chat/sessions/:id/artifacts.zip?events=12,15 — the files of those transcript events as one zip ("Download all", FR32).
  files.get('/:id/artifacts.zip', (c) => {
    const s = chat(c.req.param('id'));
    const seqs = (c.req.query('events') ?? '')
      .split(',')
      .map((v) => Number(v))
      .filter((n) => Number.isSafeInteger(n) && n > 0)
      .slice(0, CHAT_MAX_ZIP_ENTRIES);
    const items: ZipItem[] = [];
    const seen = new Set<string>();
    for (const f of eventFiles(deps.store, s.id, seqs)) {
      const blob = blobFileFor(deps.store, s.id, f.blobId);
      const key = `${f.blobId}/${f.name}`;
      if (blob && !seen.has(key)) {
        seen.add(key);
        items.push({ name: f.name, file: blob });
      }
    }
    const body = zipStream(items);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': attachmentHeader(`${(s.title || 'chat').slice(0, 60)}-files.zip`),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    });
  });

  return files;
}
