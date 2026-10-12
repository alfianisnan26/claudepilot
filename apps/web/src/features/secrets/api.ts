import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import { SECRETS_API, type SecretRotateRequest, type SecretRotationView, type SecretsMigrationCheck, type SecretVersionView, type WorkspaceSecrets } from '@portal/contracts';
import { poolRequest } from '@/features/pools/request';
import { ApiError } from '@/lib/api';

/** Secrets & env's own calls; sets themselves go through the shared pool API (`api.pools`). */
async function request<T>(method: string, path: string): Promise<T> {
  let res: Response;
  try {
    res = await track(fetch(path, { method, credentials: 'same-origin' }));
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok && isApiSuccess<T>(json)) return json.data;
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}

export const secretsApi = {
  /** What a workspace's sets deliver, by name only. */
  workspace: (workspaceId: string) => request<WorkspaceSecrets>('GET', SECRETS_API.workspace(workspaceId)),
  /** The migration check (FR15): home-folder credentials, by existence only. */
  check: (workspaceId: string) => request<SecretsMigrationCheck>('POST', SECRETS_API.check(workspaceId)),
  /** Rotation (FR16): the new value is write-only. */
  rotate: (poolId: string, entryId: string, body: SecretRotateRequest) => poolRequest<SecretRotationView>('POST', SECRETS_API.rotate(poolId, entryId), body),
  rotations: (poolId: string) => poolRequest<SecretRotationView[]>('GET', SECRETS_API.rotations(poolId)),
  versions: (poolId: string, entryId: string) => poolRequest<SecretVersionView[]>('GET', SECRETS_API.versions(poolId, entryId)),
  revoke: (poolId: string, valueId: string, reason?: string) => poolRequest<SecretVersionView>('POST', SECRETS_API.revoke(poolId, valueId), { reason }),
};
