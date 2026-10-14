// Keep going's decision for one chat in one round (T-259 slice 1; T-104 item 2, T-108 item 1): pure, deterministic, no LLM. ONE action
// per chat per round, in this order: a chat that ended is reported (a person's close turns the policy off); a move, a restart or a start
// under way is left alone; a QUESTION is answered "decide yourself"; a TOOL APPROVAL is never answered: once it has waited 10 minutes it is
// reported; a chat out of Bypass on a bypass-capable session is reported (not re-entered: that is the lease, slice 2); an interrupted chat, or
// a sleeping one that is due a nudge, is woken; an idle chat (T-41: no turn, no task, nothing waiting) is told to continue once per idle
// period, after `nudgeAfterMin`, at most `maxNudgesPerDay` times.
//
// `causes` says which reportable causes stand right now, so the engine clears the ones that no longer do.

import { KEEPGOING_CONSTANTS as C, type ChatRequest, type ChatSession, type KeepGoingCause } from '@portal/contracts';
import type { PolicyRow, ReportRow } from './store.js';

const MIN = 60_000;

export type Decision =
  | { act: 'none'; why: 'busy' | 'working' | 'waiting' | 'backoff' | 'recent_nudge' | 'not_yet' | 'nudged_period' | 'reported' }
  | { act: 'stand_down'; reason: string }
  | { act: 'answer'; request: ChatRequest }
  | { act: 'report'; cause: KeepGoingCause; since: string }
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
  /** Reports that stand (not cleared). */
  standing: ReportRow[];
}

export interface DecideOutput {
  decision: Decision;
  /** The reportable causes that stand now (the rest of `standing` is cleared). */
  causes: Set<KeepGoingCause>;
}

const QUESTION_KINDS = new Set<ChatRequest['kind']>(['question', 'elicitation']);
/** What a person must answer: a tool, a plan, a workflow. The move's own handoff request is the portal's, not counted. */
const APPROVAL_KINDS = new Set<ChatRequest['kind']>(['tool', 'plan', 'workflow']);

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

  // (e) Ended, for any reason; down when it was not started again within 15 minutes.
  if (s.state === 'ended') {
    if (closedByPerson(s)) return out({ act: 'stand_down', reason: 'A person closed the chat: Keep going turned itself off.' });
    causes.add('ended');
    const endedSince = since('ended');
    if (!endedSince) return out({ act: 'report', cause: 'ended', since: nowIso });
    if (now - ms(endedSince) >= C.downAfterMin * MIN) {
      causes.add('down');
      if (!stands('down')) return out({ act: 'report', cause: 'down', since: endedSince });
    }
    return out({ act: 'none', why: 'reported' });
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
