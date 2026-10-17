// The chat module's reads for the General Manager (general-manager PRD §9.1, T-968 S2a), read only:
// - `approvals_list`: every open request a live session waits on, any age (attention_list shows only those past ten minutes), only of the
//   sessions the caller may view. Nothing here answers one: deciding is a person's, in the session.
// - `crew_limits_get`: a lead's caps on workers (its own and the global settings), the slots in use, its workers. The portal keeps no queue
//   of slices, so `queue` is "unavailable", never a guess.
// Declared in ./authz.ts (CHAT_MANAGER_TOOL_POLICIES). Titles, summaries and agent labels are an agent's text: labelled untrusted.

import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import { sessionRef, type ChatSession, type ManagerApprovalRow, type ManagerCrewLimits } from '@portal/contracts';
import { actorOfPrincipal, can } from '../authz/seam.js';
import { portalTools, z, type ToolRegistry } from '../portalmcp/registry.js';
import { effectiveMaxWorkers, type AgentCaps } from './agents.js';
import { declareChatManagerPolicies, NO_SESSION } from './authz.js';

export interface ChatManagerDeps {
  db: () => DatabaseSync | null;
  chat: { get(id: string): ChatSession | null; list(filter?: { parentId?: string }): ChatSession[] };
  /** The global caps (Settings › Sessions); null when none are installed. */
  caps: () => AgentCaps | null;
  now?: () => number;
}

interface RequestRow {
  session_id: string;
  request_id: string;
  kind: string;
  tool_name: string | null;
  agent_label: string | null;
  title: string;
  created_at: string;
  session_title: string;
}

const sessionLink = (id: string) => `/admin/sessions/${encodeURIComponent(id)}`;

export function registerChatManagerTools(d: ChatManagerDeps, registry: ToolRegistry = portalTools): void {
  declareChatManagerPolicies();
  const now = d.now ?? Date.now;

  registry.register({
    name: 'approvals_list',
    title: 'Open approvals',
    description:
      'Every open request a running session waits on (a tool approval, a question), oldest first, of the sessions you may view: session, tool, the controller\'s short summary, who asked, since when and the session\'s link. ' +
      'Any age (attention_list shows only those waiting ten minutes or more). Read only: you can not answer one; a person answers it in the session.',
    scope: 'read',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      session_id: z.string().max(100).optional().describe('Only this session\'s.'),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    handler(ctx, args) {
      const db = d.db();
      if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not available.');
      const actor = actorOfPrincipal(ctx.principal);
      // The same rule as Needs you: a request of a process that runs a turn (an idle or gone process can not be answered).
      // No SQL LIMIT: the can() filter runs on every open row, then the page is cut, so `total` counts what the caller may see.
      const stmt = db.prepare(
        `SELECT r.session_id, r.request_id, r.kind, r.tool_name, r.agent_label, r.title, r.created_at, s.title AS session_title
         FROM chat_requests r JOIN chat_sessions s ON s.id = r.session_id
         WHERE r.answered_at IS NULL AND s.state IN ('waiting', 'working') AND s.process = 'live' ${args.session_id ? 'AND r.session_id = ?' : ''}
         ORDER BY r.created_at, r.rowid`,
      );
      const limit = args.limit ?? 50;
      const shown: RequestRow[] = [];
      let total = 0;
      for (const raw of stmt.iterate(...(args.session_id ? [args.session_id] : []))) {
        const r = raw as unknown as RequestRow;
        if (!can(actor, 'view', sessionRef(r.session_id)).allow) continue;
        total++;
        if (shown.length < limit) shown.push(r);
      }
      const t = now();
      const approvals: ManagerApprovalRow[] = shown.map((r) => ({
        session_id: r.session_id,
        session_title: ctx.untrusted(r.session_title, 'agent', 120),
        request_id: r.request_id,
        kind: ctx.untrusted(r.kind, 'agent', 40),
        tool: ctx.untrusted(r.tool_name, 'agent', 120),
        summary: ctx.untrusted(r.title, 'agent', 200),
        agent: ctx.untrusted(r.agent_label, 'agent', 60),
        since: r.created_at,
        age_s: Math.max(0, Math.floor((t - Date.parse(r.created_at)) / 1000)),
        link: sessionLink(r.session_id),
      }));
      return {
        summary: total ? `${total} open request${total === 1 ? '' : 's'}${shown.length < total ? `, ${shown.length} shown` : ''}` : 'No session waits on a request.',
        total,
        approvals,
      };
    },
  });

  registry.register({
    name: 'crew_limits_get',
    title: 'A lead\'s worker limits',
    description:
      'For one lead session: how many workers it may run at once (its own limit clamped to the global setting), whether it may use sub-agents, the global caps (depth, workers per session, workers and messages an hour), ' +
      'the slots in use and free, and its running workers. queue is "unavailable": the portal keeps no queue of slices (a lead\'s queue is its status file). Read only.',
    scope: 'read',
    hints: { readOnly: true, idempotent: true },
    input: z.object({ session_id: z.string().min(1).max(100).describe('The lead session.') }),
    handler(ctx, args) {
      const lead = d.chat.get(args.session_id);
      if (!lead) throw new AppError('NOT_FOUND', NO_SESSION);
      const caps = d.caps();
      // Each worker passes can(view) on its own: with more than one user a lead's worker need not be the caller's (multi-user is planned).
      const actor = actorOfPrincipal(ctx.principal);
      const workers = d.chat
        .list({ parentId: lead.id })
        .filter((s) => s.parentId === lead.id && s.state !== 'ended' && can(actor, 'view', sessionRef(s.id)).allow);
      const max = effectiveMaxWorkers(caps, lead.maxWorkers);
      const result: ManagerCrewLimits = {
        session_id: lead.id,
        global: caps ? { max_depth: caps.maxDepth, max_children: caps.maxChildren, spawns_per_hour: caps.spawnsPerHour, messages_per_hour: caps.messagesPerHour } : 'unavailable',
        own_max_workers: lead.maxWorkers ?? null,
        max_workers: max,
        subagents: lead.subagents ?? true,
        in_use: workers.length,
        free: max === null ? null : Math.max(0, max - workers.length),
        workers: workers.map((w) => ({ id: w.id, title: ctx.untrusted(w.title, 'agent', 120), state: w.state, agent: w.agent ?? null, created_at: w.createdAt })),
        queue: 'unavailable',
      };
      return { summary: `${result.in_use} of ${max ?? 'unlimited'} workers in use; sub-agents ${result.subagents ? 'on' : 'off'}`, ...result };
    },
  });
}
