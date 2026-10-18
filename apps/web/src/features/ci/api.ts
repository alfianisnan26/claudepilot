import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  CI_API,
  type BumpRequest,
  type BumpTarget,
  type CiBranch,
  type CiBranchBackfillResult,
  type CiEnvironment,
  type CiReleaseReportSetting,
  type UpdateCiAutoApproveRequest,
  type CiLogChunk,
  type CiPipelineInfo,
  type CiRepo,
  type CiRun,
  type CiRunner,
  type UpsertCiRunnerRequest,
  type CiRunFilter,
  type CiRunPage,
  type ConnectCiRepoRequest,
  type CreateCiRepoRequest,
  type MergeCiRequest,
  type MergeCiResult,
  type StartCiRunRequest,
  type UpdateCiRepoRequest,
  type ValidateCiRequest,
  type ValidateCiResult,
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

function query(f: CiRunFilter): string {
  const q = new URLSearchParams();
  if (f.workspace) q.set('workspace', f.workspace);
  if (f.repo) q.set('repo', f.repo);
  if (f.pipeline) q.set('pipeline', f.pipeline);
  if (f.branch) q.set('branch', f.branch);
  if (f.status?.length) q.set('status', f.status.join(','));
  if (f.ticket) q.set('ticket', f.ticket);
  if (f.session) q.set('session', f.session);
  if (f.cursor) q.set('cursor', f.cursor);
  if (f.limit) q.set('limit', String(f.limit));
  return q.size ? `?${q}` : '';
}

export const ciApi = {
  runs: (filter: CiRunFilter = {}) => request<CiRunPage>('GET', `${CI_API.runs}${query(filter)}`),
  run: (id: string) => request<CiRun>('GET', CI_API.run(id)),
  log: (id: string, job: string, step: number, offset: number) =>
    request<CiLogChunk>('GET', `${CI_API.log(id)}?job=${encodeURIComponent(job)}&step=${step}&offset=${offset}`),
  cancel: (id: string) => request<CiRun>('POST', CI_API.cancel(id)),
  rerun: (id: string) => request<CiRun>('POST', CI_API.rerun(id)),
  bumpTargets: (id: string) => request<BumpTarget[]>('GET', CI_API.bump(id)),
  bump: (id: string, body: BumpRequest) => request<CiRun>('POST', CI_API.bump(id), body),
  start: (body: StartCiRunRequest) => request<CiRun>('POST', CI_API.runs, body),
  repos: (workspace?: string) =>
    request<CiRepo[]>('GET', `${CI_API.repos}${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`),
  createRepo: (body: CreateCiRepoRequest) => request<CiRepo>('POST', CI_API.repos, body),
  updateRepo: (id: string, body: UpdateCiRepoRequest) => request<CiRepo>('PATCH', CI_API.repo(id), body),
  removeRepo: (id: string) => request<{ ok: true }>('DELETE', CI_API.repo(id)),
  connect: (id: string, body: ConnectCiRepoRequest) => request<CiRepo>('POST', CI_API.connect(id), body),
  branches: (id: string) => request<CiBranch[]>('GET', CI_API.branches(id)),
  pipelines: (id: string, ref?: string) =>
    request<CiPipelineInfo[]>('GET', `${CI_API.pipelines(id)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`),
  merge: (id: string, body: MergeCiRequest) => request<MergeCiResult>('POST', CI_API.merge(id), body),
  validate: (body: ValidateCiRequest) => request<ValidateCiResult>('POST', CI_API.validate, body),
  approve: (id: string, job: string) => request<CiRun>('POST', CI_API.approve(id), { job }),
  reject: (id: string, job: string) => request<CiRun>('POST', CI_API.reject(id), { job }),
  environments: (repoId: string) => request<CiEnvironment[]>('GET', CI_API.environments(repoId)),
  setEnvironment: (repoId: string, name: string, isProtected: boolean) =>
    request<CiEnvironment>('PUT', CI_API.environment(repoId, name), { protected: isProtected }),
  /** Runners (T-557, T-576): GET is for anyone who can see the workspace; PUT and DELETE are a person with manage on it. The id is the workspace's, as one path segment. */
  runners: () => request<CiRunner[]>('GET', CI_API.runners),
  upsertRunner: (body: UpsertCiRunnerRequest) =>
    request<CiRunner>('PUT', `${CI_API.runners}/${encodeURIComponent(body.workspaceId)}`, body),
  removeRunner: (workspaceId: string) => request<{ ok: true }>('DELETE', `${CI_API.runners}/${encodeURIComponent(workspaceId)}`),
  /** The auto-approve rule (T-110 FR41a): a person with manage; off, dry or on (on only for a protected environment). */
  setAutoApprove: (repoId: string, name: string, body: UpdateCiAutoApproveRequest) =>
    request<CiEnvironment>('PUT', CI_API.environmentAutoApprove(repoId, name), body),
  /** Release reports (T-591, T-1079): the remote's setting (null: off); set by a person with manage; the branch backfill takes a count only. */
  releaseReport: (repoId: string) => request<CiReleaseReportSetting | null>('GET', CI_API.releaseReport(repoId)),
  setReleaseReport: (repoId: string, setting: CiReleaseReportSetting | null) =>
    request<CiReleaseReportSetting | null>('PUT', CI_API.releaseReport(repoId), { setting }),
  backfillReleaseReport: (repoId: string, count: number) =>
    request<CiBranchBackfillResult>('POST', CI_API.releaseReportBackfill(repoId), { count }),
};
