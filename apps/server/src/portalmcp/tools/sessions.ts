import { randomUUID } from 'node:crypto';
import { AppError } from '@isnanme/core';
import { CHAT_AGENT_NAME, type ChatEvent, type ChatPermissionMode, type ChatRequest, type ChatSession } from '@portal/contracts';
import { z } from 'zod';
import { paginate, pageInput } from '../paging.js';
import { PortalToolError, registerPortalTool, type PortalToolContext } from '../registry.js';
import { cleanText } from '../sanitize.js';
import { assertCanChange, uiLink } from './common.js';
import type { PortalToolDeps } from './deps.js';

const STATES = ['starting', 'idle', 'working', 'waiting', 'interrupted', 'ended'] as const;
/** Over MCP a session's mode is limited to the ones that can't run commands unasked (PRD §13.3): never Auto (the controller refuses it too) or Bypass. */
const MCP_MODES = ['plan', 'default', 'acceptEdits', 'dontAsk'] as const satisfies readonly ChatPermissionMode[];
/** Slash commands MCP text may use (chat-sessions FR13): anything else is for the terminal. */
const SLASH_ALLOWED = new Set(['/compact', '/context', '/reload-plugins']);
/** What `session_get` returns of the transcript stays under this, so one call fits a result block. */
const EVENT_CHARS_MAX = 12_000;

const sessionBrief = (s: ChatSession, ctx: PortalToolContext) => ({
  id: s.id,
  workspace_id: s.workspaceId,
  title: ctx.untrusted(s.title, 'agent'),
  state: s.state,
  waiting_for_input: s.waiting,
  origin: s.origin,
  started_by: s.startedBy ?? null,
  ticket_id: s.ticketId ?? null,
  agent: s.agent ?? null,
  model: s.model,
  effort: s.effort,
  mode: s.mode,
  folder: s.cwd,
  turns: s.turns,
  cost_usd: Math.round(s.costUsd * 10_000) / 10_000,
  created_at: s.createdAt,
  last_activity_at: s.lastActivityAt,
  ended_reason: ctx.untrusted(s.endedReason, 'runtime'),
});

/** The requests a session still waits on, read from its transcript (a request event with no resolution after it). */
function pendingRequests(events: ChatEvent[]): ChatRequest[] {
  const open = new Map<string, ChatRequest>();
  for (const e of events) {
    if (e.kind === 'request' && e.request) open.set(e.request.requestId, e.request);
    else if (e.kind === 'resolved' && e.requestId) open.delete(e.requestId);
  }
  return [...open.values()];
}

