import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import { APPROVALS_API, type AllowApprovalRequest, type Approval, type ApprovalList, type DenyApprovalRequest } from '@portal/contracts';
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

export const approvalsApi = {
  list: () => request<ApprovalList>('GET', APPROVALS_API.list),
  get: (id: string) => request<Approval>('GET', APPROVALS_API.one(id)),
  /** `value`: only for a kind that needs one (pool.secret_set): the typed secret, sent once. */
  allow: (id: string, value?: string) => request<Approval>('POST', APPROVALS_API.allow(id), (value !== undefined ? { value } : {}) satisfies AllowApprovalRequest),
  deny: (id: string, reason?: string) => request<Approval>('POST', APPROVALS_API.deny(id), (reason ? { reason } : {}) satisfies DenyApprovalRequest),
};
