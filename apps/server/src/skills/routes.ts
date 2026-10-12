// Skillsets' own routes (`/api/skills/*`): the library, imports, reviews and a workspace's skills.
// Skillsets themselves use the generic pool routes (`/api/pools/skillset`). Mounted by the owner under
// the signed-in guard, like every other /api route. Import, approve, reject and revoke happen only here,
// in the portal UI's API (Skillset §14: no Portal MCP tool may do them).

import { AppError, success } from '@isnanme/core';
import type { SkillReviewRequest, SkillRevokeRequest } from '@portal/contracts';
import { SKILL_UPLOAD_LIMITS } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ArchiveError, readFolder, readZip, type ArchiveEntry } from './archive.js';
import { sessionTag } from './library.js';
import type { SkillsModule } from './module.js';

type Env = { Variables: { token: string } };

/** An upload's request may carry a little more than its files (zip structure, multipart framing). */
const MAX_REQUEST_BYTES = SKILL_UPLOAD_LIMITS.bytes + 2 * 1024 * 1024;

async function body<T>(c: Context<Env>): Promise<Partial<T>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' ? (value as Partial<T>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

/** `my-skills.zip` → `my-skills`, a name for a skill whose SKILL.md sits at the zip's root. */
const stem = (fileName: string) => fileName.replace(/\.zip$/i, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || null;

export function createSkillRoutes(skills: SkillsModule): Hono<Env> {
  const app = new Hono<Env>();
  const { library } = skills;

  app.get('/library', (c) => c.json(success(library.library())));

  // A zip as the raw body (`?name=` its file name), or a folder as multipart: `paths` (a JSON list of
  // relative paths) and one `files` part per path, in the same order (Skillset FR1).
  app.post(
    '/import',
    bodyLimit({
      maxSize: MAX_REQUEST_BYTES,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE', `Uploads can be up to ${SKILL_UPLOAD_LIMITS.bytes / 1024 / 1024} MB.`);
      },
    }),
    async (c) => {
      const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      let entries: ArchiveEntry[];
      let label: string;
      let rootName: string | null;
      try {
        if (type === 'multipart/form-data') {
          const form = await c.req.formData();
          let paths: unknown;
          try {
            paths = JSON.parse(String(form.get('paths') ?? '[]'));
          } catch {
            throw new AppError('BAD_REQUEST', 'The folder’s file list is malformed.');
          }
          const files = form.getAll('files');
          if (!Array.isArray(paths) || paths.length !== files.length || paths.some((p) => typeof p !== 'string')) throw new AppError('BAD_REQUEST', 'The folder’s file list doesn’t match its files.');
          if (files.length > SKILL_UPLOAD_LIMITS.files) throw new AppError('VALIDATION_FAILED', `The folder has more than ${SKILL_UPLOAD_LIMITS.files.toLocaleString('en')} files.`);
          const list: { path: string; data: Buffer }[] = [];
          for (let i = 0; i < files.length; i++) {
            const f = files[i];
            if (typeof f === 'string' || !f) throw new AppError('BAD_REQUEST', 'Expected files.');
            list.push({ path: paths[i] as string, data: Buffer.from(await f.arrayBuffer()) });
          }
          entries = readFolder(list);
          label = (paths[0] as string | undefined)?.split('/')[0] ?? 'Folder';
          rootName = null;
        } else if (['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(type)) {
          const name = c.req.query('name') ?? 'upload.zip';
          entries = readZip(Buffer.from(await c.req.arrayBuffer()));
          label = name.slice(0, 120);
          rootName = stem(name);
        } else {
          throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Upload a .zip file or a folder.');
        }
      } catch (e) {
        if (e instanceof ArchiveError) throw new AppError('VALIDATION_FAILED', e.message);
        throw e;
      }
      return c.json(success(library.importUpload(entries, label, rootName)), 201);
    },
  );

  app.get('/versions/:id', (c) => c.json(success(library.detail(c.req.param('id')))));
  app.get('/versions/:id/file', (c) => c.json(success(library.file(c.req.param('id'), c.req.query('path'), c.req.query('offset')))));
  app.post('/versions/:id/review', async (c) => c.json(success(library.review(c.req.param('id'), await body<SkillReviewRequest>(c), sessionTag(c.get('token'))))));
  app.post('/versions/:id/revoke', async (c) => {
    const { note } = await body<SkillRevokeRequest>(c);
    return c.json(success(library.revoke(c.req.param('id'), note, sessionTag(c.get('token')))));
  });
  app.delete('/sources/:id', (c) => {
    library.removeSource(c.req.param('id'), c.req.query('versions') === '1');
    return c.json(success({ ok: true }));
  });

  const workspaceId = (c: Context<Env>) => `${c.req.param('target')}/${c.req.param('name')}`;
  app.get('/workspaces/:target/:name', (c) => c.json(success(skills.workspace(workspaceId(c)))));
  app.post('/workspaces/:target/:name/verify', async (c) => {
    await skills.verifier.verify(workspaceId(c));
    return c.json(success(skills.workspace(workspaceId(c))));
  });
  return app;
}
