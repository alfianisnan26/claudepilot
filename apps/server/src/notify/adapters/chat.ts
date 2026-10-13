// The chat adapter (platform work breakdown, adapter rules): the chat controller's live events become bus events.
// - `approval`: a stored `request` event (a tool request, a question, a plan). The pipeline announces it 3 s later and only if it is still
//   open; the history row is written at once. The answer offer is the most the request allows (Deny; Allow when the whole request is shown
//   and the session did not start from outside); each recipient's own switches cut it at delivery.
// - `session_done`: a MAIN-thread `result` (a sub-agent's is not a turn), when someone asked for it on this session or the turn took 5 min.
// - `session_failed`: a main-thread `error` event, or an end that was not a person's (`credential:`, `integrity:`, a crash mid-turn).
//   A folder whose settings changed since it was trusted (a wake or resume refused for trust, T-38) is its own reason, `folder_trust`.
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
}

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
export const errorReason = (text: string | undefined): string =>
  /rate.?limit|429|overloaded|usage limit/i.test(text ?? '') ? 'rate_limit' : /project settings changed since you trusted it/i.test(text ?? '') ? 'folder_trust' : 'error';

export function adaptChat(d: ChatAdapterDeps): () => void {
  const states = new Map<string, ChatSession['state']>();
  return d.chat.onEvent((sessionId, msg) => {
    if (msg.type === 'removed') {
      states.delete(sessionId);
      return;
    }
    if (msg.type === 'session') {
      const s = msg.session;
      const was = states.get(s.id);
      states.set(s.id, s.state);
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
      } else if (ev.kind === 'result' && !ev.agentLabel) {
        const minutes = typeof ev.durationMs === 'number' ? ev.durationMs / 60_000 : null;
        if (d.doneWanted(session.id) || (minutes !== null && minutes >= 5))
          d.bus.emit({ kind: 'session_done', subject, facts: { workspace: session.workspaceId, minutes: minutes === null ? null : Math.round(minutes * 10) / 10 } });
      } else if (ev.kind === 'error' && !ev.agentLabel) {
        d.bus.emit({ kind: 'session_failed', subject, facts: { workspace: session.workspaceId, reason: errorReason(ev.text) } });
      }
    }
  });
}
