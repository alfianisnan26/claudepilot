// Keep going over the Portal MCP (T-259 slice 2, T-104 item 1): ONE tool, `session_keepgoing_set`, for the owner's delegate (an admin's
// token). Scope `admin`, so an agent's per-session token never reaches it (a chat may not keep itself, or another chat, going: the same rule
// as the PUT route); the session control switch must be on. A chat the token's user may not operate answers like an unknown one (404).
// Turning it ON asks for a confirmation first (the preview says what the portal will then do by itself); turning it off or changing a number
// does not. Audited `keepgoing.set` by the engine, with the token as the actor. Slice 3: `keepgoing_pause_set` pauses or resumes a program
// (or all) for a platform admin's token, after a confirmation; anyone else is answered NOT_FOUND; audited `keepgoing.pause`.

import { AppError } from '@isnanme/core';
import { actorUserId, KEEPGOING_BOUNDS as B, KEEPGOING_PROGRAM_RE, KEEPGOING_RESTART_CAPS } from '@portal/contracts';
import { actorOfPrincipal } from '../authz/seam.js';
import type { PlatformOwner } from '../platform/owner.js';
import { portalTools, z, type ToolRegistry } from '../portalmcp/registry.js';
import type { KeepGoingChatPort, KeepGoingEngine } from './engine.js';
import { mayPause, parsePatch, parsePause } from './routes.js';

