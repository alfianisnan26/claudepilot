// The chat adapter (platform work breakdown, adapter rules): the chat controller's live events become bus events.
// - `approval`: a stored `request` event (a tool request, a question, a plan). The pipeline announces it 3 s later and only if it is still
//   open; the history row is written at once. The answer offer is the most the request allows (Deny; Allow when the whole request is shown
//   and the session did not start from outside); each recipient's own switches cut it at delivery.
// - `session_done`: the session went IDLE and stayed so (T-41): working is the main turn OR a task of its process running (the controller's
//   one definition), so a turn that ends while sub-agents or background commands run is not done. It fires `DONE_DEBOUNCE_MS` after the
//   move to idle, once, if by then no new turn started, no task runs, no move is under way and it hasn't ended; when someone asked for it
//   on this session or the stretch took 5 min ("minutes" is from the first working moment of the stretch).
// - `session_failed`: a main-thread `error` event, or an end that was not a person's (`credential:`, `integrity:`, a crash mid-turn).
// - `resolved`: the request is dealt with: nothing more goes out for it and its tokens die.
// Nothing an agent wrote (a title, a command, an error text) goes into `facts`: only the workspace, the tool class, numbers; the request's
// redacted one-line summary goes into `detail`, which only a destination with "Include detail" shows.

import { type ChatRequest, type ChatServerMessage, type ChatSession } from '@portal/contracts';
import { answerOffer } from '../actions.js';
import type { NotifyBus } from '../bus.js';

export interface ChatSource {
  onEvent(cb: (sessionId: string, msg: ChatServerMessage) => void): () => void;
  get(id: string): ChatSession | null;
}

export interface ChatAdapterDeps {
  chat: ChatSource;
  bus: NotifyBus;
  untrusted: (sessionId: string) => boolean;
  /** Someone asked "Notify when done" on this session. */
  doneWanted: (sessionId: string) => boolean;
  resolved: (sessionId: string, requestId: string, outcome: string) => void;
  /** How long a session must stay idle before it counts as done (tests shorten it). */
  doneDebounceMs?: number;
  now?: () => number;
}

/** A session is done only once it stayed idle this long: a task's notification often starts the next turn within seconds. */
export const DONE_DEBOUNCE_MS = 20_000;

const BUSY: ReadonlySet<ChatSession['state']> = new Set(['working', 'waiting', 'starting']);

/** What the request asks, as a word the template knows (never its text). */
export function requestAction(r: Pick<ChatRequest, 'kind' | 'toolName'>): string {
  if (r.kind === 'question' || r.toolName === 'AskUserQuestion') return 'question';
  if (r.kind === 'plan' || r.toolName === 'ExitPlanMode') return 'plan';
  if (r.kind !== 'tool') return 'tool';
  if (r.toolName === 'Bash') return 'command';
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(r.toolName ?? '')) return 'edit';
  if (['Read', 'Glob', 'Grep', 'LS'].includes(r.toolName ?? '')) return 'read';
  return 'tool';
}

/** An error's text, read only to pick a fixed reason; the text itself goes nowhere. */
export const errorReason = (text: string | undefined): string => (/rate.?limit|429|overloaded|usage limit/i.test(text ?? '') ? 'rate_limit' : 'error');

export function adaptChat(d: ChatAdapterDeps): () => void {
  const states = new Map<string, ChatSession['state']>();
  const debounce = d.doneDebounceMs ?? DONE_DEBOUNCE_MS;
  const now = d.now ?? Date.now;
  /** When each session's current working stretch began. */
  const since = new Map<string, number>();
  /** A session that went idle, waiting out the debounce. */
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const cancel = (id: string) => {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
  };
  const done = (id: string) => {
    timers.delete(id);
    const s = d.chat.get(id);
    const start = since.get(id);
    // Still idle, nothing running, not moving, not ended: the work is over. Else a later move to idle tries again.
    if (!s || s.state !== 'idle' || (s.agentsRunning ?? 0) > 0 || s.switching || start === undefined) return;
    since.delete(id);
    const minutes = Math.round(((now() - start) / 60_000) * 10) / 10;
    if (d.doneWanted(id) || minutes >= 5) d.bus.emit({ kind: 'session_done', subject: { type: 'session', id: s.id, workspaceId: s.workspaceId }, facts: { workspace: s.workspaceId, minutes } });
  };
  const off = d.chat.onEvent((sessionId, msg) => {
    if (msg.type === 'removed') {
      states.delete(sessionId);
      since.delete(sessionId);
      cancel(sessionId);
      return;
    }
    if (msg.type === 'session') {
      const s = msg.session;
      const was = states.get(s.id);
      states.set(s.id, s.state);
      if (BUSY.has(s.state)) {
        // Working again (a new turn, or a task): not done; the stretch goes on from where it began.
        cancel(s.id);
        if (!since.has(s.id)) since.set(s.id, now());
      } else if (s.state === 'idle' && since.has(s.id) && !s.switching) {
        if (!timers.has(s.id)) {
          const t = setTimeout(() => done(s.id), debounce);
          t.unref?.();
          timers.set(s.id, t);
        }
      } else if (s.state !== 'idle') {
        cancel(s.id);
        since.delete(s.id); // ended or interrupted: that stretch is over without being done
      }
      if (!was || was === s.state) return;
      const reason = s.endedReason ?? '';
      let why: string | null = null;
      if (s.state === 'ended' && /^credential:/i.test(reason)) why = 'credential';
      else if (s.state === 'ended' && /^integrity:/i.test(reason)) why = 'integrity';
      else if (s.state === 'interrupted' && (was === 'working' || was === 'waiting')) why = 'crash';
      if (why) d.bus.emit({ kind: 'session_failed', subject: { type: 'session', id: s.id, workspaceId: s.workspaceId }, facts: { workspace: s.workspaceId, reason: why } });
      return;
    }
    if (msg.type !== 'events') return;
    const session = d.chat.get(sessionId);
    if (!session) return;
    const subject = { type: 'session' as const, id: session.id, workspaceId: session.workspaceId };
    for (const ev of msg.items) {
      if (ev.kind === 'request' && ev.request) {
        const r = ev.request;
        const untrusted = d.untrusted(session.id);
        // The most this request allows; each recipient's switches and the ceiling cut it at delivery.
        const offer = answerOffer({ request: r, cwd: session.worktree?.path ?? session.cwd, untrusted, policy: { deny: true, allowRead: true, allowEdit: true, allowCommand: true }, ceiling: true });
        d.bus.emit({
          kind: 'approval',
          subject,
          facts: { workspace: session.workspaceId, action: requestAction(r), requestId: r.requestId, agent: !!r.agentLabel, untrusted },
          ...(r.detail ? { detail: { text: r.detail, truncated: r.detail.endsWith('…') } } : {}),
          ...(offer.decisions.length ? { answer: { sessionId: session.id, requestId: r.requestId, toolClass: offer.toolClass, decisions: offer.decisions } } : {}),
        });
      } else if (ev.kind === 'resolved' && ev.requestId) {
        d.resolved(session.id, ev.requestId, ev.outcome ?? 'resolved');
      } else if (ev.kind === 'error' && !ev.agentLabel) {
        d.bus.emit({ kind: 'session_failed', subject, facts: { workspace: session.workspaceId, reason: errorReason(ev.text) } });
      }
    }
  });
  return () => {
    off();
    for (const id of [...timers.keys()]) cancel(id);
  };
}
