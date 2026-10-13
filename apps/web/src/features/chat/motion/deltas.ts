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

/** Whose a delta is: the Task call of the sub-agent that wrote it (its label, from an older server), or null for the main agent. */
export const deltaAgent = (msg: Pick<DeltaMessage, 'agentLabel' | 'parentToolUseId'>): string | null => msg.parentToolUseId ?? msg.agentLabel ?? null;

/** What a sub-agent is writing right now, shown on its row in the activity line (never in the main reply's place). */
export interface AgentLive {
  /** The open block's text so far, its tail only (the row shows its latest line). */
  text: string;
  thinking: boolean;
}

/** The live text of the session: the main agent's reply, and each sub-agent's own, by its Task call. */
export interface LiveState {
  main: ChatDelta | null;
  agents: ReadonlyMap<string, AgentLive>;
}

export const NO_LIVE: LiveState = { main: null, agents: new Map() };
/** How much of a sub-agent's open block is kept: enough for its latest line. */
const AGENT_TAIL = 600;

/**
 * The live state after one more `delta` message. The main agent's pieces build its reply (foldDelta); a sub-agent's never touch it:
 * they go to that agent's own entry, so a background agent writing after the main turn ended can't look like the main agent answering.
 */
export function foldLive(s: LiveState, msg: DeltaMessage): LiveState {
  const agent = deltaAgent(msg);
  if (agent === null) return { ...s, main: foldDelta(s.main, msg) };
  const prev = s.agents.get(agent);
  const agents = new Map(s.agents);
  if (msg.thinking) agents.set(agent, { text: '', thinking: true });
  else agents.set(agent, { text: ((prev && !prev.thinking ? prev.text : '') + msg.text).slice(-AGENT_TAIL), thinking: false });
  return { ...s, agents };
}

/**
 * What stored events end: the main agent's finished block or its turn's result ends its live reply; a sub-agent's finished block ends
 * that agent's live text (its stored line takes over); a finished thinking block ends a "Thinking…" of the same agent.
 */
export function settleLive(s: LiveState, events: readonly { kind: string; agentLabel?: string | null; parentToolUseId?: string }[]): LiveState {
  let { main, agents } = s;
  let copied = false;
  for (const e of events) {
    const agent = e.parentToolUseId ?? e.agentLabel ?? null;
    if (agent === null) {
      if (e.kind === 'assistant' || e.kind === 'result') main = null;
      else if (e.kind === 'thinking' && main?.thinking) main = null;
      continue;
    }
    const live = agents.get(agent);
    if (!live || !(e.kind === 'assistant' || (e.kind === 'thinking' && live.thinking))) continue;
    if (!copied) (agents = new Map(agents)), (copied = true);
    (agents as Map<string, AgentLive>).delete(agent);
  }
  return main === s.main && agents === s.agents ? s : { main, agents };
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
      if (last && !last.thinking && !msg.thinking && deltaAgent(last) === deltaAgent(msg)) queue[queue.length - 1] = { ...last, text: last.text + msg.text };
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
