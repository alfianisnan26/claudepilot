// Recover in place (T-136 slice 2, D-30, chat-sessions PRD §10.4): a session ended for integrity comes back as the SAME row, its
// conversation resumed from its tape. This file holds what is pure about it: the two settings (a cap per day and a pause between
// recoveries), whether an ending may be recovered at all, by whom, and the short continuation message. The controller does the rest.

import { AppError, defineErrorCodes } from '@isnanme/core';
import { CHAT_ENDED_CREDENTIAL, CHAT_ENDED_INTEGRITY, CHAT_RECOVER_CAPPED, CHAT_RECOVER_CONFIRM, CHAT_RECOVER_PAUSED, CHAT_RECOVER_SUSPICIOUS } from '@portal/contracts';
import { defineSetting } from '../settings/registry.js';
import type { EndingRecord } from './integrity.js';

declare module '@isnanme/core' {
  interface ErrorCodeRegistry {
    RECOVER_SUSPICIOUS: true;
    RECOVER_CONFIRM: true;
    RECOVER_CAPPED: true;
    RECOVER_PAUSED: true;
  }
}
defineErrorCodes({
  [CHAT_RECOVER_SUSPICIOUS]: { status: 403, message: 'Only a person can bring this session back.' },
  [CHAT_RECOVER_CONFIRM]: { status: 409, message: 'Confirm first.' },
  [CHAT_RECOVER_CAPPED]: { status: 409, message: 'Recovered too often today.' },
  [CHAT_RECOVER_PAUSED]: { status: 409, message: 'Recovered a moment ago.' },
});

export const RECOVER_MAX_PER_DAY = 'chat.recover.maxPerDay';
export const RECOVER_PAUSE_MIN = 'chat.recover.pauseMin';

defineSetting({
  key: RECOVER_MAX_PER_DAY,
  type: 'number',
  default: 4,
  min: 0,
  max: 24,
  scope: 'global',
  group: 'sessions',
  order: 90,
  label: 'Recoveries a day',
  help: 'How many times one session ended for integrity may be brought back in place (Resume) in 24 hours. After that it stays ended and the portal opens a ticket. 0 turns recovery off.',
});
defineSetting({
  key: RECOVER_PAUSE_MIN,
  type: 'number',
  default: 2,
  min: 0,
  max: 120,
  scope: 'global',
  group: 'sessions',
  order: 91,
  label: 'Recovery pause',
  help: 'The minutes a session must wait after one recovery before the next, so a line that keeps ending it cannot loop.',
});

export interface RecoverConfig {
  maxPerDay: number;
  pauseMs: number;
}

const num = (v: unknown, fallback: number, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);

/** The settings as the controller uses them; a missing or odd value is the default. */
export function readRecoverConfig(get: ((key: string) => unknown) | undefined): RecoverConfig {
  const read = (key: string) => {
    try {
      return get?.(key);
    } catch {
      return undefined;
    }
  };
  return { maxPerDay: Math.round(num(read(RECOVER_MAX_PER_DAY), 4, 0, 24)), pauseMs: Math.round(num(read(RECOVER_PAUSE_MIN), 2, 0, 120)) * 60_000 };
}

export const DAY_MS = 24 * 60 * 60_000;

/** Who asks: a person in the app, or an agent (a Portal MCP caller, or the supervisor saying `by: 'agent'`). */
export type RecoverBy = 'person' | 'agent';

/**
 * Whether this ending may be recovered now, by this caller; throws the refusal. `ending` is null when the row did not end for
 * integrity. `recent` are the times (ms) of this session's recoveries in the last 24 hours, oldest first.
 */
export function recoverRefusal(
  row: { state: string; ended_reason: string | null; archived_at?: string | null },
  ending: EndingRecord | null,
  o: { by: RecoverBy; confirm: boolean; recent: readonly number[]; now: number; config: RecoverConfig },
): void {
  if (row.state !== 'ended') throw new AppError('CONFLICT', 'This session hasn’t ended: a message or Resume picks it up.', { details: { recover: 'not_ended' } });
  const reason = row.ended_reason ?? '';
  if (!reason.startsWith(CHAT_ENDED_INTEGRITY)) {
    const why = /closed by operator/i.test(reason) ? 'A person closed this session: it stays closed.' : reason.startsWith(CHAT_ENDED_CREDENTIAL) ? 'This session ended for safety (its credential): start a new one.' : 'Only a session ended for integrity is recovered in place.';
    throw new AppError('CONFLICT', why, { details: { recover: /closed by operator/i.test(reason) ? 'closed' : 'not_integrity' } });
  }
  if (!ending) throw new AppError('CONFLICT', 'Only a session ended for integrity is recovered in place.', { details: { recover: 'not_integrity' } });
  if (row.archived_at) throw new AppError('CONFLICT', 'This session is archived: unarchive it first.', { details: { recover: 'archived' } });
  const facts = { classified: ending.classified, case: ending.case, origin: ending.origin };
  if (ending.classified === 'suspicious') {
    if (o.by === 'agent') throw new AppError(CHAT_RECOVER_SUSPICIOUS, `The line that ended it is suspicious (${ending.origin}): only a person can bring it back.`, { status: 403, details: facts, expose: true });
    if (!o.confirm) throw new AppError(CHAT_RECOVER_CONFIRM, `The line that ended it is suspicious (${ending.origin}). Confirm to bring the session back.`, { status: 409, details: facts, expose: true });
  }
  const day = o.recent.filter((t) => o.now - t < DAY_MS);
  if (day.length >= o.config.maxPerDay) {
    throw new AppError(CHAT_RECOVER_CAPPED, `Recovered ${day.length} times in 24 hours: it stays ended.`, { status: 409, details: { ...facts, count: day.length, max: o.config.maxPerDay }, expose: true });
  }
  const last = day.at(-1);
  if (last !== undefined && o.now - last < o.config.pauseMs) {
    const retryAfterS = Math.ceil((o.config.pauseMs - (o.now - last)) / 1000);
    throw new AppError(CHAT_RECOVER_PAUSED, `Recovered a moment ago: try again in ${retryAfterS} s.`, { status: 409, details: { ...facts, retryAfterS }, expose: true });
  }
}