export function registerKeepGoingTools(d: { engine: KeepGoingEngine; chat: Pick<KeepGoingChatPort, 'get'>; owner: PlatformOwner }, registry: ToolRegistry = portalTools): void {
  registry.register({
    name: 'session_keepgoing_set',
    title: 'Set Keep going on a chat',
    description:
      "Turns the portal's Keep going on or off for one chat session, or changes its numbers. With it on, the portal looks at the chat every minute: an idle chat is told to continue with the policy's prompt, an interrupted or sleeping one is woken, a question is answered 'decide by the written defaults', an ended one is recovered in place or continued by a new chat (capped per day), and what it may not repair (a tool approval, Bypass off, a chat left down) is reported to the owner. It never answers a tool approval and never turns Bypass on. Admin tokens only; turning it on asks for confirmation first.",
    scope: 'admin',
    requires: 'session_control',
    hints: { destructive: true, idempotent: true },
    rate: { perMinute: 6, perHour: 60 },
    maxArgsBytes: 8_192,
    input: z.object({
      session_id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/).describe('The chat session.'),
      enabled: z.boolean().optional().describe('On or off.'),
      nudge_after_min: z.number().int().min(B.nudgeAfterMin.min).max(B.nudgeAfterMin.max).optional().describe('Tell an idle chat to continue after this many minutes.'),
      prompt: z.string().max(B.promptMax).nullable().optional().describe('The continuation prompt ({status}, {ticket} placeholders); null for the default.'),
      status_file: z.string().max(B.statusFileMax).nullable().optional().describe('The status file {status} names, inside the chat’s folder; null for the default.'),
      max_nudges_per_day: z.number().int().min(B.maxNudgesPerDay.min).max(B.maxNudgesPerDay.max).optional(),
      max_wakes_per_day: z.number().int().min(B.maxWakesPerDay.min).max(B.maxWakesPerDay.max).optional(),
      program: z.string().max(40).regex(KEEPGOING_PROGRAM_RE).nullable().optional().describe('The program the chat belongs to (a pause of it holds the chat); null for none.'),
      confirm_token: z.string().optional(),
    }),
    async handler(ctx, args) {
      const actor = actorOfPrincipal(ctx.principal);
      const userId = actorUserId(actor);
      const s = d.chat.get(args.session_id);
      const subject = s ? { type: 'session' as const, id: s.id, workspaceId: s.workspaceId } : null;
      // An agent never sets a policy (the scope keeps it out already); a chat the token's user may not operate is not there for it.
      if (ctx.isAgent || actor.kind === 'agent' || !s || !subject || !userId || !d.owner.can(userId, 'view', subject) || !d.owner.can(userId, 'operate', subject)) {
        throw new AppError('NOT_FOUND', 'No such session.');
      }
      const raw: Record<string, unknown> = {};
      if (args.enabled !== undefined) raw.enabled = args.enabled;
      if (args.nudge_after_min !== undefined) raw.nudgeAfterMin = args.nudge_after_min;
      if (args.prompt !== undefined) raw.prompt = args.prompt;
      if (args.status_file !== undefined) raw.statusFile = args.status_file;
      if (args.max_nudges_per_day !== undefined) raw.maxNudgesPerDay = args.max_nudges_per_day;
      if (args.max_wakes_per_day !== undefined) raw.maxWakesPerDay = args.max_wakes_per_day;
      if (args.program !== undefined) raw.program = args.program;
      const patch = parsePatch(raw);
      if (!Object.keys(patch).length) throw new AppError('VALIDATION_FAILED', 'Nothing to change.', { details: { enabled: 'Give at least one field.' } });
      const was = d.engine.view(s.id);
      if (patch.enabled === true && !was?.enabled) {
        const gate = ctx.confirm(
          args,
          {
            session_id: s.id,
            title: ctx.untrusted(s.title, 'agent', 120),
            workspace_id: s.workspaceId,
            changes: `Keep going ON: every minute the portal tells this chat to continue when it is idle for ${patch.nudgeAfterMin ?? was?.nudgeAfterMin ?? B.nudgeAfterMin.default} minutes, wakes it, answers its questions with "decide by the written defaults", and recovers or restarts it when it ends (at most ${KEEPGOING_RESTART_CAPS.other} new chats a day). It never answers a tool approval and never turns Bypass on.`,
          },
          s.id,
        );
        if (gate) return gate;
      }
      const ownerId = d.owner.ownersOf(subject)[0] ?? userId;
      const kg = d.engine.set(s.id, ownerId, ctx.actor, patch);
      ctx.affected(`session:${s.id}`);
      return {
        summary: `Keep going is ${kg.enabled ? 'on' : 'off'} for ${s.id}${kg.pause ? ` (paused: ${kg.pause.program ?? 'all'})` : kg.paused ? ' (paused for the whole portal)' : ''}.`,
        keep_going: { enabled: kg.enabled, nudge_after_min: kg.nudgeAfterMin, prompt_default: kg.prompt === null, status_file: kg.statusFile, max_nudges_per_day: kg.maxNudgesPerDay, max_wakes_per_day: kg.maxWakesPerDay, program: kg.program ?? null, paused: kg.paused },
      };
    },
  });

  registry.register({
    name: 'keepgoing_pause_set',
    title: 'Pause or resume Keep going for a program',
    description:
      "Pauses or resumes the portal's Keep going for one program (the label a chat's Keep going policy carries, like the supervisor's track keys) or, with program null, for every chat. While paused the portal starts no new chat, sends no nudge, wake or answer and raises no report for the chats it holds; it keeps watching their state. Resuming looks at them again at once. Admin tokens of a platform admin only; asks for confirmation first; audited.",
    scope: 'admin',
    hints: { destructive: true, idempotent: true },
    rate: { perMinute: 6, perHour: 60 },
    maxArgsBytes: 2_048,
    input: z.object({
      program: z.string().max(40).regex(KEEPGOING_PROGRAM_RE).nullable().describe('The program, or null for all.'),
      paused: z.boolean().describe('True to pause, false to resume.'),
      reason: z.string().max(B.pauseReasonMax).optional().describe('Why (one line); required to pause.'),
      confirm_token: z.string().optional(),
    }),
    async handler(ctx, args) {
      const actor = actorOfPrincipal(ctx.principal);
      const userId = actorUserId(actor);
      if (ctx.isAgent || !mayPause(d.owner, { actor: actor as { kind: string; scope?: string }, userId })) throw new AppError('NOT_FOUND', 'Not found.');
      const p = parsePause({ program: args.program, paused: args.paused, ...(args.reason !== undefined ? { reason: args.reason } : {}) });
      const what = p.program ?? 'every chat';
      const gate = ctx.confirm(args, {
        program: p.program,
        changes: p.paused
          ? `PAUSE Keep going for ${what}: no new chat, nudge, wake, answer or report until it is resumed. Reason: ${p.reason}`
          : `RESUME Keep going for ${what}: its chats are looked at again at once (an idle one is told to continue, an ended one is brought back).`,
      });
      if (gate) return gate;
      const out = d.engine.setPause(p.program, p.paused, ctx.actor, userId, p.reason);
      return {
        summary: `Keep going is ${p.paused ? 'paused' : 'resumed'} for ${what}${out.changed ? '' : ' (no change)'}.`,
        pause: out.pause,
      };
    },
  });
}
