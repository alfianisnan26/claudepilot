import type { ChatServerMessage } from '@portal/contracts';
import type { ChatDelta } from '../useChatSocket';
import { PACE } from './tokens';

export type DeltaMessage = Extract<ChatServerMessage, { type: 'delta' }>;

/**
 * The live reply after one more `delta` message. Deltas are pieces of the open block: they are appended (a new
 * agent, or text after thinking, starts afresh). A thinking start carries no text: it shows as "Thinking…" until
 * the block is stored.
 */
export function foldDelta(d: ChatDelta | null, msg: DeltaMessage): ChatDelta {
  if (msg.thinking) return { agentLabel: msg.agentLabel, text: '', thinking: { since: Date.now() - (msg.elapsedMs ?? 0) } };
  if (d && d.agentLabel === msg.agentLabel && !d.thinking) return { ...d, text: d.text + msg.text };
  return { agentLabel: msg.agentLabel, text: msg.text };
}

/**
 * Deltas arrive in tens per second, each one a state update that re-renders the whole session page. They are
 * collected and applied about 30 times a second instead (the reply is shown at its own pace anyway, see
 * pacing.ts), in order: a run of text for the same agent is joined, and anything that must see the deltas first
 * (the stored reply that supersedes them) calls `flush`.
 */
export function createDeltaBatcher(
  apply: (messages: DeltaMessage[]) => void,
  frame: (cb: () => void) => number = (cb) => window.setTimeout(cb, PACE.frameMs),
  cancelFrame: (id: number) => void = (id) => window.clearTimeout(id),
) {
  let queue: DeltaMessage[] = [];
  let id = 0;
  const flush = () => {
    if (id) cancelFrame(id);
    id = 0;
    if (!queue.length) return;
    const messages = queue;
    queue = [];
    apply(messages);
  };
  return {
    push(msg: DeltaMessage) {
      const last = queue[queue.length - 1];
      // Text that follows text from the same agent is one piece.
      if (last && !last.thinking && !msg.thinking && last.agentLabel === msg.agentLabel) queue[queue.length - 1] = { ...last, text: last.text + msg.text };
      else queue.push(msg);
      if (!id) id = frame(flush);
    },
    flush,
    /** Drops what is waiting (the session was left). */
    cancel() {
      if (id) cancelFrame(id);
      id = 0;
      queue = [];
    },
  };
}
