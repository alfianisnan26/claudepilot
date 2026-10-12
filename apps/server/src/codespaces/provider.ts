// The Codespaces lifecycle provider (docs/prd/codespaces-poc.md §7, §8): GitHub's REST API mapped to the portal's runtime words.
// Stateless: every call takes the token it acts with (the service opens it from the Secrets store just before the call and drops it).
// Paths are built here from validated parts only (`owner/repo`, a codespace name, a ref); nothing a person typed reaches a URL unchecked.

import { AppError } from '@isnanme/core';
import {
  CODESPACE_LIMITS,
  GITHUB_CODESPACE_STATES,
  type CodespaceCreateOptions,
  type CodespaceCreateRequest,
  type CodespaceMachine,
  type CodespacePhase,
  type CodespaceRepo,
  type CodespaceView,
  type GitHubCodespaceState,
} from '@portal/contracts';
import type { GitHubClient } from './github.js';

/** Every GitHub state mapped (PRD §7 table). Unknown strings (a state GitHub adds later) map to `unknown`, never to running. */
export const PHASE_OF: Record<GitHubCodespaceState, CodespacePhase> = {
  Unknown: 'unknown',
  Created: 'creating',
  Queued: 'creating',
  Provisioning: 'creating',
  Awaiting: 'creating',
  Starting: 'starting',
  Available: 'running',
  ShuttingDown: 'stopping',
  Shutdown: 'stopped',
  Archived: 'stopped',
  Exporting: 'busy',
  Updating: 'busy',
  Rebuilding: 'busy',
  Moved: 'busy',
  Unavailable: 'error',
  Failed: 'error',
  Deleted: 'removed',
};

export function phaseOf(state: string): { state: GitHubCodespaceState; phase: CodespacePhase } {
  const known = (GITHUB_CODESPACE_STATES as readonly string[]).includes(state) ? (state as GitHubCodespaceState) : 'Unknown';
  return { state: known, phase: PHASE_OF[known] };
}

/** Phases that settle: a poll stops on these. */
export const SETTLED: ReadonlySet<CodespacePhase> = new Set(['running', 'stopped', 'error', 'removed']);

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const REF = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._\/-]{1,250}$/;
const DEVCONTAINER = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._\/-]{1,300}\.json$/;
const MACHINE = /^[A-Za-z0-9_-]{1,64}$/;
const GEO = new Set(['EuropeWest', 'SoutheastAsia', 'UsEast', 'UsWest']);

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const text = (v: unknown, max = 200): string | null => (typeof v === 'string' && v ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function checkRepo(repo: unknown): string {
  if (typeof repo !== 'string' || !REPO.test(repo)) throw invalid('repo', 'Use owner/name.');
  return repo;
}
export function checkName(name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name)) throw invalid('name', 'That is not a codespace name.');
  return name;
}
function checkRef(ref: unknown): string {
  if (typeof ref !== 'string' || !REF.test(ref)) throw invalid('ref', 'That is not a branch or tag name.');
  return ref;
}

function machineOf(m: Json | null | undefined): CodespaceMachine | null {
  if (!m || typeof m !== 'object') return null;
  return {
    name: text(m.name, 64) ?? '',
    displayName: text(m.display_name, 120) ?? text(m.name, 64) ?? '',
    cpus: num(m.cpus) ?? 0,
    memoryBytes: num(m.memory_in_bytes) ?? 0,
    storageBytes: num(m.storage_in_bytes) ?? 0,
    prebuild: text(m.prebuild_availability, 20),
  };
}

/** One codespace as GitHub sends it, as the portal shows it. Text from GitHub is clipped and stripped of control characters. */
export function viewOf(c: Json, connectionId: string, attached: boolean): CodespaceView {
  const { state, phase } = phaseOf(String(c.state ?? ''));
  const g = c.git_status && typeof c.git_status === 'object' ? (c.git_status as Json) : null;
  return {
    name: text(c.name, 100) ?? '',
    displayName: text(c.display_name, 100),
    repo: text(c.repository?.full_name, 140) ?? '',
    ref: text(g?.ref, 250),
    state,
    phase,
    machine: machineOf(c.machine),
    devcontainerPath: text(c.devcontainer_path, 300),
    location: text(c.location, 40),
    idleTimeoutMinutes: num(c.idle_timeout_minutes),
    idleTimeoutNotice: text(c.idle_timeout_notice, 300),
    retentionPeriodMinutes: num(c.retention_period_minutes),
    retentionExpiresAt: text(c.retention_expires_at, 40),
    stopNotice: text(c.last_known_stop_notice, 300),
    pendingOperation: c.pending_operation === true,
    git: g ? { ref: text(g.ref, 250), ahead: num(g.ahead) ?? 0, behind: num(g.behind) ?? 0, uncommitted: g.has_uncommitted_changes === true, unpushed: g.has_unpushed_changes === true } : null,
    webUrl: typeof c.web_url === 'string' && /^https:\/\//.test(c.web_url) ? c.web_url.slice(0, 300) : null,
    billableOwner: text(c.billable_owner?.login, 40),
    createdAt: text(c.created_at, 40),
    lastUsedAt: text(c.last_used_at, 40),
    attached,
    connectionId,
  };
}

