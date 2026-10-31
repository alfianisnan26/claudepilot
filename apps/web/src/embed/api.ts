import {
  REPORTER_ROUTES,
  type ReporterAddCapturesRequest,
  type ReporterAddCommentRequest,
  type ReporterConnectMessage,
  type ReporterCreateTicketRequest,
  type ReporterCreateTicketResponse,
  type ReporterDuplicateCandidate,
  type ReporterDuplicateQuery,
  type ReporterMe,
  type ReporterNote,
  type ReporterNoteHit,
  type ReporterObservedBuildRequest,
  type ReporterReview,
  type ReporterSession,
  type ReporterSessionTargetStatus,
  type ReporterStartReviewRequest,
  type ReporterStatus,
  type ReporterSubmitReviewRequest,
  type ReporterSubmitReviewResponse,
  type ReporterTicket,
  type ReporterTicketComment,
  type ReporterTicketList,
  type ReporterTicketQuery,
  type ReporterUpdateCommentRequest,
} from '@portal/contracts';
import { querySearch, splitStream } from './model';

/*
 * The panel's client for /reporter/v1 (same origin as the panel, bearer `cprt_` token, no cookies sent). The token lives in the
 * iframe's own storage (partitioned under the host site by the browser) and never crosses the bridge.
 */

export class ReporterApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface StoredToken {
  token: string;
  expiresAt: string;
  actorLabel: string;
  bucketKey: string;
}

/** Storage that may be missing or throw (a blocked third-party frame, private mode): every call is guarded. */
export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export function safeStorage(): KV | null {
  try {
    const s = window.localStorage;
    const probe = '__pilot_reporter_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/** In-memory fallback when storage is blocked: the person connects again on the next page load. */
export function memoryStorage(): KV {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

export const tokenKey = (bucket: string, origin: string) => `pilot-reporter:token:${bucket}:${origin}`;

export function readToken(kv: KV, bucket: string, origin: string, now = Date.now()): StoredToken | null {
  try {
    const raw = kv.getItem(tokenKey(bucket, origin));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredToken>;
    if (typeof v.token !== 'string' || typeof v.expiresAt !== 'string' || v.bucketKey !== bucket) return null;
    if (!(Date.parse(v.expiresAt) > now)) {
      kv.removeItem(tokenKey(bucket, origin));
      return null;
    }
    return { token: v.token, expiresAt: v.expiresAt, actorLabel: typeof v.actorLabel === 'string' ? v.actorLabel : '', bucketKey: v.bucketKey };
  } catch {
    return null;
  }
}

export function writeToken(kv: KV, origin: string, t: StoredToken) {
  try {
    kv.setItem(tokenKey(t.bucketKey, origin), JSON.stringify(t));
  } catch {
    // storage full or blocked: the token stays in memory for this page
  }
}

export function clearToken(kv: KV, bucket: string, origin: string) {
  try {
    kv.removeItem(tokenKey(bucket, origin));
  } catch {
    // nothing to clear
  }
}

/** The connect popup's answer, checked: our nonce, our bucket, a token of the reporter kind. */
export function parseConnectMessage(data: unknown, nonce: string, bucket: string): ReporterConnectMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.type !== 'pilot-reporter:connected' || d.nonce !== nonce || d.bucketKey !== bucket) return null;
  if (typeof d.token !== 'string' || !d.token.startsWith('cprt_') || d.token.length > 400) return null;
  if (typeof d.expiresAt !== 'string' || Number.isNaN(Date.parse(d.expiresAt))) return null;
  return { type: d.type, nonce: d.nonce, token: d.token, expiresAt: d.expiresAt, bucketKey: d.bucketKey, actorLabel: typeof d.actorLabel === 'string' ? d.actorLabel.slice(0, 120) : '' };
}

/** `/reporter/v1/tickets/:key` with `{ key }` filled in (encoded). */
export function fill(route: string, params: Record<string, string>): string {
  return route.replace(/:([a-zA-Z]+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ''));
}

const listOf = <T,>(v: unknown, field: string): T[] => {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>)[field])) return (v as Record<string, T[]>)[field]!;
  return [];
};

