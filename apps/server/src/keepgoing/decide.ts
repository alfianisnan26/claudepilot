// Keep going's decision for one chat in one round (T-259 slices 1 and 2; T-104 item 2, T-108 item 1, T-257): pure, deterministic, no LLM.
// ONE action per chat per round, in this order: a chat that ENDED is brought back (slice 2): a person's close, an archive or its ticket closing
// turn the policy off; an integrity ending is first recovered in place (T-136), and when the portal refuses that, or for any other ending, a
// new chat continues it, capped per root cause over its lineage (T-257 item 2) and at least 5 minutes apart; left down (the cap) or still
// ended 15 minutes after the sweep first saw it, it is reported once (`down`). A move, a restart or a start under way is left alone; a
// QUESTION is answered "decide yourself"; a TOOL APPROVAL is never answered: once it has waited 10 minutes it is reported; a chat out of
// Bypass on a bypass-capable session is reported (never re-entered: the lease is the owner's open decision); an interrupted chat, or a
// sleeping one that is due a nudge, is woken; an idle chat (T-41: no turn, no task, nothing waiting) is told to continue once per idle
// period, after `nudgeAfterMin`, at most `maxNudgesPerDay` times.
//
// `causes` says which reportable causes stand right now, so the engine clears the ones that no longer do.

import { KEEPGOING_CONSTANTS as C, KEEPGOING_RESTART_CAPS, type ChatRequest, type ChatSession, type KeepGoingCause, type KeepGoingRestartClass } from '@portal/contracts';
import type { PolicyRow, ReportRow } from './store.js';

const MIN = 60_000;

export type Decision =
  | { act: 'none'; why: 'busy' | 'working' | 'waiting' | 'backoff' | 'recent_nudge' | 'not_yet' | 'nudged_period' | 'reported' | 'restart_gap' }
  | { act: 'stand_down'; reason: string }
  | { act: 'answer'; request: ChatRequest }
  /** `why`: for `down`, what keeps it down (written on the ticket). */
  | { act: 'report'; cause: KeepGoingCause; since: string; why?: string }
  /** An integrity ending: recover in place first (T-136, as an agent: the portal's own rules, cap and pause apply). */
  | { act: 'recover' }
  /** A new chat continues this one (`continuedFrom`), with the policy's prompt. */
  | { act: 'restart'; cls: KeepGoingRestartClass }
  | { act: 'wake'; why: 'interrupted' | 'asleep' }
  | { act: 'nudge'; why: 'idle' | 'after_wake'; idleMin: number }
  | { act: 'capped'; what: 'nudges' | 'wakes' };

export interface DecideInput {
  nowMs: number;
  session: ChatSession;
  policy: PolicyRow;
  requests: ChatRequest[];
  nudges24h: number;
  wakes24h: number;
  lastNudgeAt: string | null;
  /** Reports that stand (not cleared). For an ended chat the engine has put the quiet `ended` mark first. */
  standing: ReportRow[];
  /** Slice 2, for an ended chat: the starts again over its lineage in the last 24 hours. */
  restarts24h?: { at: string; cls: KeepGoingRestartClass }[];
  /** The portal refused to recover this ending in place (since the `ended` mark): a new chat instead. */
  recoverRefused?: boolean;
  /** The chat's ticket is closed: its work is done, an ending is not started again. */
  ticketClosed?: boolean;
}

export interface DecideOutput {
  decision: Decision;
  /** The reportable causes that stand now (the rest of `standing` is cleared). */
  causes: Set<KeepGoingCause>;
}

const QUESTION_KINDS = new Set<ChatRequest['kind']>(['question', 'elicitation']);
/** What a person must answer: a tool, a plan, a workflow. The move's own handoff request is the portal's, not counted. */
const APPROVAL_KINDS = new Set<ChatRequest['kind']>(['tool', 'plan', 'workflow']);

/** The class of an ending, for the cap per root cause: T-136's classification of an integrity ending, or any other ending. */
export function restartClass(s: Pick<ChatSession, 'endedReason' | 'endedFor'>): KeepGoingRestartClass {
  if (!/^integrity: /.test(s.endedReason ?? '')) return 'other';
  return s.endedFor?.classified === 'harmless' ? 'harmless' : 'integrity';
}

/** A chat a person (or a parent through the portal) closed: `end()` writes exactly this. */
export const closedByPerson = (s: Pick<ChatSession, 'state' | 'endedReason'>): boolean => s.state === 'ended' && /^closed by operator$/i.test(s.endedReason ?? '');

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