/* ---------- Restart recovery (T-971 H2): sessions that were working when a portal start found their process gone ---------- */

export const RESTART_RESUME_MAX = 'chat.restartResume.max';
export const RESTART_RESUME_STAGGER_SEC = 'chat.restartResume.staggerSec';

defineSetting({
  key: RESTART_RESUME_MAX,
  type: 'number',
  default: 5,
  min: 0,
  max: 50,
  scope: 'global',
  group: 'sessions',
  order: 92,
  label: 'Resumes per start',
  help: 'How many sessions that were working when the portal restarted and lost their process are resumed by themselves after one portal start. The rest stay Interrupted and are listed in the summary. 0 turns it off.',
});
defineSetting({
  key: RESTART_RESUME_STAGGER_SEC,
  type: 'number',
  default: 20,
  min: 0,
  max: 600,
  scope: 'global',
  group: 'sessions',
  order: 93,
  label: 'Resume spacing',
  help: 'The seconds between two automatic resumes after a portal start, so a restart does not hit the Claude quota all at once.',
});

export interface RestartResumeConfig {
  max: number;
  staggerMs: number;
}

export function readRestartResumeConfig(get: ((key: string) => unknown) | undefined): RestartResumeConfig {
  const read = (key: string) => {
    try {
      return get?.(key);
    } catch {
      return undefined;
    }
  };
  return { max: Math.round(num(read(RESTART_RESUME_MAX), 5, 0, 50)), staggerMs: Math.round(num(read(RESTART_RESUME_STAGGER_SEC), 20, 0, 600)) * 1000 };
}

/** A process found gone counts as cut off by the restart only in this long after the portal started (a later vanishing is a crash, not this). */
export const RESTART_WINDOW_MS = 10 * 60_000;
/** A cut-off that was not resumed within this long is dropped: the work it stands for is too old to pick up by itself. */
export const RESTART_PENDING_MS = 60 * 60_000;
/** One session is resumed by a restart at most this many times in 24 hours (a session whose work takes the pod down is not looped). */
export const RESTART_RESUMES_PER_DAY = 3;

export interface CutOffAudit {
  kind: string;
  sessionId: string | null;
  at: string;
  detail: Record<string, unknown>;
}

/**
 * The cut-offs still waiting: a `session.cutoff` row per session (its newest), not older than an hour, with no `session.restart_recovery`
 * row after it. Oldest first. Idempotent across restarts: once a recovery row is written, a later start finds nothing for that cut-off.
 */
export function pendingCutOffs(cuts: readonly CutOffAudit[], recoveries: readonly CutOffAudit[], now: number): { sessionId: string; cutAt: number; bypass: boolean; started: string | null | undefined }[] {
  const newest = new Map<string, { cutAt: number; bypass: boolean; started: string | null | undefined }>();
  for (const c of cuts) {
    const at = Date.parse(c.at);
    if (!c.sessionId || !Number.isFinite(at) || now - at >= RESTART_PENDING_MS) continue;
    const had = newest.get(c.sessionId);
    // `started`: when the process that was cut off had started (the generation the row is bound to); undefined on a row written before it was kept.
    const started = 'started' in c.detail ? (typeof c.detail.started === 'string' ? c.detail.started : null) : undefined;
    if (!had || at >= had.cutAt) newest.set(c.sessionId, { cutAt: at, bypass: c.detail.bypass === true, started });
  }
  for (const r of recoveries) {
    const at = Date.parse(r.at);
    const cut = r.sessionId ? newest.get(r.sessionId) : undefined;
    if (cut && Number.isFinite(at) && at >= cut.cutAt) newest.delete(r.sessionId!);
  }
  return [...newest].map(([sessionId, v]) => ({ sessionId, ...v })).sort((a, b) => a.cutAt - b.cutAt);
}

/** The results of a `session.restart_recovery` row that count against the daily limit: a resume that was tried, whether or not it worked (a launch that keeps failing is a loop too). */
const TRIED = new Set(['resumed', 'failed']);

/** How many times a restart tried to resume this session in the last 24 hours, from its `session.restart_recovery` rows. */
export const restartResumesToday = (recoveries: readonly CutOffAudit[], sessionId: string, now: number): number =>
  recoveries.filter((r) => r.sessionId === sessionId && TRIED.has(String(r.detail.result)) && now - Date.parse(r.at) < DAY_MS).length;

/** The line the portal sends to a session it resumed after a restart: what happened, and that Bypass is off. */
export const restartContinuation = (bypass: boolean): string =>
  `The portal restarted while you were working: your process was lost and this is the same conversation, resumed in a new process; the sub-agents and background tasks of the old process stopped.${bypass ? ' Bypass is off now: a person turns it on again if you need it.' : ''} Continue where you stopped: look at your tickets or status file, git worktree list and git status, restart the work that was in flight.`;

/** The continuation the portal sends after a recovery: short (the supervisor's MOVED shape), the reason, no transcript. */
export const recoverContinuation = (reason: string): string =>
  `This chat ended for integrity (${reason.slice(0, 160)}) and was recovered in place: the same conversation, a new Claude Code process; the sub-agents and background tasks of the old process stopped. Continue where you stopped: look at your tickets or status file, git worktree list and git status, restart the work that was in flight.`;