export interface ReporterClient {
  status(bucket: string, origin: string): Promise<ReporterStatus>;
  me(): Promise<ReporterMe>;
  /** Revokes this token on the server (sign out); best effort. */
  revoke(): Promise<unknown>;
  tickets(q: ReporterTicketQuery): Promise<ReporterTicketList>;
  ticket(key: string): Promise<ReporterTicket>;
  createTicket(req: ReporterCreateTicketRequest): Promise<ReporterCreateTicketResponse>;
  addCaptures(key: string, req: ReporterAddCapturesRequest): Promise<unknown>;
  attach(key: string, captureId: string, kind: 'screenshot' | 'evidence', body: Blob): Promise<unknown>;
  comments(key: string): Promise<ReporterTicketComment[]>;
  reply(key: string, body: string): Promise<unknown>;
  duplicates(q: ReporterDuplicateQuery): Promise<ReporterDuplicateCandidate[]>;
  reviews(): Promise<ReporterReview[]>;
  review(id: string): Promise<ReporterReview>;
  startReview(req: ReporterStartReviewRequest): Promise<ReporterReview>;
  renameReview(id: string, title: string): Promise<unknown>;
  discardReview(id: string): Promise<unknown>;
  addComment(id: string, req: ReporterAddCommentRequest): Promise<unknown>;
  updateComment(id: string, captureId: string, req: ReporterUpdateCommentRequest): Promise<unknown>;
  deleteComment(id: string, captureId: string): Promise<unknown>;
  reviewAttach(id: string, captureId: string, kind: 'screenshot' | 'evidence', body: Blob): Promise<unknown>;
  submitReview(id: string, req: ReporterSubmitReviewRequest): Promise<ReporterSubmitReviewResponse>;
  sessionTargets(): Promise<ReporterSessionTargetStatus[]>;
  sessions(): Promise<ReporterSession[]>;
  knowledge(q: string): Promise<ReporterNoteHit[]>;
  note(path: string): Promise<ReporterNote>;
  observedBuild(req: ReporterObservedBuildRequest): Promise<unknown>;
  /** An image the API serves (bearer), as an object URL the caller revokes. */
  blobUrl(url: string): Promise<string>;
  /** The events stream; resolves when it ends. */
  events(onEvent: (e: unknown) => void, signal: AbortSignal): Promise<void>;
}