/** Validates a create request against GitHub's documented limits (PRD §6) and builds GitHub's body. */
export function createBody(req: Partial<CodespaceCreateRequest>, repositoryId: number): Record<string, unknown> {
  const body: Record<string, unknown> = { repository_id: repositoryId };
  if (req.ref !== undefined && req.ref !== '') body.ref = checkRef(req.ref);
  if (req.machine !== undefined && req.machine !== '') {
    if (typeof req.machine !== 'string' || !MACHINE.test(req.machine)) throw invalid('machine', 'Pick a machine type from the list.');
    body.machine = req.machine;
  }
  if (req.devcontainerPath !== undefined && req.devcontainerPath !== '') {
    if (typeof req.devcontainerPath !== 'string' || !DEVCONTAINER.test(req.devcontainerPath)) throw invalid('devcontainerPath', 'Pick a devcontainer.json from the list.');
    body.devcontainer_path = req.devcontainerPath;
  }
  const L = CODESPACE_LIMITS;
  if (req.idleTimeoutMinutes !== undefined) {
    const n = req.idleTimeoutMinutes;
    if (!Number.isInteger(n) || n < L.idleTimeoutMinutes.min || n > L.idleTimeoutMinutes.max) throw invalid('idleTimeoutMinutes', `Use ${L.idleTimeoutMinutes.min} to ${L.idleTimeoutMinutes.max} minutes.`);
    body.idle_timeout_minutes = n;
  }
  if (req.retentionPeriodMinutes !== undefined) {
    const n = req.retentionPeriodMinutes;
    if (!Number.isInteger(n) || n < L.retentionPeriodMinutes.min || n > L.retentionPeriodMinutes.max) throw invalid('retentionPeriodMinutes', 'Use 0 to 43200 minutes (30 days).');
    body.retention_period_minutes = n;
  }
  if (req.displayName !== undefined && req.displayName !== '') {
    if (typeof req.displayName !== 'string' || req.displayName.length > L.displayNameMax || /[\u0000-\u001f\u007f]/.test(req.displayName)) throw invalid('displayName', `Use at most ${L.displayNameMax} characters.`);
    body.display_name = req.displayName;
  }
  if (req.geo !== undefined) {
    if (!GEO.has(req.geo)) throw invalid('geo', 'Pick a region from the list.');
    body.geo = req.geo;
  }
  return body;
}

const repoOf = (r: Json): CodespaceRepo => ({ id: num(r.id) ?? 0, fullName: text(r.full_name, 140) ?? '', private: r.private === true, defaultBranch: text(r.default_branch, 250) });

/** The REST calls. Each takes the token it acts with; none keeps it. */
export class CodespacesProvider {
  constructor(private readonly gh: GitHubClient) {}

  async repos(token: string, query: string | null): Promise<CodespaceRepo[]> {
    const q = query?.trim().toLowerCase().slice(0, 100) ?? '';
    const res = await this.gh.api<Json[]>(token, 'GET', '/user/repos?per_page=100&sort=pushed');
    const list = Array.isArray(res.body) ? res.body.map(repoOf) : [];
    return (q ? list.filter((r) => r.fullName.toLowerCase().includes(q)) : list).slice(0, 50);
  }

  async repo(token: string, repo: string): Promise<CodespaceRepo> {
    const res = await this.gh.api<Json>(token, 'GET', `/repos/${checkRepo(repo)}`);
    return repoOf(res.body ?? {});
  }

  async options(token: string, repo: string, ref: string | null): Promise<CodespaceCreateOptions> {
    const r = await this.repo(token, repo);
    const q = ref ? `?ref=${encodeURIComponent(checkRef(ref))}` : '';
    const [dc, machines, defaults] = await Promise.all([
      this.gh.api<Json>(token, 'GET', `/repos/${repo}/codespaces/devcontainers?per_page=100`),
      this.gh.api<Json>(token, 'GET', `/repos/${repo}/codespaces/machines${q}`),
      // Pre-flight needs the Codespaces WRITE permission (PRD §6): a read-only token still gets the form, without defaults.
      this.gh.api<Json>(token, 'GET', `/repos/${repo}/codespaces/new${q}`).catch(() => null),
    ]);
    return {
      repo: r,
      devcontainers: (Array.isArray(dc.body?.devcontainers) ? dc.body.devcontainers : []).slice(0, 50).map((d: Json) => ({ path: text(d.path, 300) ?? '', name: text(d.display_name ?? d.name, 100) })),
      machines: (Array.isArray(machines.body?.machines) ? machines.body.machines : []).slice(0, 30).map(machineOf).filter((m: CodespaceMachine | null): m is CodespaceMachine => !!m),
      defaults: defaults?.body?.defaults
        ? { location: text(defaults.body.defaults.location, 40), devcontainerPath: text(defaults.body.defaults.devcontainer_path, 300), billableOwner: text(defaults.body.billable_owner?.login, 40) }
        : null,
      limits: CODESPACE_LIMITS,
    };
  }

  async list(token: string): Promise<Json[]> {
    const res = await this.gh.api<Json>(token, 'GET', '/user/codespaces?per_page=100');
    return Array.isArray(res.body?.codespaces) ? res.body.codespaces : [];
  }

  async get(token: string, name: string): Promise<Json> {
    return (await this.gh.api<Json>(token, 'GET', `/user/codespaces/${checkName(name)}`)).body ?? {};
  }

  async create(token: string, req: Partial<CodespaceCreateRequest>): Promise<Json> {
    const repo = await this.repo(token, checkRepo(req.repo));
    return (await this.gh.api<Json>(token, 'POST', '/user/codespaces', createBody(req, repo.id))).body ?? {};
  }

  async start(token: string, name: string): Promise<Json> {
    return (await this.gh.api<Json>(token, 'POST', `/user/codespaces/${checkName(name)}/start`)).body ?? {};
  }

  async stop(token: string, name: string): Promise<Json> {
    return (await this.gh.api<Json>(token, 'POST', `/user/codespaces/${checkName(name)}/stop`)).body ?? {};
  }

  async remove(token: string, name: string): Promise<void> {
    await this.gh.api(token, 'DELETE', `/user/codespaces/${checkName(name)}`);
  }
}
