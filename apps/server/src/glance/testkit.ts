// Test helpers for the glance aggregator (not used by the portal): fixtures shaped like what the chat controller, tickets and CI
// hand it, and a fake CI listing that filters and orders like the real one (newest run first).

import type { Actor, ChatRequest, ChatSession, ChatTask, CiRunSummary, TicketItem } from '@portal/contracts';
import { actorString } from '../authz/seam.js';
import type { GlanceSources } from './build.js';

/** A signed-in person with this user id (the seam's `Actor`), for tests with more than one user. */
export const userActor = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'test', via: 'ui' });

export const NOW = Date.parse('2026-10-12T12:00:00.000Z');
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** The ISO time `ms` before NOW. */
export const ago = (ms: number): string => new Date(NOW - ms).toISOString();

export function session(over: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    workspaceId: 'docker/dev',
    cwd: '/home/node',
    title: `Session ${over.id}`,
    state: 'idle',
    origin: 'ui',
    model: null,
    mode: 'default',
    effort: null,
    ultracode: false,
    ultracodeAvailable: false,
    process: 'live',
    context: null,
    costUsd: 0,
    turns: 0,
    lastSeq: 0,
    waiting: 0,
    waitingFor: null,
    createdAt: ago(DAY),
    lastActivityAt: ago(HOUR),
    endedReason: null,
    claudeId: 'c1',
    claudeName: 'Default',
    predecessorId: null,
    successorId: null,
    archivedAt: null,
    pinnedAt: null,
    ticketId: null,
    parentId: null,
    worktree: null,
    startedBy: 'ui',
    bypassCapable: false,
    claudeSessionId: '',
    previousClaudes: [],
    switching: null,
    ...over,
  };
}

export function request(over: Partial<ChatRequest> & { requestId: string }): ChatRequest {
  return { kind: 'tool', toolName: 'Bash', agentLabel: null, title: 'Run a command', detail: 'npm test', full: 'npm test', fullCut: false, createdAt: ago(MIN), ...over };
}

export function task(over: Partial<ChatTask> & { taskId: string }): ChatTask {
  return {
    toolUseId: null,
    description: 'A task',
    subagentType: null,
    model: null,
    status: 'running',
    tokens: null,
    toolUses: null,
    durationMs: null,
    summary: null,
    startedAt: ago(MIN),
    endedAt: null,
    ...over,
  };
}

export function ticket(over: Partial<TicketItem> & { id: string }): TicketItem {
  return {
    number: Number(over.id.replace(/\D/g, '')) || 1,
    type: 'request',
    priority: 'normal',
    status: 'open',
    summary: 'A ticket',
    description: '',
    tags: [],
    source: 'agent',
    reporter: { kind: 'token', ref: null, label: 'Agent', workspaceId: null },
    assignee: { kind: 'user', name: 'admin' },
    workspaceId: null,
    worktree: null,
    closingSummary: null,
    createdAt: ago(DAY),
    updatedAt: ago(HOUR),
    closedAt: null,
    assigneeSession: null,
    sessionEnded: false,
    ...over,
  };
}

/** A CI run as the list shows it; `created` is how long before NOW it was made, `finished` when it ended (null: not finished). */
export function run(
  over: Partial<CiRunSummary> & { id: string; repoId: string; pipeline: string; branch: string | null; status: CiRunSummary['status']; created: number; finished?: number | null },
): CiRunSummary {
  const { created, finished, ...rest } = over;
  return {
    number: 1,
    workspaceId: 'docker/dev',
    repo: over.repoId,
    trigger: 'push',
    ref: over.branch === null ? 'refs/tags/v1' : `refs/heads/${over.branch}`,
    tag: over.branch === null ? 'v1' : null,
    sha: 'a'.repeat(40),
    subject: null,
    reason: over.status === 'failed' ? 'step_failed' : null,
    actor: 'push',
    actorLabel: null,
    cancelledBy: null,
    cancelledByLabel: null,
    cancelNote: null,
    ticketId: null,
    sessionId: null,
    rerunOf: null,
    createdAt: ago(created),
    startedAt: ago(created),
    finishedAt: finished === undefined || finished === null ? null : ago(finished),
    durationMs: null,
    jobs: [],
    ...rest,
  };
}

/**
 * The CI service's `list` over fixed runs: the public filters it supports (status, repo, pipeline, branch, limit), newest run first.
 * `recent` caps what an unfiltered-by-ref listing returns, to stand in for a busy week that pushed older runs out of the newest 200.
 */
export function fakeCi(runs: CiRunSummary[], recent = 200) {
  const calls: unknown[] = [];
  return {
    calls,
    list(f: { status?: CiRunSummary['status'][]; repo?: string; pipeline?: string; branch?: string; limit?: number } = {}) {
      calls.push(f);
      const asked = !!(f.repo || f.pipeline || f.branch);
      const items = runs
        .filter((r) => (!f.status || f.status.includes(r.status)) && (!f.repo || r.repoId === f.repo) && (!f.pipeline || r.pipeline === f.pipeline) && (!f.branch || r.branch === f.branch))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const limit = asked || f.status ? (f.limit ?? 50) : Math.min(f.limit ?? 50, recent);
      return { items: items.slice(0, limit), total: items.length, active: items.filter((r) => r.status === 'queued' || r.status === 'running').length };
    },
  };
}

/**
 * Sources over fixed data, with the open requests and tasks of each session by id. Whoever asks is recorded in `asked` (as `actorString`),
 * so a test can see that every read was made on behalf of an actor.
 */
export function sources(over: {
  sessions?: ChatSession[];
  requests?: Record<string, ChatRequest[]>;
  tasks?: Record<string, ChatTask[]>;
  tickets?: { count: number; items: TicketItem[] };
  failed?: { count: number; items: CiRunSummary[] };
  deploys?: { count: number; items: CiRunSummary[] };
}): GlanceSources & { reads: { sessions: number }; asked: string[] } {
  const reads = { sessions: 0 };
  const asked: string[] = [];
  return {
    reads,
    asked,
    sessions: (actor) => (asked.push(actorString(actor)), reads.sessions++, over.sessions ?? []),
    requests: (actor, id) => (asked.push(actorString(actor)), over.requests?.[id] ?? []),
    tasks: (actor, id) => (asked.push(actorString(actor)), over.tasks?.[id] ?? []),
    tickets: (actor) => (asked.push(actorString(actor)), over.tickets ?? { count: 0, items: [] }),
    failedRuns: (actor) => (asked.push(actorString(actor)), over.failed ?? { count: 0, items: [] }),
    deploys: (actor) => (asked.push(actorString(actor)), over.deploys ?? { count: 0, items: [] }),
  };
}
