import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import { api, ApiError } from '@/lib/api';

/**
 * The portal API for a pool type's own routes (`/api/skills`, `/api/personas`, …): `{ data }` on
 * success, an ApiError otherwise, the same contract as lib/api's client. On 401 it asks lib/api for the
 * admin state once, which tells the app the session ended the way every other call does. `body` is JSON,
 * or a raw upload (a zip, a FormData) with its own headers.
 */
export async function poolRequest<T>(method: string, path: string, body?: unknown, raw?: { body: BodyInit; headers?: Record<string, string> }): Promise<T> {
  let res: Response;
  try {
    res = await track(
      fetch(path, {
        method,
        credentials: 'same-origin',
        headers: raw ? raw.headers : body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body),
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