/** Chat sessions over MCP (portal-mcp PRD §13.3). The write tools are listed only while session control is on. */
export function registerSessionTools(deps: PortalToolDeps): void {
  const { store, chat } = deps;

  const need = (id: string): ChatSession => {
    const s = chat.get(id);
    if (!s) throw new AppError('NOT_FOUND', 'No such session. List them with session_list.');
    return s;
  };

  registerPortalTool({
    name: 'session_list',
    title: 'List chat sessions',
    description: 'Chat sessions across workspaces, newest activity first: state, what they wait for, model, mode, cost and the ticket they work on. Session titles are text an agent wrote.',
    scope: 'read',
    input: z.object({
      workspace_id: z.string().max(100).optional(),
      state: z.enum(STATES).optional(),
      ticket_id: z.string().max(64).optional().describe('Only sessions working on this ticket.'),
      include_ended: z.boolean().optional().describe('Ended sessions are left out unless this is true (or state is ended).'),
      ...pageInput,
    }),
    handler(ctx, args) {
      const all = chat
        .list({ workspaceId: args.workspace_id, ticketId: args.ticket_id })
        .filter((s) => !s.archivedAt && (args.state ? s.state === args.state : args.include_ended || s.state !== 'ended'));
      const page = paginate(all, args, { w: args.workspace_id, s: args.state, t: args.ticket_id, e: args.include_ended });
      return { summary: `${page.total} sessions.`, sessions: page.items.map((s) => sessionBrief(s, ctx)), total: page.total, next_cursor: page.next_cursor };
    },
  });

  registerPortalTool({
    name: 'session_get',
    title: 'Get a chat session',
    description:
      'One session: its state, what it waits for, and, only when asked with max_events, the latest transcript events (text an agent wrote, labelled untrusted). With wait_seconds it returns early on any change.',
    scope: 'read',
    input: z.object({
      id: z.string().max(80),
      after_seq: z.number().int().min(0).optional().describe('Only events after this sequence number.'),
      max_events: z.number().int().min(0).max(100).optional().describe('How many events to return (default 0: none).'),
      wait_seconds: z.number().int().min(0).max(25).optional().describe('Wait up to this long for something to change first.'),
    }),
    async handler(ctx, args) {
      let s = need(args.id);
      if (args.wait_seconds) {
        const since = `${s.state}|${s.lastSeq}|${s.waiting}`;
        const until = Date.now() + args.wait_seconds * 1000;
        while (Date.now() < until && !ctx.signal.aborted) {
          await new Promise((r) => setTimeout(r, 300));
          s = need(args.id);
          if (`${s.state}|${s.lastSeq}|${s.waiting}` !== since) break;
        }
      }
      const out: Record<string, unknown> = { summary: `${s.id} is ${s.state}${s.waiting ? ` (${s.waiting} waiting)` : ''}.`, session: sessionBrief(s, ctx), ui: uiLink(`/admin/sessions/${s.id}`) };
      const all = chat.history(s.id, 0);
      out.pending_requests = pendingRequests(all).map((r) => ({
        request_id: r.requestId,
        kind: r.kind,
        tool: r.toolName,
        agent: r.agentLabel,
        title: ctx.untrusted(r.title, 'agent'),
        detail: ctx.untrusted(r.detail, 'agent'),
        asked_at: r.createdAt,
      }));
      const max = args.max_events ?? 0;
      if (max > 0) {
        const after = args.after_seq ?? 0;
        const picked = all.filter((e) => e.seq > after && ['user', 'assistant', 'result', 'error', 'system', 'tool_use'].includes(e.kind)).slice(-max);
        let used = 0;
        const events: unknown[] = [];
        for (const e of picked) {
          const item = { seq: e.seq, at: e.at, kind: e.kind, tool: e.toolName ?? null, actor: e.actor ?? null, text: ctx.untrusted(e.text ?? null, 'agent', 600) };
          used += JSON.stringify(item).length;
          if (used > EVENT_CHARS_MAX) {
            out.truncated = true;
            break;
          }
          events.push(item);
        }
        out.events = events;
        out.next_seq = picked.length ? picked[picked.length - 1]!.seq : after;
      }
      return out;
    },
  });

  registerPortalTool({
    name: 'session_interrupt',
    title: 'Stop what a session is doing',
    description: 'Interrupts the running turn of a session. Work already done is kept, and the session stays open.',
    scope: 'operate',
    hints: { idempotent: true },
    input: z.object({ id: z.string().max(80) }),
    async handler(ctx, args) {
      need(args.id);
      await chat.interrupt(args.id);
      ctx.affected(`session:${args.id}`);
      return { summary: `Interrupted ${args.id}.`, session: sessionBrief(need(args.id), ctx) };
    },
  });

  registerPortalTool({
    name: 'session_end',
    title: 'End a chat session',
    description: 'Ends a session for good: its process stops. The transcript stays and can be read.',
    scope: 'operate',
    hints: { destructive: true, idempotent: true },
    input: z.object({ id: z.string().max(80) }),
    async handler(ctx, args) {
      need(args.id);
      await chat.end(args.id);
      ctx.affected(`session:${args.id}`);
      return { summary: `Ended ${args.id}.`, session: sessionBrief(need(args.id), ctx) };
    },
  });

  /* ---------- Session control: listed only while the switch is on (FR15) ---------- */

  registerPortalTool({
    name: 'session_start',
    title: 'Start a chat session',
    description:
      'Starts a Claude Code session in a workspace, optionally with a first prompt. The folder must already be trusted in the portal; this cannot trust it. Sessions started here never run in bypass mode.',
    scope: 'admin',
    requires: 'session_control',
    hints: { destructive: true, openWorld: true },
    input: z.object({
      workspace_id: z.string().max(100),
      folder: z.string().max(300).optional().describe('Default ~/work.'),
      prompt: z.string().max(8000).optional().describe('The first message.'),
      title: z.string().max(80).optional(),
      claude_id: z.string().max(80).optional(),
      ticket_id: z.string().max(64).optional(),
      agent: z.string().regex(CHAT_AGENT_NAME).optional().describe('The agent it runs as, .claude/agents/<agent>.md in its folder (e.g. implementer): its prompt, its tools and its model, at every start of its process.'),
    }),
    async handler(ctx, args) {
      assertCanChange(store, 'workspace');
      const s = await chat.create(
        { workspaceId: args.workspace_id, cwd: args.folder, title: args.title, claudeId: args.claude_id, ticketId: args.ticket_id, ...(args.agent ? { agent: args.agent } : {}) },
        { actor: ctx.actor },
      );
      if (args.prompt) await sendChecked(s.id, args.prompt, undefined, ctx);
      ctx.affected(`session:${s.id}`, `workspace:${s.workspaceId}`);
      return { summary: `Started session ${s.id} in ${s.workspaceId}.`, session: sessionBrief(s, ctx), ui: uiLink(`/admin/sessions/${s.id}`) };
    },
  });

  /** A message from this caller: no human origin, and only the slash commands MCP text may use. */
  async function sendChecked(id: string, text: string, priority: 'next' | 'later' | undefined, ctx: PortalToolContext) {
    const first = text.trimStart().split(/\s/)[0] ?? '';
    if (first.startsWith('/') && !SLASH_ALLOWED.has(first)) throw new PortalToolError('FORBIDDEN', `${cleanText(first, 40)} is for the terminal. Over MCP only ${[...SLASH_ALLOWED].join(', ')} are allowed.`);
    await chat.send(id, randomUUID(), text, { actor: ctx.actor, ...(ctx.actorLabel ? { actorLabel: ctx.actorLabel } : {}), ...(priority ? { priority } : {}) });
  }

  registerPortalTool({
    name: 'session_send',
    title: 'Send a message to a session',
    description:
      'Sends a message to a session, as the portal and not as a person (the transcript says so). priority next steers the turn now running; later waits for it to end.',
    scope: 'admin',
    requires: 'session_control',
    hints: { destructive: true, openWorld: true },
    input: z.object({ id: z.string().max(80), text: z.string().min(1).max(8000), priority: z.enum(['next', 'later']).optional() }),
    async handler(ctx, args) {
      need(args.id);
      assertCanChange(store, 'workspace');
      await sendChecked(args.id, args.text, args.priority, ctx);
      ctx.affected(`session:${args.id}`);
      return { summary: `Sent to ${args.id}.`, session: sessionBrief(need(args.id), ctx) };
    },
  });

  registerPortalTool({
    name: 'session_respond',
    title: 'Answer or deny a session’s request',
    description:
      'Answers what a session waits for: deny a tool or plan, or (admin, after confirmation) allow it. The confirmation shows the exact request. The first answer per request wins.',
    scope: 'operate',
    requires: 'session_control',
    hints: { destructive: true },
    input: z.object({
      id: z.string().max(80),
      request_id: z.string().max(120),
      decision: z.enum(['allow', 'deny']),
      message: z.string().max(2000).optional().describe('Why, for a deny.'),
      confirm_token: z.string().optional(),
    }),
    async handler(ctx, args) {
      need(args.id);
      const open = pendingRequests(chat.history(args.id, 0)).find((r) => r.requestId === args.request_id);
      if (!open) throw new PortalToolError('CONFLICT', 'That request is no longer open.');
      if (args.decision === 'allow') {
        if (ctx.principal.scope !== 'admin') throw new PortalToolError('SCOPE_REQUIRED', 'Allowing a request needs the admin scope; denying needs operate.', { required: 'admin', granted: ctx.principal.scope });
        const gate = ctx.confirm(
          args,
          { allow: { kind: open.kind, tool: open.toolName, title: ctx.untrusted(open.title, 'agent'), detail: ctx.untrusted(open.detail, 'agent') }, session: args.id },
          `${args.id}:${open.requestId}`,
        );
        if (gate) return gate;
      }
      await chat.respond(args.id, args.request_id, args.decision === 'allow' ? 'allow' : 'deny', { actor: ctx.actor, note: args.message });
      ctx.affected(`session:${args.id}`);
      return { summary: `${args.decision === 'allow' ? 'Allowed' : 'Denied'} request ${args.request_id}.`, session: sessionBrief(need(args.id), ctx) };
    },
  });

  registerPortalTool({
    name: 'session_configure',
    title: 'Change a session’s model, effort or mode',
    description: 'Changes what applies from the session’s next request. Over MCP the mode is limited to plan, default, acceptEdits and dontAsk; auto and bypass are never available here (a person turns them on in the app).',
    scope: 'admin',
    requires: 'session_control',
    hints: { destructive: true, idempotent: true },
    input: z.object({ id: z.string().max(80), model: z.string().max(80).optional(), effort: z.string().max(20).optional(), mode: z.enum(MCP_MODES).optional() }),
    async handler(ctx, args) {
      need(args.id);
      if (!args.model && !args.effort && !args.mode) throw new AppError('VALIDATION_FAILED', 'Give a model, an effort or a mode.');
      if (args.model) await chat.control(args.id, 'model', { model: args.model });
      if (args.effort) await chat.control(args.id, 'effort', { effort: args.effort });
      if (args.mode) await chat.control(args.id, 'mode', { mode: args.mode });
      ctx.affected(`session:${args.id}`);
      return { summary: `Updated ${args.id}.`, session: sessionBrief(need(args.id), ctx) };
    },
  });
}