export function createClient(opts: { token: () => string | null; onUnauthorized: () => void; fetchFn?: typeof fetch }): ReporterClient {
  const f = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  const headers = (extra: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...extra };
    const t = opts.token();
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  };

  async function call<T>(method: string, path: string, body?: unknown, raw?: { blob: Blob; headers: Record<string, string> }): Promise<T> {
    let res: Response;
    try {
      res = await f(path, {
        method,
        credentials: 'omit',
        headers: headers(raw ? raw.headers : body === undefined ? {} : { 'Content-Type': 'application/json' }),
        body: raw ? raw.blob : body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ReporterApiError('NETWORK_ERROR', 'Could not reach pilot.', 0);
    }
    const json: unknown = await res.json().catch(() => null);
    if (res.status === 401) opts.onUnauthorized();
    const env = json as { data?: unknown; error?: { code?: string; message?: string } } | null;
    if (res.ok) return (env && typeof env === 'object' && 'data' in env ? env.data : json) as T;
    const code = env?.error?.code ?? (res.status === 404 ? 'NOT_FOUND' : res.status === 429 ? 'RATE_LIMITED' : 'ERROR');
    const message = env?.error?.message ?? (res.status === 429 ? 'Too many reports. Try again later.' : `Request failed (${res.status}).`);
    throw new ReporterApiError(code, message, res.status);
  }

  const R = REPORTER_ROUTES;
  return {
    status: (bucket, origin) => call('GET', `${R.status}?${new URLSearchParams({ bucket, origin })}`),
    me: () => call('GET', R.me),
    revoke: () => call('DELETE', R.me),
    tickets: async (q) => {
      const v = await call<ReporterTicketList | ReporterTicket[]>('GET', `${R.tickets}${querySearch(q)}`);
      if (Array.isArray(v)) return { items: v, nextCursor: null, counts: { status: {}, priority: {}, type: {}, onPath: 0 } };
      return { items: v.items ?? [], nextCursor: v.nextCursor ?? null, counts: v.counts ?? { status: {}, priority: {}, type: {}, onPath: 0 } };
    },
    ticket: (key) => call('GET', fill(R.ticket, { key })),
    createTicket: (req) => call('POST', R.tickets, req),
    addCaptures: (key, req) => call('POST', fill(R.captures, { key }), req),
    attach: (key, captureId, kind, blob) =>
      call('POST', fill(R.attach, { key }), undefined, { blob, headers: { 'Content-Type': blob.type || 'application/octet-stream', 'x-reporter-capture': captureId, 'x-reporter-kind': kind } }),
    comments: async (key) => listOf<ReporterTicketComment>(await call('GET', fill(R.ticketComments, { key })), 'items'),
    reply: (key, body) => call('POST', fill(R.ticketComments, { key }), { body }),
    duplicates: async (q) => listOf<ReporterDuplicateCandidate>(await call('POST', R.duplicates, q), 'candidates'),
    reviews: async () => listOf<ReporterReview>(await call('GET', `${R.reviews}?status=draft`), 'items'),
    review: (id) => call('GET', fill(R.review, { id })),
    startReview: (req) => call('POST', R.reviews, req),
    renameReview: (id, title) => call('PATCH', fill(R.review, { id }), { title }),
    discardReview: (id) => call('DELETE', fill(R.review, { id })),
    addComment: (id, req) => call('POST', fill(R.reviewComments, { id }), req),
    updateComment: (id, captureId, req) => call('PATCH', fill(R.reviewComment, { id, captureId }), req),
    deleteComment: (id, captureId) => call('DELETE', fill(R.reviewComment, { id, captureId })),
    reviewAttach: (id, captureId, kind, blob) =>
      call('POST', fill(R.reviewAttach, { id }), undefined, { blob, headers: { 'Content-Type': blob.type || 'application/octet-stream', 'x-reporter-capture': captureId, 'x-reporter-kind': kind } }),
    submitReview: (id, req) => call('POST', fill(R.reviewSubmit, { id }), req),
    sessionTargets: async () => listOf<ReporterSessionTargetStatus>(await call('GET', R.sessionTargets), 'items'),
    sessions: async () => listOf<ReporterSession>(await call('GET', R.sessions), 'items'),
    knowledge: async (q) => listOf<ReporterNoteHit>(await call('GET', `${R.knowledge}?${new URLSearchParams({ q })}`), 'items'),
    note: async (path) => {
      const v = await call<ReporterNote & { markdown?: string; content?: string }>('GET', `${R.note}?${new URLSearchParams({ path })}`);
      return { ...v, body: v.body ?? v.markdown ?? v.content ?? '' };
    },
    observedBuild: (req) => call('POST', R.observedBuild, req),
    blobUrl: async (url) => {
      const res = await f(url, { headers: headers(), credentials: 'omit' });
      if (res.status === 401) opts.onUnauthorized();
      if (!res.ok) throw new ReporterApiError('ERROR', `Image failed (${res.status}).`, res.status);
      return URL.createObjectURL(await res.blob());
    },
    events: async (onEvent, signal) => {
      const res = await f(R.events, { headers: headers({ Accept: 'text/event-stream' }), credentials: 'omit', signal });
      if (res.status === 401) opts.onUnauthorized();
      if (!res.ok || !res.body) throw new ReporterApiError('ERROR', `Events failed (${res.status}).`, res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        const { events, rest } = splitStream(buf);
        buf = rest.length > 65_536 ? '' : rest;
        for (const e of events) onEvent(e);
      }
    },
  };
}
