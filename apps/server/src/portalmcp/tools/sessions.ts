import { randomUUID } from 'node:crypto';
import { AppError, isAppError } from '@isnanme/core';
import { APPROVAL_REASON_MAX, approvalPath, CHAT_AGENT_NAME, CHAT_MAX_WORKERS_MAX, sessionRef, workspaceRef, type ChatPermissionMode, type ChatSession } from '@portal/contracts';
import { z } from 'zod';
import { actorOfPrincipal, requireCan } from '../../authz/seam.js';
import { WORKER_REPORTS } from '../../chat/agents.js';
import { paginate, pageInput } from '../paging.js';
import { PortalToolError, portalTools, type PortalToolContext, type ToolRegistry } from '../registry.js';
import { cleanText } from '../sanitize.js';
import { NO_PARENT } from '../authz.js';
import { ticketKeyField } from '../../tickets/keys.js';
import { assertCanChange, costFields, resolveWorkspace, uiLink } from './common.js';
import type { PortalToolDeps } from './deps.js';

const STATES = ['starting', 'idle', 'working', 'waiting', 'interrupted', 'ended'] as const;
/**
 * The modes a session may be put in over MCP (PRD §13.3). PILOT-996 (D-103): Auto too, under the controller's rule (`autoModeAllowed`:
 * its parent's mode, `sessions.autonomousAuto`). Never Bypass directly: on `session_configure` it becomes a person's session.bypass
 * approval card (PILOT-1000), whose Allow is the acknowledgement; the caller's own acknowledgement is never taken (PILOT-996 c42754).
 */
const MCP_MODES = ['plan', 'default', 'acceptEdits', 'dontAsk', 'auto'] as const satisfies readonly ChatPermissionMode[];
/** Accepted by the schema so that a request for Bypass gets its card (session_configure) or its reason, never a bare validation error. */
const MCP_MODE_INPUT = z.enum([...MCP_MODES, 'bypassPermissions']);
export const MCP_BYPASS_REFUSED = 'Bypass over MCP needs a person’s approval (PILOT-1000). Ask for auto, or have a person turn Bypass on in the app.';
/** session_start: a session started over MCP is never bypass-capable, so a card for it could only fail. */
export const MCP_BYPASS_AT_START =
  'A session started over MCP can’t run in Bypass: it isn’t started bypass-capable. Start it in another mode; for a session a person started bypass-capable, ask with session_configure mode bypassPermissions (a person’s approval card).';
function mcpMode(mode: ChatPermissionMode | undefined): Exclude<ChatPermissionMode, 'bypassPermissions'> | undefined {
  if (mode === 'bypassPermissions') throw new PortalToolError('FORBIDDEN', MCP_BYPASS_REFUSED);
  return mode;
}
/** Slash commands MCP text may use (chat-sessions FR13): anything else is for the terminal. */
import { SLASH_ALLOWED, slashWord } from '../../chat/slash.js';
/** What `session_get` returns of the transcript stays under this, so one call fits a result block. */
const EVENT_CHARS_MAX = 12_000;
/** T-294: `session_get` lists at most this many of a session's workers (live ones first); the count is always whole. */
const WORKERS_MAX = 20;

const sessionBrief = (s: ChatSession, ctx: PortalToolContext) => ({
  id: s.id,
  workspace_id: s.workspaceId,
  title: ctx.untrusted(s.title, 'agent'),
  state: s.state,
  waiting_for_input: s.waiting,
  origin: s.origin,
  started_by: s.startedBy ?? null,
  ticket_id: s.ticketId ?? null,
  // T-1098: its bucket key (KONF-12) beside the stable id. T-1993: asked again with the caller's actor, so a bucket it may not view is not named.
  ...ticketKeyField(s.ticketId, actorOfPrincipal(ctx.principal)),
  // T-294: the tree (the session that started it) and who runs it (its role, its Claude).
  parent_id: s.parentId ?? null,
  agent: s.agent ?? null,
  max_workers: s.maxWorkers ?? null,
  subagents: s.subagents !== false,
  claude: s.claudeName ?? null,
  model: s.model,
  effort: s.effort,
  mode: s.mode,
  folder: s.cwd,
  turns: s.turns,
  ...costFields(s),
  created_at: s.createdAt,
  last_activity_at: s.lastActivityAt,
  ended_reason: ctx.untrusted(s.endedReason, 'runtime'),
});

