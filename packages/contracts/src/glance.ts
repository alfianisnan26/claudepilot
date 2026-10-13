// Glance widgets (docs/prd/glance-widgets.md): what the Sessions, Agents and Needs-attention widgets show, counted once on the
// server so a header render never costs five requests. One snapshot per request: every count is whole, the lists carry only the
// few top items (`GLANCE_LIMITS`), and a source the portal could not read says so (`ok: false`) instead of reading as zero.
// Nothing here is estimated: a count is a count of stored rows. Text from a workspace (a command, a commit subject) is untrusted.

import type { ChatRequestKind, ChatSessionState } from './chat.js';
import type { CiReason } from './ci.js';
import type { TicketPriority, TicketStatus, TicketType } from './tickets.js';

export const GLANCE_API = {
  /** GET: the snapshot (`GlanceSnapshot`). The live topic `glance` says when to ask again. */
  snapshot: '/api/glance',
} as const;

/** How many items each list carries. The counts beside them are whole. */
export const GLANCE_LIMITS = { sessions: 8, recent: 8, agents: 16, approvals: 6, tickets: 5, ci: 5, deploys: 5 } as const;

/**
 * A failed CI run needs attention for this long after it finished, and only while no later run of its pipeline on its branch
 * has started (a run that passed, or is running again, takes it off the list).
 */
export const GLANCE_CI_WINDOW_MS = 3 * 24 * 3_600_000;

/** One session as the Sessions widget lists it. */
export interface GlanceSession {
  id: string;
  title: string;
  state: ChatSessionState;
  workspaceId: string;
  /** The Claude it runs on (its palette colour is keyed by this); empty until one is recorded. */
  claudeId: string;
  claudeName: string | null;
  lastActivityAt: string;
  /** Requests waiting for an answer, and what the oldest asks in a few words ("Run a command: npm test"). */
  waiting: number;
  waitingFor: string | null;
  /** The person pinned it (the Sessions list's Pinned chip): the Home page lists it first. */
  pinned: boolean;
  /** The branch of the git worktree it runs in, or null for a plain folder. */
  branch: string | null;
  /** Agents running under it now: its running sub-agent tasks and the workers it started that are working, starting or waiting. */
  agents: number;
}

export interface GlanceSessions {
  /** False when the sessions could not be read: the rest of the block is empty, not zero. */
  ok: boolean;
  /** Working or starting. */
  running: number;
  /** Sessions with a request waiting for an answer. */
  waiting: number;
  /** Not ended and not archived. */
  open: number;
  /** Open sessions whose process was lost (interrupted): each needs a person to resume or end it. */
  interrupted: number;
  /** By need (waiting, interrupted, working, idle, ended), the latest activity first within each; archived ones are left out. */
  items: GlanceSession[];
  /**
   * The Home page's list: open sessions a person started (not a worker of another open session, unless pinned), pinned first (the
   * latest pinned first), then the latest activity first. Capped at `GLANCE_LIMITS.recent`; `open` is the whole count.
   */
  recent: GlanceSession[];
}

/**
 * One row of the agents tree, depth first. A `session` is a parent shown for context, a `worker` a session another session started
 * (`parentId`), a `task` a sub-agent or background task inside a session.
 */
export interface GlanceAgent {
  /** Unique in the snapshot: the session id, or `<session id>/<task id>` for a task. */
  key: string;
  depth: number;
  kind: 'session' | 'worker' | 'task';
  sessionId: string;
  taskId: string | null;
  title: string;
  /** A task's type ("Explore"), else null. */
  role: string | null;
  /** A session's state, or `running` for a task (only running tasks are listed). */
  state: ChatSessionState | 'running';
  /** When a task started; null for a session. */
  since: string | null;
  /** Stop does something now: a working session's turn (the composer's Stop), or a running task (`stop_task`). */
  stoppable: boolean;
}

export interface GlanceAgents {
  ok: boolean;
  /** Workers working, starting or waiting, plus running tasks: what the compact chip counts. A parent shown for context is not one. */
  running: number;
  /** Those of them that wait for an answer. */
  waiting: number;
  rows: GlanceAgent[];
  /** Rows left out of `rows` by the cap. */
  more: number;
}

/** One request waiting for a decision, with what is being approved. Answered through the chat socket (`respond`), never here. */
export interface GlanceApproval {
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  claudeId: string;
  claudeName: string | null;
  requestId: string;
  kind: ChatRequestKind;
  toolName: string | null;
  /** What it asks, in a few words: "Run a command", "Edit a file", "Use <tool>". */
  title: string;
  /** One line of the target (the command, the file, the URL), folded and cut at 200 characters by the portal: the row's summary, never what is approved on. */
  detail: string | null;
  /**
   * What is being allowed, whole and exactly as the tool will get it (`ChatRequest.full`: up to 8,000 characters, redacted): the card and
   * the widget show this in a block that scrolls. Null: the portal has nothing to show for this request.
   */
  full: string | null;
  /** `full` was cut at the cap: more is asked than can be shown, so the request can only be denied. */
  fullCut: boolean;
  /** The sub-agent that asked, as people read it, or null when the session itself did. */
  agentName: string | null;
  createdAt: string;
}

/** A ticket waiting on a person (assigned to a person, not closed): the tickets PRD's "Needs you". */
export interface GlanceTicket {
  id: string;
  summary: string;
  priority: TicketPriority;
  type: TicketType;
  status: TicketStatus;
  workspaceId: string | null;
  updatedAt: string;
}

/** A failed CI run that still stands (`GLANCE_CI_WINDOW_MS`). */
export interface GlanceCiRun {
  id: string;
  number: number;
  repo: string;
  pipeline: string;
  /** Null for a tag. */
  branch: string | null;
  /** The tip commit's first line (untrusted text), clipped. */
  subject: string | null;
  reason: CiReason | null;
  finishedAt: string | null;
  workspaceId: string;
}

/** A CI run holding a deploy job for a person's approval (local-git-ci FR41): the job is `waiting`, the run `running`. */
export interface GlanceDeploy {
  /** The run's id (approve or reject it on the run's page). */
  id: string;
  number: number;
  repo: string;
  pipeline: string;
  /** The job that waits (its id in the pipeline). */
  job: string;
  /** Null for a tag. */
  branch: string | null;
  workspaceId: string;
  /** When the run started (the job's own wait start is not in a run's summary). */
  startedAt: string | null;
}

export interface GlanceAttention {
  /** What waits on a person: the sum of the four counts below, over the sources that could be read. The installed app's badge shows it. */
  count: number;
  approvals: { ok: boolean; count: number; items: GlanceApproval[] };
  tickets: { ok: boolean; count: number; items: GlanceTicket[] };
  ci: { ok: boolean; count: number; items: GlanceCiRun[] };
  /** Runs holding a deploy for a person's approval. */
  deploys: { ok: boolean; count: number; items: GlanceDeploy[] };
}

export interface GlanceSnapshot {
  /** When the portal built it. */
  at: string;
  sessions: GlanceSessions;
  agents: GlanceAgents;
  attention: GlanceAttention;
}
