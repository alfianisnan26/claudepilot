import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  CONNECT_API,
  type ConnectEnrollment,
  type ConnectEnrollmentCreated,
  type ConnectEvent,
  type ConnectMaintenanceCommands,
  type ConnectNodeView,
  type ConnectPlanPreview,
  type ConnectScannedView,
  type ConnectSettings,
  type ConnectTargetRow,
  type ConnectTargetView,
  type CreateConnectEnrollmentRequest,
  type CreateConnectTargetRequest,
  type UpdateConnectNodeRequest,
  type UpdateConnectScannedRequest,
  type UpdateConnectSettingsRequest,
  type UpdateConnectTargetRequest,
} from '@portal/contracts';
import { api, ApiError } from '@/lib/api';

/** The Connect admin routes (`/api/connect`): `{ data }` on success, an ApiError otherwise (the MCP feature's way). */
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

export const connectApi = {
  list: () => request<ConnectTargetRow[]>('GET', CONNECT_API.targets),
  create: (body: CreateConnectTargetRequest) => request<ConnectEnrollmentCreated>('POST', CONNECT_API.targets, body),
  get: (id: string) => request<ConnectTargetView>('GET', CONNECT_API.target(id)),
  update: (id: string, body: UpdateConnectTargetRequest) => request<ConnectTargetView>('PATCH', CONNECT_API.target(id), body),
  /** `onWorkspaces` only when the target has some: the query is what the 428 asks for (and, with none, is left out). */
  remove: (id: string, onWorkspaces?: 'keep' | 'remove') => request<{ ok: true }>('DELETE', CONNECT_API.removeTarget(id, onWorkspaces)),
  check: (id: string) => request<ConnectTargetView>('POST', CONNECT_API.check(id)),
  enrollments: (id: string) => request<ConnectEnrollment[]>('GET', CONNECT_API.enrollments(id)),
  enroll: (id: string, body: CreateConnectEnrollmentRequest) => request<ConnectEnrollmentCreated>('POST', CONNECT_API.enrollments(id), body),
  revokeEnrollment: (id: string, enrollmentId: string) => request<{ ok: true }>('DELETE', CONNECT_API.enrollment(id, enrollmentId)),
  /** The token-less commands (upgrade, doctor): makes no token. */
  commands: (id: string) => request<ConnectMaintenanceCommands>('GET', CONNECT_API.commands(id)),
  plan: (id: string, enrollmentId: string) => request<ConnectPlanPreview>('GET', CONNECT_API.plan(id, enrollmentId)),
  events: (id: string, limit = 20) => request<ConnectEvent[]>('GET', `${CONNECT_API.events(id)}?limit=${limit}`),
  updateNode: (nodeId: string, body: UpdateConnectNodeRequest) => request<ConnectNodeView>('PATCH', CONNECT_API.node(nodeId), body),
  revokeNode: (nodeId: string) => request<{ ok: true }>('DELETE', CONNECT_API.node(nodeId)),
  rotateNode: (nodeId: string) => request<{ ok: true }>('POST', CONNECT_API.rotate(nodeId)),
  hideScanned: (id: string, body: UpdateConnectScannedRequest) => request<ConnectScannedView>('PATCH', CONNECT_API.scanned(id), body),
  settings: () => request<ConnectSettings>('GET', CONNECT_API.settings),
  saveSettings: (body: UpdateConnectSettingsRequest) => request<ConnectSettings>('PUT', CONNECT_API.settings, body),
};

/** The installer's text as this portal serves it (an open route, no token): what "View script" shows. Always this origin, whatever address the command names. */
export async function fetchScript(url: string): Promise<string> {
  let path = url;
  try {
    path = new URL(url, location.origin).pathname;
  } catch {
    // a bare path
  }
  const res = await fetch(path).catch(() => null);
  if (!res?.ok) throw new ApiError('SCRIPT_UNAVAILABLE', 'Could not load the script.', res?.status ?? 0);
  return res.text();
}
