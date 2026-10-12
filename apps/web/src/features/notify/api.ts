import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  NOTIFY_API,
  type CreateChannelRequest,
  type CreatedChannel,
  type NotifyActRequest,
  type NotifyActResult,
  type NotifyDelivery,
  type NotifyDestination,
  type NotifyHistoryPage,
  type NotifyOverview,
  type NotifyUserPrefs,
  type RegisterPushRequest,
  type SessionNotifyRequest,
  type TestResult,
  type UpdateDestinationRequest,
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

export const notifyApi = {
  overview: () => request<NotifyOverview>('GET', NOTIFY_API.overview),
  registerPush: (body: RegisterPushRequest) => request<NotifyDestination>('POST', NOTIFY_API.push, body),
  createChannel: (body: CreateChannelRequest) => request<CreatedChannel>('POST', NOTIFY_API.destinations, body),
  update: (id: string, body: UpdateDestinationRequest) => request<NotifyDestination>('PATCH', NOTIFY_API.destination(id), body),
  remove: (id: string) => request<{ ok: true }>('DELETE', NOTIFY_API.destination(id)),
  test: (id: string) => request<TestResult>('POST', NOTIFY_API.test(id)),
  rotateSecret: (id: string) => request<{ signingSecret: string }>('POST', NOTIFY_API.rotateSecret(id)),
  log: (destination: string, limit = 20) => request<NotifyDelivery[]>('GET', `${NOTIFY_API.log}?destination=${encodeURIComponent(destination)}&limit=${limit}`),
  history: (opts: { before?: string | null; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.before) q.set('before', opts.before);
    if (opts.limit) q.set('limit', String(opts.limit));
    return request<NotifyHistoryPage>('GET', `${NOTIFY_API.history}${q.size ? `?${q}` : ''}`);
  },
  clearHistory: () => request<{ ok: true }>('DELETE', NOTIFY_API.history),
  markRead: (upTo?: string) => request<{ unread: number }>('POST', NOTIFY_API.read, upTo ? { upTo } : {}),
  sessionDone: (sessionId: string) => request<{ done: boolean }>('GET', NOTIFY_API.session(sessionId)),
  setSessionDone: (sessionId: string, done: boolean) => request<{ ok: true }>('PUT', NOTIFY_API.session(sessionId), { done } satisfies SessionNotifyRequest),
  prefs: () => request<NotifyUserPrefs>('GET', NOTIFY_API.prefs),
  setPrefs: (body: NotifyUserPrefs) => request<NotifyUserPrefs>('PUT', NOTIFY_API.prefs, body),
  /** The page's own answer path (the Allow and Deny buttons are the worker's; this is for a person who taps a token, which the page never holds). */
  act: (body: NotifyActRequest) => request<NotifyActResult>('POST', NOTIFY_API.act, body),
};
