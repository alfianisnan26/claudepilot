// What the auto transfer engine uses of the rest of the portal, as narrow ports so the engine is tested with fakes. The real ones are
// the chat controller (no edit in it: `onEvent`, `switchOptions`, `switchClaude`, `get`, `list`, `history`), the usage monitor
// (`report`, U1a's snapshot with windows, pace and outlook; `recommendMove` is the pure ranking), the platform's owner adapter, the bus
// and the audit.

import type { ChatEvent, ChatServerMessage, ChatSession, ChatSwitchOptions, ClaudeUsage, NotifySubject, Verb } from '@portal/contracts';
import type { RecommendFn } from './decide.js';

export interface ChatPort {
  get(id: string): ChatSession | null;
  list(filter?: { workspaceId?: string }): ChatSession[];
  switchOptions(id: string): Promise<ChatSwitchOptions>;
  switchClaude(id: string, destClaudeId: string, opts: { handoff?: 'ask' | 'skip' }): Promise<ChatSession>;
  /** Changes the chat's model on the Claude it runs on (`sonnet`): the chat control `model`, as a person's model picker does. */
  setModel(id: string, model: string): Promise<void>;
  onEvent(cb: (sessionId: string, msg: ChatServerMessage) => void): () => void;
  history(id: string, after?: number): ChatEvent[];
}

export interface UsagePort {
  /** The snapshot, filtered to the Claudes `actorId` may use. Never probes. */
  report(opts: { actorId?: string }): Promise<{ claudes: ClaudeUsage[] }>;
  recommend: RecommendFn;
}

export interface OwnerPort {
  ownersOf(subject: NotifySubject): string[];
  can(userId: string, verb: Verb, subject: NotifySubject): boolean;
  userEnabled(userId: string): boolean;
}

export interface ClockPort {
  now(): number;
  /** Runs `fn` after `ms`; returns a cancel. */
  timer(ms: number, fn: () => void): () => void;
}

export const realClock: ClockPort = {
  now: () => Date.now(),
  timer(ms, fn) {
    const t = setTimeout(fn, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
    t.unref?.();
    return () => clearTimeout(t);
  },
};
