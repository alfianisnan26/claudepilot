// The glance snapshot (docs/prd/glance-widgets.md §4): what the Sessions, Agents and Needs-attention widgets show, counted from the
// sources in one pass. Pure over `GlanceSources`, so the tests feed it fixtures whose counts are worked out by hand. Each block
// is read on its own: one that cannot be read comes back `ok: false` and empty, never as a zero that looks like a measurement.

import {
  attentionTier,
  GLANCE_LIMITS,
  type ChatRequest,
  type ChatSession,
  type Actor,
  type ChatTask,
  type CiRunSummary,
  type GlanceAgent,
  type GlanceAgents,
  type GlanceApproval,
  type GlanceAttention,
  type GlanceCiRun,
  type GlanceDeploy,
  type GlanceSession,
  type GlanceSessions,
  type GlanceSnapshot,
  type GlanceTicket,
  type TicketItem,
} from '@portal/contracts';

/**
 * Where the snapshot reads from: one function per kind of object, each on behalf of an actor (the authorization seam's `Actor`). The
 * adapters are `authz.ts`: they keep to what the actor may see, and today's one owner sees everything. Tests hand in fixtures.
 */
export interface GlanceSources {
  /** The sessions `actor` may see (archived and ended ones too), newest activity first. */
  sessions(actor: Actor): ChatSession[];
  /** One session's open requests that `actor` may DECIDE (seeing a session is not enough to answer for it), oldest first. */
  requests(actor: Actor, sessionId: string): ChatRequest[];
  /** One session's sub-agents and background tasks that are running (T-2368: never its history), for a session `actor` may see. */
  runningTasks(actor: Actor, sessionId: string): ChatTask[];
  /** Tickets waiting on `actor` (assigned to a person and not closed): all of them counted, the top few listed. */
  tickets(actor: Actor): { count: number; items: TicketItem[] };
  /** Failed CI runs `actor` may see that still stand (see `failedRuns`): all of them counted, the top few listed. */
  failedRuns(actor: Actor, now: number): { count: number; items: CiRunSummary[] };
  /** Runs `actor` may see that hold a deploy job for a person's approval (see `waitingDeploys`): all counted, the newest few listed. */
  deploys(actor: Actor): { count: number; items: CiRunSummary[] };
}

