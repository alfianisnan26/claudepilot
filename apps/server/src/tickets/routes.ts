// Tickets: the portal UI's routes (`/api/tickets`, TICKET_API). A person is signed in, so every call is the
// person's. No auth middleware here: app.ts mounts this under a guarded group, as it does every /api route.

import { AppError, success } from '@isnanme/core';
import {
  sessionRef,
  ticketBucketRef,
  ticketRef,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_ATTACHMENT_INLINE_TYPES,
  TICKET_ATTACHMENT_LIMITS,
  TICKET_TYPES,
  type BumpRequest,
  type CloseTicketRequest,
  type CommentTicketRequest,
  type CreateTicketBucketRequest,
  type CreateTicketRequest,
  type StartTicketSessionRequest,
  type TicketAssigneeFilter,
  type TicketFilter,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
  type UpdateTicketBucketRequest,
  type UpdateTicketRequest,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { actorOf, actorUserId, can, refusal, requireCan, visible } from '../authz/seam.js';
import { declareTicketPolicies, registerTicketBucketAuthz } from './authz.js';
import type { Caller, Tickets } from './service.js';

async function body<T>(c: Context): Promise<Partial<T>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' ? (value as Partial<T>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

const optionalBody = async <T>(c: Context): Promise<Partial<T>> => {
  const value: unknown = await c.req.json().catch(() => null);
  return value && typeof value === 'object' ? (value as Partial<T>) : {};
};

const UI: Caller = { kind: 'ui' };

const attachmentNumber = (c: Context): number => {
  const n = Number(c.req.param('attachmentId'));
  if (!Number.isInteger(n) || n <= 0) throw new AppError('NOT_FOUND', 'No such file.');
  return n;
};

/** A comma-separated query value as a list of the names it may hold. */
const names = <T extends string>(raw: string | undefined, all: readonly T[], field: string): T[] | undefined => {
  if (!raw) return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = items.find((s) => !(all as readonly string[]).includes(s));
  if (bad)
    throw new AppError('VALIDATION_FAILED', `Unknown ${field} “${bad.slice(0, 30)}”.`, { details: { [field]: `Use: ${all.join(', ')}.` } });
  return items as T[];
};

export function createTicketRoutes(tickets: Tickets): Hono {
  declareTicketPolicies();
  registerTicketBucketAuthz(tickets);
  const app = new Hono();
  const id = (c: Context) => c.req.param('id') ?? '';

  // T-1098: a ticket is reached through its bucket: view to read it, operate to change it. A bucket the person may not see answers like a
  // missing ticket (the same 404). Paths that are not a ticket id are left to their own routes.
  const NOT_IDS = new Set(['tags', 'bumped', 'buckets']);
  const guard = async (c: Context, next: () => Promise<void>) => {
    const ref = c.req.param('id') ?? '';
    if (!NOT_IDS.has(ref)) {
      const bucket = tickets.bucketOf(ref);
      const verb = c.req.method === 'GET' ? 'view' : 'operate';
      const d = bucket ? can(actorOf(c), verb, ticketBucketRef(bucket)) : null;
      if (d && !d.allow) {
        const e = refusal(d, verb, ticketBucketRef(bucket!));
        throw e.code === 'NOT_FOUND' ? new AppError('NOT_FOUND', 'No such ticket.') : e;
      }
    }
    await next();
  };
  app.use('/:id', guard);
  app.use('/:id/*', guard);

  app.get('/', (c) => {
    const q = c.req.query();
    const assignee = q.assignee;
    if (assignee && !['any', 'unassigned', 'user'].includes(assignee) && !assignee.startsWith('session:'))
      throw new AppError('VALIDATION_FAILED', 'Unknown assignee filter.', {
        details: { assignee: 'Use any, unassigned, user or session:<id>.' },
      });
    const filter: TicketFilter = {
      bucket: q.bucket || undefined,
      status: names<TicketStatus>(q.status, TICKET_STATUSES, 'status'),
      priority: names<TicketPriority>(q.priority, TICKET_PRIORITIES, 'priority'),
      type: names<TicketType>(q.type, TICKET_TYPES, 'type'),
      tag: q.tag || undefined,
      assignee: (assignee || undefined) as TicketAssigneeFilter | undefined,
      workspaceId: q.workspace || undefined,
      query: q.q || undefined,
      includeClosed: q.includeClosed === '1' || q.includeClosed === 'true',
      orphan: q.orphan === '1' || q.orphan === 'true' || undefined,
      sort: q.sort === 'newest' ? 'newest' : undefined,
    };
    // D-58: `{ items, next }` (25 by default, 100 at most), summary rows, keyset. Each row passes `view` before it is shown and `next` points at
    // the last row shown, so a cursor never names a hidden ticket. A bad cursor, or one made for another filter, is a 400.
    const actor = actorOf(c);
    if (filter.bucket) requireCan(actor, 'view', ticketBucketRef(filter.bucket.toUpperCase()));
    // T-1098: and its bucket passes `view` (asked once per bucket per request).
    const seen = new Map<string, boolean>();
    const inBucket = (b: string | undefined) => {
      if (!b) return true;
      if (!seen.has(b)) seen.set(b, can(actor, 'view', ticketBucketRef(b)).allow);
      return seen.get(b)!;
    };
    const keep = (t: { id: string; bucket?: string }) => inBucket(t.bucket) && visible(actor, 'ticket', [t], (x) => x.id).length > 0;
    return c.json(success(tickets.listPage(UI, filter, { cursor: q.cursor || undefined, limit: q.limit, keep })));
  });

  app.post('/', async (c) => {
    const req = await body<CreateTicketRequest>(c);
    if (typeof req.bucket === 'string' && req.bucket.trim()) requireCan(actorOf(c), 'operate', ticketBucketRef(req.bucket.trim().toUpperCase()));
    return c.json(success(tickets.create(UI, req)), 201);
  });

  // Buckets (T-1098). Registered before `/:id`.
  app.get('/buckets', (c) => {
    const actor = actorOf(c);
    return c.json(success(visible(actor, 'ticket_bucket', tickets.buckets(UI), (b) => b.key)));
  });
  app.post('/buckets', async (c) => {
    const actor = actorOf(c);
    return c.json(success(tickets.createBucket(UI, await body<CreateTicketBucketRequest>(c), { ownerId: actorUserId(actor) ?? undefined })), 201);
  });
  app.get('/buckets/:key', (c) => {
    const key = (c.req.param('key') ?? '').toUpperCase();
    requireCan(actorOf(c), 'view', ticketBucketRef(key));
    return c.json(success(tickets.bucket(UI, key)));
  });
  app.patch('/buckets/:key', async (c) => {
    const key = (c.req.param('key') ?? '').toUpperCase();
    requireCan(actorOf(c), 'manage', ticketBucketRef(key));
    return c.json(success(tickets.updateBucket(UI, key, await body<UpdateTicketBucketRequest>(c))));
  });

  // Registered before `/:id`, which would read "tags" as an id.
  app.get('/tags', (c) => c.json(success(tickets.tags(UI))));
  // The tickets bumped into a session (FR31), for its page: whoever may view the session.
  app.get('/bumped', (c) => {
    const session = c.req.query('session') ?? '';
    if (!session) throw new AppError('VALIDATION_FAILED', 'Name the session.', { details: { session: 'Required.' } });
    requireCan(actorOf(c), 'view', sessionRef(session));
    return c.json(success(tickets.bumpedInto(UI, session)));
  });

  app.get('/:id', (c) => c.json(success(tickets.get(UI, id(c)))));
  app.get('/:id/brief', (c) => {
    const brief = tickets.brief(id(c));
    if (!brief) throw new AppError('NOT_FOUND', 'No such ticket.');
    return c.json(success(brief));
  });
  app.get('/:id/opening', (c) => c.json(success({ text: tickets.opening(UI, id(c)) })));
  app.patch('/:id', async (c) => c.json(success(tickets.update(UI, id(c), await body<UpdateTicketRequest>(c)))));
  app.delete('/:id', (c) => {
    tickets.remove(UI, id(c));
    return c.json(success({ ok: true }));
  });

  app.post('/:id/comments', async (c) => {
    const { text } = await body<CommentTicketRequest>(c);
    return c.json(success(tickets.comment(UI, id(c), text)), 201);
  });
  // Attachments (owner, 2026-10-17): the file is the raw body, its name in `x-file-name` (URI-encoded), its type in `x-file-type` (or `content-type`).
  app.get('/:id/attachments', (c) => c.json(success(tickets.attachments(UI, id(c)))));
  app.post('/:id/attachments', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > TICKET_ATTACHMENT_LIMITS.maxBytes)
      throw new AppError('PAYLOAD_TOO_LARGE', `The file is larger than ${TICKET_ATTACHMENT_LIMITS.maxBytes / 1024 / 1024} MB.`);
    let name = c.req.header('x-file-name') ?? '';
    try {
      name = decodeURIComponent(name);
    } catch {
      throw new AppError('VALIDATION_FAILED', 'The file name is not valid.', { details: { name: 'URI-encode it in x-file-name.' } });
    }
    const bytes = Buffer.from(await c.req.arrayBuffer());
    // The real type in x-file-type (the body goes as application/octet-stream, so a .json file is not held to the JSON body limit).
    return c.json(
      success(tickets.attach(UI, id(c), { name, mediaType: c.req.header('x-file-type') ?? c.req.header('content-type'), bytes })),
      201,
    );
  });
  app.get('/:id/attachments/:attachmentId', (c) => {
    const { attachment, bytes } = tickets.attachmentFile(UI, id(c), attachmentNumber(c));
    const inline =
      (TICKET_ATTACHMENT_INLINE_TYPES as readonly string[]).includes(attachment.mediaType) && c.req.query('download') === undefined;
    const ascii = attachment.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': inline ? attachment.mediaType : 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        'Cache-Control': 'private, max-age=300',
      },
    });
  });
  app.delete('/:id/attachments/:attachmentId', (c) => {
    tickets.removeAttachment(UI, id(c), attachmentNumber(c));
    return c.json(success({ removed: true }));
  });
  app.post('/:id/close', async (c) => c.json(success(tickets.close(UI, id(c), await optionalBody<CloseTicketRequest>(c)))));
  app.delete('/:id/close', (c) => c.json(success(tickets.update(UI, id(c), { status: 'open' }))));
  // Bump (FR28): operate on the ticket, and on the session it goes into; the picker lists only the sessions the person may operate.
  app.get('/:id/bump', (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'operate', ticketRef(id(c)));
    return c.json(success(tickets.bumpTargets(UI, id(c)).filter((t) => can(actor, 'operate', sessionRef(t.id)).allow)));
  });
  app.post('/:id/bump', async (c) => {
    const actor = actorOf(c);
    const req = await body<BumpRequest>(c);
    requireCan(actor, 'operate', ticketRef(id(c)));
    if (typeof req.sessionId === 'string' && req.sessionId.trim()) requireCan(actor, 'operate', sessionRef(req.sessionId.trim()));
    return c.json(success(await tickets.bump(UI, id(c), req)), 201);
  });
  app.post('/:id/session', async (c) =>
    c.json(success(await tickets.startSession(UI, id(c), await body<StartTicketSessionRequest>(c))), 201),
  );

  return app;
}
