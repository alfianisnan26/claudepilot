// T-294 "Crew", the controls on one session (chat-sessions PRD FR51, "Limits per session" and "Agent per session"): how many workers it may
// run at once, whether its Claude may start sub-agents, and the role (agent) it runs as. A person changes the limits in Session info
// (`PATCH CHAT_API.limits`); the server is the authority and the global `sessions.maxChildren` stays the ceiling. Pure, so the rules are
// tested (crewLimits.test.ts).
import { CHAT_MAX_WORKERS_MAX, type ChatSession, type SettingsView } from '@portal/contracts';

/** The shared setting that caps every session's workers at once (Settings › Sessions, "Workers per session"). */
export const WORKERS_SETTING = 'sessions.maxChildren';

/** The global cap from the settings list, or null when it is not there or not a whole number in range (the stepper then shows the number only). */
export function workersCap(view: Pick<SettingsView, 'settings'> | null | undefined): number | null {
  const v = view?.settings.find((s) => s.key === WORKERS_SETTING)?.value;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= CHAT_MAX_WORKERS_MAX ? v : null;
}

/**
 * One step of the Workers stepper: 0 (None), 1, 2 … up to the global cap, where it reads Default (null: the session follows the global
 * setting, which is the ceiling anyway, so a number equal to it is never stored). Without the cap the top is {@link CHAT_MAX_WORKERS_MAX}.
 * A stored value above the cap counts as the cap (as on the server). Returns the value to save, or undefined when the step changes nothing.
 */
export function stepWorkers(own: number | null | undefined, dir: -1 | 1, cap: number | null): number | null | undefined {
  const top = cap ?? CHAT_MAX_WORKERS_MAX;
  const cur = own == null ? top : Math.min(Math.max(own, 0), top);
  const raw = Math.min(Math.max(cur + dir, 0), top);
  const next = raw >= top ? null : raw;
  return next === (own ?? null) ? undefined : next;
}

export interface WorkersView {
  /** What the stepper shows: "None", a number, "Default", or "Default (5)" when the global cap is known. */
  text: string;
  /** For a screen reader. */
  label: string;
  canLess: boolean;
  canMore: boolean;
}

/** The stepper for a session's `maxWorkers` (null or absent: the global setting) and the global cap (null when it can't be read). */
export function workersView(own: number | null | undefined, cap: number | null): WorkersView {
  const top = cap ?? CHAT_MAX_WORKERS_MAX;
  const steps = { canLess: stepWorkers(own, -1, cap) !== undefined, canMore: stepWorkers(own, 1, cap) !== undefined };
  if (own == null)
    return cap === null
      ? { text: 'Default', label: 'Workers at once: the global setting', ...steps }
      : { text: `Default (${cap})`, label: `Workers at once: the global setting, ${cap}`, ...steps };
  const n = Math.min(Math.max(own, 0), top);
  if (n === 0) return { text: 'None', label: 'Workers at once: none, it may not start workers', ...steps };
  return { text: String(n), label: `Workers at once: ${n}`, ...steps };
}

/** A sub-agents change the live process has not taken yet: what it was launched with and what it is now. */
export interface SubagentsPending {
  launched: boolean;
  now: boolean;
}

/**
 * After a limits answer: the sub-agents change still waiting for a restart, or null. A change the live process needs a restart for is
 * pending; one that only puts back what the process was launched with is not (the server compares the stored values only); a change while
 * nothing runs is taken by the next start by itself; a change of workers alone leaves what was pending.
 */
export function nextPending(
  prev: SubagentsPending | null,
  change: { before: boolean; after: boolean; restartNeeded: boolean },
): SubagentsPending | null {
  if (change.before === change.after) return prev;
  if (!change.restartNeeded) return null;
  const launched = prev ? prev.launched : change.before;
  return change.after === launched ? null : { launched, now: change.after };
}

/** The line under the switch: what a pending change waits for, and whether the existing Restart is offered with it. */
export interface LimitsNote {
  line: string;
  restart: boolean;
}

/**
 * Which note shows for a pending sub-agents change: none once the session ended, its process stopped (the next start takes it) or a restart
 * is under way; "at the queued restart" when one is queued (it applies it); else "from the next restart" with the Restart action.
 */
export function limitsNote(
  pending: SubagentsPending | null,
  s: Pick<ChatSession, 'state' | 'process' | 'restarting' | 'restartQueued'>,
): LimitsNote | null {
  if (!pending || s.state === 'ended' || s.process !== 'live' || s.restarting) return null;
  const what = `Sub-agents ${pending.now ? 'on' : 'off'}`;
  if (s.restartQueued) return { line: `${what} at the queued restart.`, restart: false };
  return { line: `${what} from the next restart.`, restart: true };
}

/** The role a session runs as (`claude --agent <name>`), or null when it runs as Claude Code's default. */
export const roleOf = (s: Pick<ChatSession, 'agent'> | null | undefined): string | null => s?.agent?.trim() || null;
