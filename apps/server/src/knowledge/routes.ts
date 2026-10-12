// Knowledge: the REST routes under `/api/knowledge` (Knowledge PRD §13). Mounted behind the session guard in
// app.ts like every other route, so every caller here is the signed-in person (`ui`). A note's path is always
// a query parameter, never part of the URL path, so slashes, dots and encoded characters mean what they say.

import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { AppError, success } from '@isnanme/core';
import { GRAPH_NODE_KINDS, type CreateVaultRequest, type GraphLens, type GraphNodeKind, type GraphQuery, type UpdateVaultRequest, type VaultImportPolicy } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { compress } from 'hono/compress';
import { attachmentHeaders } from './attachments.js';
import { KnowledgeError } from './errors.js';
import { importZip } from './importer.js';
import { UI_ACTOR, type KnowledgeService } from './service.js';

async function body<T>(c: Context): Promise<Partial<T>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' ? (value as Partial<T>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

/** The request body as bytes, refused as soon as it passes `max` (the declared length, then the bytes actually read). */
async function bytes(c: Context, max: number): Promise<Buffer> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > max) throw new KnowledgeError('TOO_LARGE', `That is larger than the ${Math.round(max / 1024 / 1024)} MB limit.`);
  const stream = c.req.raw.body;
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new KnowledgeError('TOO_LARGE', `That is larger than the ${Math.round(max / 1024 / 1024)} MB limit.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const q = (c: Context, name: string): string => c.req.query(name) ?? '';
const needPath = (c: Context): string => {
  const p = c.req.query('path');
  if (!p) throw new KnowledgeError('INVALID_INPUT', 'Say which note: ?path=Folder/Note.md');
  return p;
};
const intQ = (c: Context, name: string, fallback: number): number => {
  const n = Number(c.req.query(name));
  return Number.isFinite(n) && c.req.query(name) !== undefined ? Math.floor(n) : fallback;
};

const flag = (c: Context, name: string): boolean => ['1', 'true'].includes((c.req.query(name) ?? '').toLowerCase());

/** `?lens=docs&vault=…&around=…&depth=2&tags=1&kinds=session,ticket&cap=800` as a graph query; what isn't one of the allowed words is refused. */
function graphQuery(c: Context): GraphQuery {
  const kinds = q(c, 'kinds')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  for (const k of kinds) if (!(GRAPH_NODE_KINDS as readonly string[]).includes(k)) throw new KnowledgeError('INVALID_INPUT', 'That kind of node isn’t one the graph has.');
  const access = q(c, 'access');
  if (access && access !== 'read' && access !== 'write') throw new KnowledgeError('INVALID_INPUT', 'Access is read or write.');
  const opt = (name: string): string | undefined => c.req.query(name) || undefined;
  return {
    lens: q(c, 'lens') as GraphLens,
    vault: opt('vault'),
    around: opt('around'),
    depth: c.req.query('depth') ? intQ(c, 'depth', 1) : undefined,
    folder: opt('folder'),
    tag: opt('tag'),
    tags: flag(c, 'tags') || undefined,
    unresolved: flag(c, 'unresolved') || undefined,
    attachments: flag(c, 'attachments') || undefined,
    hideOrphans: flag(c, 'hideOrphans') || undefined,
    since: opt('since'),
    access: access ? (access as 'read' | 'write') : undefined,
    kinds: kinds.length ? (kinds as GraphNodeKind[]) : undefined,
    cap: c.req.query('cap') ? intQ(c, 'cap', 0) : undefined,
  };
}

export function createKnowledgeRoutes(service: KnowledgeService) {
  const r = new Hono();

  // A graph is a few hundred kilobytes of JSON that compresses well; nothing else here is that big.
  r.use('/graph', compress());
  r.get('/graph', (c) => c.json(success(service.graph(graphQuery(c), UI_ACTOR))));

  r.get('/sources', (c) => c.json(success(service.sources())));

  r.get('/vaults', (c) => c.json(success(service.list())));
  r.post('/vaults', async (c) => c.json(success(service.create(await body<CreateVaultRequest>(c))), 201));

  // A zip of a vault, raw in the body (Content-Type: application/zip). `?into=<vault>` adds to one, else a new vault is made.
  r.post('/vaults/import', async (c) => {
    const policy = (q(c, 'policy') || 'keep-both') as VaultImportPolicy;
    if (!['skip', 'keep-both', 'overwrite'].includes(policy)) throw new KnowledgeError('INVALID_INPUT', 'The conflict policy is skip, keep-both or overwrite.');
    const data = await bytes(c, service.limits.importPackedBytes);
    const report = await importZip(service, data, { filename: q(c, 'filename') || undefined, name: q(c, 'name') || undefined, into: q(c, 'into') || undefined, policy, actor: UI_ACTOR });
    return c.json(success(report), 201);
  });

  r.get('/vaults/:id', (c) => c.json(success(service.summary(c.req.param('id')))));
  r.patch('/vaults/:id', async (c) => c.json(success(service.update(c.req.param('id'), await body<UpdateVaultRequest>(c)))));
  r.delete('/vaults/:id', async (c) => {
    const { name } = await body<{ name: string }>(c).catch(() => ({}) as { name?: string });
    service.remove(c.req.param('id'), String(name ?? c.req.query('name') ?? ''));
    return c.json(success({ ok: true }));
  });

  r.get('/vaults/:id/export', (c) => {
    const { filename, chunks } = service.exportZip(c.req.param('id'));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        try {
          const next = chunks.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (e) {
          controller.error(e);
        }
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    });
  });

  r.get('/vaults/:id/tree', (c) => c.json(success(service.tree(c.req.param('id'), q(c, 'folder')))));

  r.get('/vaults/:id/note', (c) => c.json(success(service.getNote(c.req.param('id'), needPath(c)))));
  r.put('/vaults/:id/note', async (c) => {
    const req = await body<{ content: string; baseVersion?: string; create?: boolean }>(c);
    if (typeof req.content !== 'string') throw new KnowledgeError('INVALID_INPUT', 'Send the note’s text as `content`.');
    return c.json(success(service.putNote(c.req.param('id'), needPath(c), { content: req.content, baseVersion: req.baseVersion ?? null, create: req.create === true })));
  });
  r.delete('/vaults/:id/note', (c) => {
    service.deleteNote(c.req.param('id'), needPath(c));
    return c.json(success({ ok: true }));
  });
  r.post('/vaults/:id/note/append', async (c) => {
    const req = await body<{ path: string; text: string; heading?: string }>(c);
    if (typeof req.path !== 'string' || typeof req.text !== 'string') throw new KnowledgeError('INVALID_INPUT', 'Send `path` and `text`.');
    return c.json(success(service.appendNote(c.req.param('id'), req.path, req.text, req.heading, UI_ACTOR)));
  });
  r.post('/vaults/:id/note/rename', async (c) => {
    const req = await body<{ from: string; to: string; rewriteLinks?: boolean }>(c);
    if (typeof req.from !== 'string' || typeof req.to !== 'string') throw new KnowledgeError('INVALID_INPUT', 'Send `from` and `to`.');
    return c.json(success(await service.renameNote(c.req.param('id'), req.from, req.to, { rewriteLinks: typeof req.rewriteLinks === 'boolean' ? req.rewriteLinks : undefined })));
  });
  r.post('/vaults/:id/note/restore', async (c) => {
    const req = await body<{ path: string; version: number }>(c);
    if (typeof req.path !== 'string' || !Number.isInteger(req.version)) throw new KnowledgeError('INVALID_INPUT', 'Send `path` and `version`.');
    return c.json(success(service.restore(c.req.param('id'), req.path, req.version as number)));
  });
  r.get('/vaults/:id/note/history', (c) => c.json(success(service.history(c.req.param('id'), needPath(c)))));
  r.get('/vaults/:id/note/version', (c) => c.json(success(service.version(c.req.param('id'), needPath(c), intQ(c, 'id', -1)))));
  r.get('/vaults/:id/note/backlinks', (c) => c.json(success(service.backlinks(c.req.param('id'), needPath(c)))));
  r.get('/vaults/:id/note/mentions', (c) => c.json(success(service.mentions(c.req.param('id'), needPath(c)))));
  r.get('/vaults/:id/embed', (c) => c.json(success(service.embed(c.req.param('id'), needPath(c), c.req.query('heading') ?? null, c.req.query('block') ?? null))));

  r.get('/vaults/:id/file', (c) => {
    const f = service.openFile(c.req.param('id'), needPath(c));
    const headers = attachmentHeaders(f.path, f.type);
    let start = 0;
    let end = f.size - 1;
    let status: 200 | 206 = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
    if (range && (range[1] || range[2]) && f.size > 0) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      } else {
        start = Math.max(0, f.size - Number(range[2]));
      }
      if (start > end || start >= f.size) {
        // The descriptor isn't going to be read: close it.
        createReadStream('', { fd: f.fd }).destroy();
        return c.body(null, 416, { 'Content-Range': `bytes */${f.size}` });
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${f.size}`;
    }
    headers['Content-Length'] = String(f.size === 0 ? 0 : end - start + 1);
    headers['Accept-Ranges'] = 'bytes';
    if (f.size === 0) {
      createReadStream('', { fd: f.fd }).destroy();
      return c.body(null, 200, headers);
    }
    const stream = createReadStream('', { fd: f.fd, start, end, autoClose: true });
    return c.body(Readable.toWeb(stream) as ReadableStream, status, headers);
  });
  r.put('/vaults/:id/file', async (c) => {
    const data = await bytes(c, service.limits.attachmentBytes);
    return c.json(success(service.putFile(c.req.param('id'), needPath(c), data)), 201);
  });
  r.post('/vaults/:id/folder', async (c) => {
    const { path } = await body<{ path: string }>(c);
    service.makeFolder(c.req.param('id'), String(path ?? ''));
    return c.json(success({ ok: true }), 201);
  });

  r.get('/vaults/:id/search', (c) =>
    c.json(
      success(
        service.search(c.req.param('id'), q(c, 'q'), { limit: intQ(c, 'limit', 20), offset: intQ(c, 'offset', 0), tag: c.req.query('tag') || undefined, folder: c.req.query('folder') || undefined }),
      ),
    ),
  );
  r.get('/vaults/:id/quick', (c) => c.json(success(service.quick(c.req.param('id'), q(c, 'q')))));
  r.get('/vaults/:id/tags', (c) => c.json(success(service.tags(c.req.param('id'), q(c, 'prefix')))));
  r.get('/vaults/:id/health', (c) => c.json(success(service.health(c.req.param('id')))));
  r.get('/vaults/:id/recent', (c) => c.json(success(service.recent(c.req.param('id'), intQ(c, 'limit', 20)))));
  r.get('/vaults/:id/deleted', (c) => c.json(success(service.deleted(c.req.param('id')))));
  r.get('/vaults/:id/daily', (c) => c.json(success(service.daily(c.req.param('id'), c.req.query('date')))));
  r.post('/vaults/:id/daily', async (c) => {
    const req = await body<{ text: string; date?: string; time?: boolean }>(c);
    if (typeof req.text !== 'string') throw new KnowledgeError('INVALID_INPUT', 'Send the text to add as `text`.');
    return c.json(success(service.appendDaily(c.req.param('id'), { text: req.text, date: req.date, time: req.time })));
  });
  r.get('/vaults/:id/activity', (c) => c.json(success(service.activity(c.req.param('id'), intQ(c, 'limit', 60)))));
  r.post('/vaults/:id/rescan', async (c) => c.json(success(await service.rescan(c.req.param('id')))));

  return r;
}
