import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  REPORTER_ROUTES,
  TICKET_API,
  type ReporterConfig,
  type ReporterDeployment,
  type ReporterEvidence,
  type TicketReporterEvidence,
  type UpdateReporterConfigRequest,
} from '@portal/contracts';
import { api, ApiError } from '@/lib/api';

/** The owner's side of the reporter (cookie session, same contract as lib/api: `{ data }` or an ApiError). */
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

const fill = (route: string, params: Record<string, string>) => route.replace(/:([a-zA-Z]+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ''));

export const reporterApi = {
  config: (bucket: string) => request<ReporterConfig>('GET', fill(REPORTER_ROUTES.config, { key: bucket })),
  saveConfig: (bucket: string, body: UpdateReporterConfigRequest) => request<ReporterConfig>('PUT', fill(REPORTER_ROUTES.config, { key: bucket }), body),
  deployments: (bucket: string, repo?: string) =>
    request<ReporterDeployment[]>('GET', `${REPORTER_ROUTES.deploymentsOwner}?${new URLSearchParams({ bucket, ...(repo ? { repo } : {}) })}`),
  /** The ticket's reporter evidence, or null when it did not come from the widget (404). */
  evidence: async (ticketId: string): Promise<TicketReporterEvidence | null> => {
    try {
      return await request<TicketReporterEvidence>('GET', fill(REPORTER_ROUTES.evidence, { id: ticketId }));
    } catch (e) {
      if ((e as ApiError).status === 404) return null;
      throw e;
    }
  },
  /** One capture's evidence bundle (a JSON attachment of the ticket). */
  bundle: async (ticketId: string, attachmentId: number): Promise<ReporterEvidence> => {
    const res = await fetch(TICKET_API.attachment(ticketId, attachmentId), { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError('NOT_FOUND', `Evidence unavailable (${res.status}).`, res.status);
    return (await res.json()) as ReporterEvidence;
  },
};
