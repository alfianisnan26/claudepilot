// Tickets: the portal UI's routes (`/api/tickets`, TICKET_API). A person is signed in, so every call is the
// person's. No auth middleware here: app.ts mounts this under a guarded group, as it does every /api route.

import { AppError, success } from '@isnanme/core';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  type CloseTicketRequest,
  type CommentTicketRequest,
  type CreateTicketRequest,
  type StartTicketSessionRequest,
  type TicketAssigneeFilter,
  type TicketFilter,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
  type UpdateTicketRequest,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
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

/** A comma-separated query value as a list of the names it may hold. */
const names = <T extends string>(raw: string | undefined, all: readonly T[], field: string): T[] | undefined => {
  if (!raw) return undefined;
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = items.find((s) => !(all as readonly string[]).includes(s));
  if (bad) throw new AppError('VALIDATION_FAILED', `Unknown ${field} “${bad.slice(0, 30)}”.`, { details: { [field]: `Use: ${all.join(', ')}.` } });
  return items as T[];
};

const int = (raw: string | undefined) => {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) ? n : undefined;
};

export function createTicketRoutes(tickets: Tickets): Hono {
  const app = new Hono();
  const id = (c: Context) => c.req.param('id') ?? '';

  app.get('/', (c) => {
    const q = c.req.query();
    const assignee = q.assignee;
    if (assignee && !['any', 'unassigned', 'user'].includes(assignee) && !assignee.startsWith('session:')) throw new AppError('VALIDATION_FAILED', 'Unknown assignee filter.', { details: { assignee: 'Use any, unassigned, user or session:<id>.' } });
    const filter: TicketFilter = {
      status: names<TicketStatus>(q.status, TICKET_STATUSES, 'status'),
      priority: names<TicketPriority>(q.priority, TICKET_PRIORITIES, 'priority'),
      type: names<TicketType>(q.type, TICKET_TYPES, 'type'),
      tag: q.tag || undefined,
      assignee: (assignee || undefined) as TicketAssigneeFilter | undefined,
      workspaceId: q.workspace || undefined,
      query: q.q || undefined,
      includeClosed: q.includeClosed === '1' || q.includeClosed === 'true',
      sort: q.sort === 'newest' ? 'newest' : undefined,
      limit: int(q.limit),
      offset: int(q.offset),
    };
    return c.json(success(tickets.list(UI, filter)));
  });

  app.post('/', async (c) => c.json(success(tickets.create(UI, await body<CreateTicketRequest>(c))), 201));

  // Registered before `/:id`, which would read "tags" as an id.
  app.get('/tags', (c) => c.json(success(tickets.tags(UI))));

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
  app.post('/:id/close', async (c) => c.json(success(tickets.close(UI, id(c), await optionalBody<CloseTicketRequest>(c)))));
  app.delete('/:id/close', (c) => c.json(success(tickets.update(UI, id(c), { status: 'open' }))));
  app.post('/:id/session', async (c) => c.json(success(await tickets.startSession(UI, id(c), await body<StartTicketSessionRequest>(c))), 201));

  return app;
}