/** A line of untrusted or long text, whitespace folded and cut with an ellipsis. */
const clip = (text: string | null | undefined, max: number): string => {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const clipOrNull = (text: string | null | undefined, max: number): string | null => clip(text, max) || null;

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** The list's order (chat-sessions FR2): by need, then the latest activity. */
const byUrgency = (a: ChatSession, b: ChatSession) => attentionTier(a) - attentionTier(b) || time(b.lastActivityAt) - time(a.lastActivityAt);

/** Working, starting, or asking for an answer: something is going on in it right now. */
const isActive = (s: ChatSession) => s.state === 'working' || s.state === 'starting' || s.state === 'waiting';

const asks = (s: ChatSession) => s.waiting > 0 || s.state === 'waiting';

/* ---------- Sessions ---------- */

/** Its running sub-agent tasks (only a live process has any) and the workers it started that are working, starting or waiting. */
function agentsUnder(s: ChatSession, open: ChatSession[], tasksOf: (id: string) => ChatTask[]): number {
  const tasks = s.process === 'live' ? tasksOf(s.id).filter((t) => t.status === 'running').length : 0;
  return tasks + open.filter((w) => w.parentId === s.id && w.id !== s.id && isActive(w)).length;
}

/** The Home page's order: pinned first (the latest pinned first), then the latest activity. */
const byPinThenRecent = (a: ChatSession, b: ChatSession) =>
  Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || time(b.pinnedAt ?? '') - time(a.pinnedAt ?? '') || time(b.lastActivityAt) - time(a.lastActivityAt);

function sessionsBlock(sessions: ChatSession[], tasksOf: (id: string) => ChatTask[]): GlanceSessions {
  const shown = sessions.filter((s) => !s.archivedAt);
  const open = shown.filter((s) => s.state !== 'ended');
  const openIds = new Set(open.map((s) => s.id));
  const item = (s: ChatSession): GlanceSession => ({
    id: s.id,
    title: clip(s.title, 80) || 'Untitled',
    state: s.state,
    workspaceId: s.workspaceId,
    claudeId: s.claudeId,
    claudeName: s.claudeName,
    lastActivityAt: s.lastActivityAt,
    waiting: s.waiting,
    waitingFor: clipOrNull(s.waitingFor, 120),
    pinned: !!s.pinnedAt,
    branch: clipOrNull(s.worktree?.branch, 80),
    agents: s.state === 'ended' ? 0 : agentsUnder(s, open, tasksOf),
  });
  // A worker shows under the session that started it ("2 agents"), not as a session of its own, unless the person pinned it.
  const started = open.filter((s) => s.pinnedAt || !s.parentId || s.parentId === s.id || !openIds.has(s.parentId));
  return {
    ok: true,
    running: open.filter((s) => s.state === 'working' || s.state === 'starting').length,
    waiting: open.filter(asks).length,
    open: open.length,
    interrupted: open.filter((s) => s.state === 'interrupted').length,
    items: [...shown].sort(byUrgency).slice(0, GLANCE_LIMITS.sessions).map(item),
    recent: [...started].sort(byPinThenRecent).slice(0, GLANCE_LIMITS.recent).map(item),
  };
}

/* ---------- Agents ---------- */

/** The deepest nesting drawn; a chain longer than the portal's own depth cap (at most 4) is a data problem, not something to show. */
const MAX_DEPTH = 8;

function agentsBlock(sessions: ChatSession[], tasksOf: (id: string) => ChatTask[]): GlanceAgents {
  const live = sessions.filter((s) => !s.archivedAt && s.state !== 'ended');
  const byId = new Map(live.map((s) => [s.id, s]));
  const hasParent = (s: ChatSession) => !!s.parentId && s.parentId !== s.id && byId.has(s.parentId);
  const kids = new Map<string, ChatSession[]>();
  for (const s of [...live].sort(byUrgency)) if (hasParent(s)) kids.set(s.parentId!, [...(kids.get(s.parentId!) ?? []), s]);

  // Only a process that is running can have running tasks (a sleeping or lost one has ended them).
  const running = (s: ChatSession): ChatTask[] =>
    s.process === 'live' ? tasksOf(s.id).filter((t) => t.status === 'running').sort((a, b) => time(a.startedAt) - time(b.startedAt)) : [];

  const seen = new Set<string>();
  const subtree = (s: ChatSession, depth: number): GlanceAgent[] => {
    if (seen.has(s.id) || depth > MAX_DEPTH) return [];
    seen.add(s.id);
    const worker = hasParent(s);
    const tasks = running(s);
    const below = (kids.get(s.id) ?? []).flatMap((c) => subtree(c, depth + 1));
    // A worker is listed while it is active; a parent only to say where the agents under it belong.
    if (!(worker ? isActive(s) || tasks.length > 0 || below.length > 0 : tasks.length > 0 || below.length > 0)) return [];
    const self: GlanceAgent = {
      key: s.id,
      depth,
      kind: worker ? 'worker' : 'session',
      sessionId: s.id,
      taskId: null,
      title: clip(s.title, 80) || 'Untitled',
      role: null,
      state: s.state,
      since: null,
      stoppable: s.state === 'working',
    };
    const own: GlanceAgent[] = tasks.map((t) => ({
      key: `${s.id}/${t.taskId}`,
      depth: depth + 1,
      kind: 'task',
      sessionId: s.id,
      taskId: t.taskId,
      title: clip(t.description, 100) || clip(t.subagentType, 40) || 'Agent',
      role: clipOrNull(t.subagentType, 40),
      state: 'running',
      since: t.startedAt,
      stoppable: true,
    }));
    return [self, ...own, ...below];
  };

  const roots = live.filter((s) => !hasParent(s)).sort(byUrgency);
  const rows = roots.flatMap((r) => subtree(r, 0));
  // A cycle (a parent chain that loops) leaves its members without a root: they are not an agent tree, so they are not drawn.
  const agents = rows.filter((r) => r.kind === 'task' || (r.kind === 'worker' && (r.state === 'working' || r.state === 'starting' || r.state === 'waiting')));
  return {
    ok: true,
    running: agents.length,
    waiting: agents.filter((r) => r.kind === 'worker' && r.state === 'waiting').length,
    rows: rows.slice(0, GLANCE_LIMITS.agents),
    more: Math.max(0, rows.length - GLANCE_LIMITS.agents),
  };
}

/* ---------- Needs attention ---------- */

/** A label that is only the tool call's id (the sub-agent's name was not known yet) says nothing to a person. */
const agentNameOf = (label: string | null): string | null => (label && !/^toolu_/i.test(label) ? clipOrNull(label, 60) : null);

function approvalsBlock(sessions: ChatSession[], requestsOf: (id: string) => ChatRequest[]): GlanceAttention['approvals'] {
  const all: GlanceApproval[] = [];
  for (const s of sessions) {
    if (s.archivedAt || s.state === 'ended' || s.waiting <= 0) continue;
    for (const r of requestsOf(s.id))
      all.push({
        sessionId: s.id,
        sessionTitle: clip(s.title, 80) || 'Untitled',
        workspaceId: s.workspaceId,
        claudeId: s.claudeId,
        claudeName: s.claudeName,
        requestId: r.requestId,
        kind: r.kind,
        toolName: r.toolName,
        title: clip(r.title, 80) || 'Use a tool',
        detail: clipOrNull(r.detail, 240),
        // Not folded or cut here: what is being allowed is shown as the portal stored it (whole, up to its own cap).
        full: r.full && r.full.trim() ? r.full : null,
        fullCut: r.fullCut === true,
        agentName: agentNameOf(r.agentLabel),
        createdAt: r.createdAt,
      });
  }
  // The one that has waited longest first, as the session page answers them.
  all.sort((a, b) => time(a.createdAt) - time(b.createdAt));
  return { ok: true, count: all.length, items: all.slice(0, GLANCE_LIMITS.approvals) };
}

const ticketOf = (t: TicketItem): GlanceTicket => ({
  id: t.id,
  summary: clip(t.summary, 140),
  priority: t.priority,
  type: t.type,
  status: t.status,
  workspaceId: t.workspaceId,
  updatedAt: t.updatedAt,
});

const ciOf = (r: CiRunSummary): GlanceCiRun => ({
  id: r.id,
  number: r.number,
  repo: clip(r.repo, 64),
  pipeline: clip(r.pipeline, 64),
  branch: clipOrNull(r.branch, 80),
  subject: clipOrNull(r.subject, 120),
  reason: r.reason,
  finishedAt: r.finishedAt,
  workspaceId: r.workspaceId,
});

const deployOf = (r: CiRunSummary): GlanceDeploy => ({
  id: r.id,
  number: r.number,
  repo: clip(r.repo, 64),
  pipeline: clip(r.pipeline, 64),
  job: clip(r.jobs.find((j) => j.status === 'waiting')?.id ?? '', 64) || 'deploy',
  branch: clipOrNull(r.branch, 80),
  workspaceId: r.workspaceId,
  startedAt: r.startedAt,
});

/** Reads one block; a source that throws leaves its block unreadable and everything else as it was. */
function read<T>(fn: () => T, unreadable: T, log?: (what: string, e: unknown) => void, what = ''): T {
  try {
    return fn();
  } catch (e) {
    log?.(what, e);
    return unreadable;
  }
}

export function buildSnapshot(src: GlanceSources, actor: Actor, now: number, log?: (what: string, e: unknown) => void): GlanceSnapshot {
  // The sessions are read once and shared by the three blocks that need them.
  let sessions: ChatSession[] | null = null;
  try {
    sessions = src.sessions(actor);
  } catch (e) {
    log?.('sessions', e);
  }
  const noSessions: GlanceSessions = { ok: false, running: 0, waiting: 0, open: 0, interrupted: 0, items: [], recent: [] };
  // Tasks are read once per session however many blocks ask (the Sessions block counts them, the Agents block lists them).
  const taskCache = new Map<string, ChatTask[]>();
  const tasksOf = (id: string): ChatTask[] => {
    let t = taskCache.get(id);
    if (!t) taskCache.set(id, (t = src.runningTasks(actor, id)));
    return t;
  };
  const noAgents: GlanceAgents = { ok: false, running: 0, waiting: 0, rows: [], more: 0 };
  const noApprovals: GlanceAttention['approvals'] = { ok: false, count: 0, items: [] };

  const list = sessions;
  const approvals = list ? read(() => approvalsBlock(list, (id) => src.requests(actor, id)), noApprovals, log, 'approvals') : noApprovals;
  const tickets = read(
    () => {
      const t = src.tickets(actor);
      return { ok: true, count: t.count, items: t.items.slice(0, GLANCE_LIMITS.tickets).map(ticketOf) };
    },
    { ok: false, count: 0, items: [] as GlanceTicket[] },
    log,
    'tickets',
  );
  const ci = read(
    () => {
      const c = src.failedRuns(actor, now);
      return { ok: true, count: c.count, items: c.items.slice(0, GLANCE_LIMITS.ci).map(ciOf) };
    },
    { ok: false, count: 0, items: [] as GlanceCiRun[] },
    log,
    'ci',
  );
  const deploys = read(
    () => {
      const d = src.deploys(actor);
      return { ok: true, count: d.count, items: d.items.slice(0, GLANCE_LIMITS.deploys).map(deployOf) };
    },
    { ok: false, count: 0, items: [] as GlanceDeploy[] },
    log,
    'deploys',
  );
  return {
    at: new Date(now).toISOString(),
    sessions: list ? read(() => sessionsBlock(list, tasksOf), noSessions, log, 'sessions') : noSessions,
    agents: list ? read(() => agentsBlock(list, tasksOf), noAgents, log, 'agents') : noAgents,
    attention: { count: approvals.count + tickets.count + ci.count + deploys.count, approvals, tickets, ci, deploys },
  };
}

/**
 * Failed CI runs that still need a look: failed, finished within `windowMs`, and still the latest of their pipeline on their branch
 * (a later run that passed, or is queued or running, takes the failure off; a cancelled one does not). A branch counts once however
 * many of its runs failed. `list` is the CI service's own listing (newest run first); only its public filters are used.
 */
export function failedRuns(
  ci: { list(f: { status?: CiRunSummary['status'][]; repo?: string; pipeline?: string; branch?: string; limit?: number }): { items: CiRunSummary[] } },
  now: number,
  windowMs: number,
  top: number,
): { count: number; items: CiRunSummary[] } {
  const since = now - windowMs;
  const failed = ci.list({ status: ['failed'], limit: 200 }).items.filter((r) => !!r.finishedAt && time(r.finishedAt) >= since);
  if (!failed.length) return { count: 0, items: [] };
  const key = (r: Pick<CiRunSummary, 'repoId' | 'pipeline' | 'ref'>) => `${r.repoId}\u0000${r.pipeline}\u0000${r.ref}`;
  // The newest non-cancelled run of each pipeline and ref among the latest runs of all kinds; the few a busy week pushed out of that
  // listing are asked about one by one.
  const latest = new Map<string, string>();
  for (const r of ci.list({ limit: 200 }).items) if (r.status !== 'cancelled' && !latest.has(key(r))) latest.set(key(r), r.id);
  const standing: CiRunSummary[] = [];
  const done = new Set<string>();
  for (const r of failed) {
    const k = key(r);
    if (done.has(k)) continue; // an older failure of the same branch is not a second problem
    done.add(k);
    let newest = latest.get(k);
    // A tag has no branch to ask by: its failure stands for the window.
    if (newest === undefined && r.branch !== null)
      newest = ci.list({ repo: r.repoId, pipeline: r.pipeline, branch: r.branch, status: ['queued', 'running', 'passed', 'failed'], limit: 1 }).items[0]?.id;
    if (newest === undefined || newest === r.id) standing.push(r);
  }
  standing.sort((a, b) => time(b.finishedAt ?? '') - time(a.finishedAt ?? ''));
  return { count: standing.length, items: standing.slice(0, top) };
}

/** Runs holding a deploy job for a person's approval: running, with a job `waiting` (local-git-ci FR41). Newest first, all counted. */
export function waitingDeploys(ci: { list(f: { status?: CiRunSummary['status'][]; limit?: number }): { items: CiRunSummary[] } }, top: number): { count: number; items: CiRunSummary[] } {
  const held = ci.list({ status: ['running'], limit: 200 }).items.filter((r) => r.jobs.some((j) => j.status === 'waiting'));
  return { count: held.length, items: held.slice(0, top) };
}