export function decide(x: DecideInput): DecideOutput {
  const { session: s, policy: p, nowMs: now } = x;
  const stands = (c: KeepGoingCause) => x.standing.some((r) => r.cause === c);
  const since = (c: KeepGoingCause) => x.standing.find((r) => r.cause === c)?.since ?? null;
  const causes = new Set<KeepGoingCause>();
  const out = (decision: Decision): DecideOutput => ({ decision, causes });
  const nowIso = new Date(now).toISOString();

  // (e) Ended, for any reason (slice 2): brought back, or reported once as left down.
  if (s.state === 'ended') {
    if (closedByPerson(s)) return out({ act: 'stand_down', reason: 'A person closed the chat: Keep going turned itself off.' });
    if (s.archivedAt) return out({ act: 'stand_down', reason: 'The chat was archived: Keep going turned itself off.' });
    if (x.ticketClosed) return out({ act: 'stand_down', reason: 'Its ticket is closed: done, so it is not started again.' });
    causes.add('ended');
    const endedSince = since('ended') ?? nowIso;
    const downStands = stands('down');
    if (downStands) causes.add('down');
    const down = (why: string): DecideOutput => {
      causes.add('down');
      return out(downStands ? { act: 'none', why: 'reported' } : { act: 'report', cause: 'down', since: endedSince, why });
    };
    // Still ended 15 minutes after the sweep first saw it (a recover that keeps waiting, a start that keeps failing): reported once; the
    // attempts go on, and a start that works clears it.
    if (!downStands && now - ms(endedSince) >= C.downAfterMin * MIN) return down(`still ended ${C.downAfterMin} minutes after Keep going saw it end`);
    if (p.backoffUntil && ms(p.backoffUntil) > now) return out({ act: 'none', why: 'backoff' });
    const cls = restartClass(s);
    if (cls !== 'other' && !x.recoverRefused) return out({ act: 'recover' });
    const restarts = x.restarts24h ?? [];
    const counted = restarts.filter((r) => (cls === 'harmless' ? r.cls === 'harmless' : r.cls !== 'harmless'));
    if (counted.length >= KEEPGOING_RESTART_CAPS[cls]) {
      return down(`the cap: ${counted.length} new chats in 24 hours after ${cls === 'harmless' ? 'harmless integrity endings' : cls === 'integrity' ? 'integrity endings' : 'endings'} (at most ${KEEPGOING_RESTART_CAPS[cls]})`);
    }
    const last = restarts.at(-1);
    if (last && now - ms(last.at) < C.restartGapMin * MIN) return out({ act: 'none', why: 'restart_gap' });
    return out({ act: 'restart', cls });
  }

  // A cause that stood keeps standing until the chat runs again (a wake that failed, a cap reached).
  const asleepOrGone = s.state === 'interrupted' || s.process === 'asleep';
  if (stands('wake_failed') && asleepOrGone) causes.add('wake_failed');
  const nudgesCapped = x.nudges24h >= p.maxNudgesPerDay;
  const wakesCapped = x.wakes24h >= p.maxWakesPerDay;
  if (stands('cap') && (nudgesCapped || wakesCapped)) causes.add('cap');

  // (d) Out of Bypass on a bypass-capable session: reported, never re-entered here (the lease is slice 2).
  const outOfBypass = s.bypassCapable && s.mode !== 'bypassPermissions';
  if (outOfBypass) causes.add('bypass');

  // (c) What waits: questions are answered, tool approvals are reported after 10 minutes and never answered.
  const approvals = x.requests.filter((r) => APPROVAL_KINDS.has(r.kind));
  const oldest = approvals.map((r) => ms(r.createdAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const approvalLong = oldest !== undefined && now - oldest >= C.approvalReportMin * MIN;
  if (approvalLong) causes.add('approval');

  // A move, a restart or a launch under way: nothing is done to the chat.
  if (s.switching || s.restarting || s.state === 'starting') return out({ act: 'none', why: 'busy' });

  const question = x.requests.find((r) => QUESTION_KINDS.has(r.kind));
  if (question) return out({ act: 'answer', request: question });
  if (approvalLong && !stands('approval')) return out({ act: 'report', cause: 'approval', since: new Date(oldest!).toISOString() });
  if (outOfBypass && !stands('bypass')) return out({ act: 'report', cause: 'bypass', since: nowIso });
  if (s.state === 'waiting' || x.requests.length) return out({ act: 'none', why: 'waiting' });

  if (p.backoffUntil && ms(p.backoffUntil) > now) return out({ act: 'none', why: 'backoff' });

  // (b) Interrupted: woken. Asleep: woken when a nudge is due (then (a) at once on the next round).
  const idleMin = Math.max(0, (now - ms(s.lastActivityAt)) / MIN);
  const idle = s.state === 'idle' && !s.tasksOnly && (s.agentsRunning ?? 0) === 0;
  const nudgeDue = p.continueOwed || (idleMin >= p.nudgeAfterMin && p.nudgedPeriod !== s.lastActivityAt);
  if (s.state === 'interrupted' || (idle && s.process === 'asleep' && nudgeDue)) {
    if (wakesCapped) {
      causes.add('cap');
      return out(stands('cap') ? { act: 'none', why: 'reported' } : { act: 'capped', what: 'wakes' });
    }
    return out({ act: 'wake', why: s.state === 'interrupted' ? 'interrupted' : 'asleep' });
  }
  if (!idle) return out({ act: 'none', why: 'working' });

  // (a) Idle: once per idle period, after `nudgeAfterMin`, at least 10 minutes after the last nudge (an owed continue goes at once).
  if (!p.continueOwed) {
    if (idleMin < p.nudgeAfterMin) return out({ act: 'none', why: 'not_yet' });
    if (p.nudgedPeriod === s.lastActivityAt) return out({ act: 'none', why: 'nudged_period' });
    if (x.lastNudgeAt && now - ms(x.lastNudgeAt) < C.nudgeGapMin * MIN) return out({ act: 'none', why: 'recent_nudge' });
  }
  if (nudgesCapped) {
    causes.add('cap');
    return out(stands('cap') ? { act: 'none', why: 'reported' } : { act: 'capped', what: 'nudges' });
  }
  return out({ act: 'nudge', why: p.continueOwed ? 'after_wake' : 'idle', idleMin: Math.floor(idleMin) });
}
