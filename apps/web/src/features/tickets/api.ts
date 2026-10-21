import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  TICKET_API,
  type BumpRequest,
  type BumpTarget,
  type CloseTicketRequest,
  type CommentTicketRequest,
  type CreateTicketBucketRequest,
  type CreateTicketRequest,
  type MergeTicketBucketRequest,
  type MergeTicketBucketResult,
  type TicketBucketMoveResult,
  type TicketBucket,
  type UpdateTicketBucketRequest,
  type StartTicketSessionRequest,
  type StartTicketSessionResult,
  type TicketBumped,
  type TicketBumpResult,
  type TicketDetail,
  type TicketEvent,
  type TicketFilter,
  type TicketItem,
  type TicketPage,
  type TicketTag,
  type TicketAttachment,
  type UpdateTicketRequest,
} from '@portal/contracts';
import { api, ApiError } from '@/lib/api';

/** Same contract as lib/api's client: `{ data }` on success, an ApiError otherwise; a 401 tells the app the session ended. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await track(
      fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok && isApiSuccess<T>(json)) return json.data;
  if (res.status === 401) void api.adminState().catch(() => undefined);
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}

/** `TicketFilter` as a query string. */
function query(f: TicketFilter): string {
  const q = new URLSearchParams();
  if (f.bucket) q.set('bucket', f.bucket);
  if (f.status?.length) q.set('status', f.status.join(','));
  if (f.priority?.length) q.set('priority', f.priority.join(','));
  if (f.type?.length) q.set('type', f.type.join(','));
  if (f.tag) q.set('tag', f.tag);
  if (f.assignee && f.assignee !== 'any') q.set('assignee', f.assignee);
  if (f.workspaceId) q.set('workspace', f.workspaceId);
  if (f.query) q.set('q', f.query);
  if (f.includeClosed) q.set('includeClosed', '1');
  if (f.orphan) q.set('orphan', '1');
  if (f.sort === 'newest') q.set('sort', 'newest');
  if (f.limit) q.set('limit', String(f.limit));
  if (f.cursor) q.set('cursor', f.cursor);
  return q.size ? `?${q}` : '';
}

export const ticketsApi = {
  /** One page of summary rows (D-58): `next` goes back as `filter.cursor`; `total` and `counts` come with the first page only. */
  list: (filter: TicketFilter = {}) => request<TicketPage>('GET', `${TICKET_API.list}${query(filter)}`),
  get: (id: string) => request<TicketDetail>('GET', TICKET_API.one(id)),
  create: (body: CreateTicketRequest) => request<TicketItem>('POST', TICKET_API.list, body),
  update: (id: string, body: UpdateTicketRequest) => request<TicketItem>('PATCH', TICKET_API.one(id), body),
  remove: (id: string) => request<{ ok: true }>('DELETE', TICKET_API.one(id)),
  comment: (id: string, body: CommentTicketRequest) => request<TicketEvent>('POST', TICKET_API.comments(id), body),
  close: (id: string, body: CloseTicketRequest) => request<TicketItem>('POST', TICKET_API.close(id), body),
  reopen: (id: string) => request<TicketItem>('DELETE', TICKET_API.close(id)),
  startSession: (id: string, body: StartTicketSessionRequest) => request<StartTicketSessionResult>('POST', TICKET_API.session(id), body),
  opening: (id: string) => request<{ text: string }>('GET', TICKET_API.opening(id)),
  tags: () => request<TicketTag[]>('GET', TICKET_API.tags),
  buckets: () => request<TicketBucket[]>('GET', TICKET_API.buckets),
  createBucket: (body: CreateTicketBucketRequest) => request<TicketBucket>('POST', TICKET_API.buckets, body),
  updateBucket: (key: string, body: UpdateTicketBucketRequest) => request<TicketBucket>('PATCH', TICKET_API.bucket(key), body),
  mergeBucket: (key: string, body: MergeTicketBucketRequest) => request<MergeTicketBucketResult>('POST', TICKET_API.bucketMerge(key), body),
  moveBuckets: (moves: { id: string; bucket: string }[]) => request<TicketBucketMoveResult[]>('POST', TICKET_API.bucketMoves, { moves }),
  brief: (id: string) => request<{ id: string; key?: string; summary: string; status: string }>('GET', TICKET_API.brief(id)),
  bumpTargets: (id: string) => request<BumpTarget[]>('GET', TICKET_API.bump(id)),
  bump: (id: string, body: BumpRequest) => request<TicketBumpResult>('POST', TICKET_API.bump(id), body),
  bumped: (sessionId: string) => request<TicketBumped[]>('GET', TICKET_API.bumped(sessionId)),
  /** Uploads one file as the raw body (any type; the type goes in x-file-type so a .json is not held to the JSON body limit). */
  attach: async (id: string, file: File): Promise<TicketAttachment> => {
    let res: Response;
    try {
      res = await track(
        fetch(TICKET_API.attachments(id), {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-file-name': encodeURIComponent(file.name),
            'x-file-type': file.type || 'application/octet-stream',
          },
          body: file,
        }),
      );
    } catch {
      throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
    }
    const json: unknown = await res.json().catch(() => null);
    if (res.ok && isApiSuccess<TicketAttachment>(json)) return json.data;
    if (res.status === 401) void api.adminState().catch(() => undefined);
    if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
    throw new ApiError(
      res.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR',
      res.status === 413 ? 'That file is too large.' : `Unexpected response (${res.status}).`,
      res.status,
    );
  },
  removeAttachment: (id: string, attachmentId: number) => request<{ removed: true }>('DELETE', TICKET_API.attachment(id, attachmentId)),
};