/** The transcript kinds `session_get` returns with max_events. */
const TRANSCRIPT_KINDS = ['user', 'assistant', 'result', 'error', 'system', 'tool_use'] as const;

/** Chat sessions over MCP (portal-mcp PRD §13.3). The write tools are listed only while session control is on. */
export function registerSessionTools(
  deps: Pick<PortalToolDeps, 'store' | 'chat' | 'approvals'> & { workspaces?: Pick<PortalToolDeps['workspaces'], 'list' | 'resolve'> },
  registry: ToolRegistry = portalTools,
): void {
  const { store, chat, workspaces, approvals } = deps;
  const registerPortalTool: ToolRegistry['register'] = (tool) => registry.register(tool);

  const need = (id: string): ChatSession => {
    const s = chat.get(id);
    if (!s) throw new AppError('NOT_FOUND', 'No such session. List them with session_list.');
    return s;
  };

  /**
   * T-336: the lead a session_start names: a live session of the same workspace the caller may operate (the authz seam). Missing, ended,
   * elsewhere or refused are ONE answer, so the call tells nothing of a session the caller may not see. The limits on its workers (depth,
   * how many at once, how many an hour, a worker's own limits) are the controller's, checked at create as for session_spawn.
   */
  const leadFor = (raw: string, workspaceId: string, ctx: PortalToolContext): string => {
    const p = chat.get(raw);
    let ok = !!p && p.state !== 'ended' && !p.archivedAt && p.workspaceId === workspaceId.trim();
    if (ok) {
      try {
        requireCan(actorOfPrincipal(ctx.principal), 'operate', sessionRef(p!.id));
      } catch {
        ok = false;
      }
    }
    if (!ok) throw new AppError('NOT_FOUND', NO_PARENT);
    return p!.id;
  };

  /**
   * T-349: the workspace a session_start names, in any form the workspace tools take (the stable `ws_…` id, `<target>/<name>`,
   * `<target>/<label>`, a former label, or a name or label only one workspace has), through the shared resolver. The resolved workspace
   * is asked of the seam again (the dispatch asked about the form given), and a refusal is the resolver's own not found: never wider.
   */
  const workspaceFor = async (raw: string, ctx: PortalToolContext): Promise<string> => {
    if (!workspaces) return raw.trim();
    const w = resolveWorkspace(await workspaces.list(), raw, (ref) => workspaces.resolve?.(ref) ?? null);
    try {
      requireCan(actorOfPrincipal(ctx.principal), 'operate', workspaceRef(w.id));
    } catch {
      throw new AppError('NOT_FOUND', `No workspace “${raw.trim()}”. List them with workspace_list.`);
    }
    return w.id;
  };

  registerPortalTool({
    name: 'session_list',
    title: 'List chat sessions',
    description:
      'Chat sessions across workspaces, newest activity first: state, what they wait for, model, mode, cost, the ticket they work on, the session that started them (parent_id), their agent and Claude. Session titles are text an agent wrote. For a crew, parent_id lists the workers one session started. A ticket is T-12 or its bucket key (KONF-3); rows carry ticket_id and ticket_key.',
    scope: 'read',
    input: z.object({
      workspace_id: z.string().max(100).optional(),
      state: z.enum(STATES).optional(),
      ticket_id: z.string().max(64).optional().describe('Only sessions working on this ticket: T-12 or its bucket key (KONF-3).'),
      parent_id: z.string().max(80).optional().describe('Only the workers this session started.'),
      include_ended: z.boolean().optional().describe('Ended sessions are left out unless this is true (or state is ended).'),
      ...pageInput,
    }),
    handler(ctx, args) {
      const all = chat
        .list({ workspaceId: args.workspace_id, ticketId: args.ticket_id, ...(args.parent_id ? { parentId: args.parent_id } : {}) })
        .filter((s) => !s.archivedAt && (args.state ? s.state === args.state : args.include_ended || s.state !== 'ended'));
      const page = paginate(all, args, { w: args.workspace_id, s: args.state, t: args.ticket_id, p: args.parent_id, e: args.include_ended });
      return { summary: `${page.total} sessions.`, sessions: page.items.map((s) => sessionBrief(s, ctx)), total: page.total, next_cursor: page.next_cursor };
    },
  });

  registerPortalTool({
    name: 'session_get',
    title: 'Get a chat session',
    description:
      'One session: its state, what it waits for, the session that started it, its workers (id, title, state, Claude, waiting; at most 20, with their count) and, only when asked with max_events, the latest transcript events (text an agent wrote, labelled untrusted). With wait_seconds it returns early on any change. For a crew, get the lead to see its workers at a glance. Its ticket shows as ticket_id (T-12) and ticket_key (KONF-3).',
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
      // T-294: its workers, compact: the live ones first, then the ended, newest activity first within each.
      // Archived workers are left out, as session_list leaves them out.
      const kids = chat.list({ parentId: s.id }).filter((w) => !w.archivedAt);
      const ordered = [...kids.filter((w) => w.state !== 'ended'), ...kids.filter((w) => w.state === 'ended')];
      const live = kids.length - kids.filter((w) => w.state === 'ended').length;
      const out: Record<string, unknown> = {
        summary: `${s.id} is ${s.state}${s.waiting ? ` (${s.waiting} waiting)` : ''}.${kids.length ? ` ${kids.length} ${kids.length === 1 ? 'worker' : 'workers'}, ${live} live.` : ''}`,
        session: sessionBrief(s, ctx),
        ui: uiLink(`/admin/sessions/${s.id}`),
        workers_total: kids.length,
        workers: ordered.slice(0, WORKERS_MAX).map((w) => ({ id: w.id, title: ctx.untrusted(w.title, 'agent', 120), state: w.state, claude: w.claudeName ?? null, waiting: w.waiting })),
      };
      // T-2589: from the request table (what the approvals dock and chat.respond read), never the whole transcript: one chat of 204k
      // events read whole took the portal past its heap.
      out.pending_requests = chat.openRequests(s.id).map((r) => ({
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
        // T-2589: only the newest `max` events of these kinds after `after`, read as such (a bounded tail, never the transcript).
        const picked = chat.historyTail(s.id, { kinds: TRANSCRIPT_KINDS, after, maxEvents: max }).events;
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
      // The same as a person's Stop (T-294): its workers' reports wait until someone else's message lets it run again.
      await chat.control(args.id, 'stop');
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
      'Starts a Claude Code session in a workspace, optionally with a first prompt. The folder must already be trusted in the portal; this cannot trust it. mode sets its permission mode (plan, default, acceptEdits, dontAsk or auto; without it a session no person started starts in auto while Settings › Sessions allows it). Bypass is refused here: it needs a person’s approval (PILOT-1000). With parent (a live session of the same workspace) it starts as that session’s worker, as session_spawn does: in its family and crew, under its limits (depth, workers at once, an hour’s starts), and the parent hears of it in one line as report says; its first prompt reaches it as from that parent. ticket_id takes T-12 or its bucket key (KONF-3).',
    scope: 'admin',
    requires: 'session_control',
    hints: { destructive: true, openWorld: true },
    input: z.object({
      workspace_id: z.string().max(100).describe('Any form workspace_get takes: the ws_ id, <target>/<name>, <target>/<label>, or a name only one workspace has.'),
      folder: z.string().max(300).optional().describe('Default ~/work.'),
      prompt: z.string().max(8000).optional().describe('The first message.'),
      title: z.string().max(80).optional(),
      claude_id: z.string().max(80).optional(),
      ticket_id: z.string().max(64).optional().describe('The ticket it works on: T-12 or its bucket key (KONF-3); stored as T-12. An unknown ticket is refused as not found.'),
      agent: z.string().regex(CHAT_AGENT_NAME).optional().describe('The agent it runs as, .claude/agents/<agent>.md in its folder (e.g. implementer): its prompt, its tools and its model, at every start of its process.'),
      parent: z.string().max(80).optional().describe('A live session of this workspace it starts as a worker of (session_family, crew reports).'),
      report: z.enum(WORKER_REPORTS).optional().describe('With parent: what the parent hears of it unasked, one line each: idle (the default) when its turn ends, when it waits on a person and when it ends; end only when it ends; none nothing.'),
      mode: MCP_MODE_INPUT.optional().describe('Its permission mode, applied before its first prompt: plan, default, acceptEdits, dontAsk or auto. bypassPermissions is refused here (a session started over MCP is not bypass-capable).'),
    }),
    async handler(ctx, args) {
      assertCanChange(store, 'workspace');
      if (args.mode === 'bypassPermissions') throw new PortalToolError('FORBIDDEN', approvals ? MCP_BYPASS_AT_START : MCP_BYPASS_REFUSED);
      const mode = mcpMode(args.mode);
      if (args.report && !args.parent) throw new AppError('VALIDATION_FAILED', 'report needs a parent.', { details: { report: 'Only with parent.' } });
      const workspaceId = await workspaceFor(args.workspace_id, ctx);
      const parentId = args.parent ? leadFor(args.parent, workspaceId, ctx) : null;
      const s = await chat.create(
        { workspaceId, cwd: args.folder, title: args.title, claudeId: args.claude_id, ticketId: args.ticket_id, ...(args.agent ? { agent: args.agent } : {}) },
        // T-336: the same create a session_spawn makes (its parent's limits held in one step), never a new approval path or a wider mode.
        // T-349: the parent must still be live when the row is written (liveParent), with the same not found as leadFor's.
        { actor: ctx.actor, ...(parentId ? { parentId, liveParent: NO_PARENT, ...(args.report ? { report: args.report } : {}) } : {}) },
      );
      // PILOT-996: the mode asked applies before the first prompt; refused (Auto not allowed for it), the session is ended unprompted.
      if (mode) {
        try {
          await chat.control(s.id, 'mode', { mode }, { actor: ctx.actor });
        } catch (e) {
          await chat.end(s.id).catch(() => undefined);
          throw e;
        }
      }
      // T-349: a worker's first instruction is from its lead, framed as session_spawn frames it (your parent session); who started it stays
      // on the session (started_by) and in the agent.spawned audit row.
      if (args.prompt) await sendChecked(s.id, args.prompt, undefined, ctx, parentId ? { actor: `session:${parentId}`, relation: 'parent' } : undefined);
      ctx.affected(`session:${s.id}`, `workspace:${s.workspaceId}`);
      return { summary: `Started session ${s.id} in ${s.workspaceId}${parentId ? `, a worker of ${parentId}` : ''}.`, session: sessionBrief(s, ctx), ui: uiLink(`/admin/sessions/${s.id}`) };
    },
  });

  /**
   * PILOT-1000: Bypass asked over MCP becomes a person's session.bypass card; nothing about the session changes in this call. The caller's
   * acknowledgement is never taken (PILOT-996 c42754): Allow, with the person's operate right and a fresh server code, is the only way on.
   */
  function askBypass(
    ctx: PortalToolContext,
    target: ChatSession,
    args: { model?: string; effort?: string; max_workers?: number | null; subagents?: boolean; reason?: string },
  ) {
    if (args.model || args.effort || args.max_workers !== undefined || args.subagents !== undefined)
      throw new AppError('VALIDATION_FAILED', 'Ask for Bypass alone: it waits for a person, the rest would not.', { details: { mode: 'Alone, without model, effort or limits.' } });
    // Only for a session the caller may operate (the same not found as a missing one): a card never names a session it can't reach.
    try {
      requireCan(actorOfPrincipal(ctx.principal), 'operate', sessionRef(target.id));
    } catch {
      throw new AppError('NOT_FOUND', 'No such session. List them with session_list.');
    }
    if (target.mode === 'bypassPermissions') return { summary: `${target.id} is already in Bypass.`, session: sessionBrief(target, ctx) };
    // An agent asks as its own session (it hears the outcome there; the kind lets it ask for its own session only); a token asks as the portal.
    // T-2887: an agent with no session is refused, never filed as the portal.
    if (ctx.isAgent && !ctx.sessionId) throw new PortalToolError('FORBIDDEN', 'An agent asks for Bypass from its own session.');
    const requester = ctx.isAgent && ctx.sessionId ? { sessionId: ctx.sessionId, workspaceId: ctx.workspaceId, actor: actorOfPrincipal(ctx.principal) } : null;
    const a = approvals!.create({ kind: 'session.bypass', payload: { sessionId: target.id }, reason: args.reason ?? `Asked with session_configure by ${ctx.actor}.` }, requester);
    ctx.affected(`session:${target.id}`, `approval:${a.id}`);
    return {
      summary: `Bypass for ${target.id} waits for a person’s approval (${a.id}, until ${a.expiresAt}). Nothing changed yet.`,
      approval: { id: a.id, kind: a.kind, status: a.status, expires_at: a.expiresAt, page: approvalPath(a.id) },
      session: sessionBrief(target, ctx),
    };
  }

  /** A message from this caller: no human origin, and only the slash commands MCP text may use. */
  async function sendChecked(
    id: string,
    text: string,
    priority: 'next' | 'later' | undefined,
    ctx: PortalToolContext,
    as?: { actor: `session:${string}`; relation: 'parent' },
  ) {
    const first = slashWord(text);
    if (first && !SLASH_ALLOWED.has(first)) throw new PortalToolError('FORBIDDEN', `${cleanText(first, 40)} is for the terminal. Over MCP only ${[...SLASH_ALLOWED].join(', ')} are allowed.`);
    const from = as ? { actor: as.actor, relation: as.relation } : { actor: ctx.actor, ...(ctx.actorLabel ? { actorLabel: ctx.actorLabel } : {}) };
    await chat.send(id, randomUUID(), text, { ...from, ...(priority ? { priority } : {}) });
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
      // T-2589: the request table (what chat.respond itself checks), never the whole transcript.
      const open = chat.openRequests(args.id).find((r) => r.requestId === args.request_id);
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
    title: 'Change a session’s model, effort, mode or limits',
    description:
      'Changes what applies from the session’s next request. Over MCP the mode is one of plan, default, acceptEdits, dontAsk and auto (auto where the session may run in it: its parent in auto or Bypass, or “Auto for agents” on). mode bypassPermissions changes nothing here: it asks a person (a session.bypass approval card, with reason) and returns the request; on Allow the portal turns Bypass on if the session was started bypass-capable. Ask for it alone. Its limits: max_workers (how many workers it may run at once; 0 none, null the global setting, above the global cap counts as the cap) applies at once; subagents (whether its Claude may start Claude Code sub-agents) applies at its next start, so restart_needed says when a Restart is due.',
    scope: 'admin',
    requires: 'session_control',
    hints: { destructive: true, idempotent: true },
    input: z.object({
      id: z.string().max(80),
      model: z.string().max(80).optional(),
      effort: z.string().max(20).optional(),
      mode: MCP_MODE_INPUT.optional(),
      max_workers: z.number().int().min(0).max(CHAT_MAX_WORKERS_MAX).nullable().optional().describe('Workers it may run at once: 0 none, null the global setting.'),
      subagents: z.boolean().optional().describe('Whether its Claude may start sub-agents (the Agent tool); applies at its next start.'),
      reason: z.string().trim().min(1).max(APPROVAL_REASON_MAX).optional().describe('With mode bypassPermissions: why, in a sentence, for the person who decides.'),
    }),
    async handler(ctx, args) {
      const target = need(args.id);
      if (args.mode === 'bypassPermissions' && approvals) return askBypass(ctx, target, args);
      const mode = mcpMode(args.mode); // before anything changes
      const limits = args.max_workers !== undefined || args.subagents !== undefined;
      if (!args.model && !args.effort && !args.mode && !limits) throw new AppError('VALIDATION_FAILED', 'Give a model, an effort, a mode, max_workers or subagents.');
      // T-294: the limits first (a refusal leaves the rest untouched); the controller refuses a session's own actor.
      const changed = limits
        ? chat.setLimits(args.id, { ...(args.max_workers !== undefined ? { maxWorkers: args.max_workers } : {}), ...(args.subagents !== undefined ? { subagents: args.subagents } : {}) }, { actor: ctx.actor })
        : null;
      // A control that fails after the limits changed says so (the limits stay changed and audited: they are not undone).
      try {
        if (args.model) await chat.control(args.id, 'model', { model: args.model }, { actor: ctx.actor });
        if (args.effort) await chat.control(args.id, 'effort', { effort: args.effort }, { actor: ctx.actor });
        if (mode) await chat.control(args.id, 'mode', { mode }, { actor: ctx.actor });
      } catch (e) {
        if (!changed) throw e;
        const why = e instanceof Error ? e.message : 'refused';
        throw new AppError(isAppError(e) ? e.code : 'CONFLICT', `The limits were changed, but ${why.replace(/\.$/, '')}.`);
      }
      ctx.affected(`session:${args.id}`);
      const restartNeeded = changed?.restartNeeded === true;
      return {
        summary: `Updated ${args.id}.${restartNeeded ? ' Sub-agents change at its next start: restart it (the app’s Restart) to apply now.' : ''}`,
        session: sessionBrief(need(args.id), ctx),
        ...(limits ? { restart_needed: restartNeeded } : {}),
      };
    },
  });
}
