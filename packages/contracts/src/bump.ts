// Bump: push something a person is looking at (a ticket today, a CI run next) into a session that is already running, either as its next
// work ("Prioritise") or as a question to answer ("Ask"), with an optional one-line note (tickets PRD FR28 to FR32). The picker, the modes
// and the message's shape are shared, so every feature that bumps offers the same sessions, the same two modes and the same text style.

import type { ChatSessionState } from './chat.js';

export const BUMP_MODES = ['prioritise', 'ask'] as const;
export type BumpMode = (typeof BUMP_MODES)[number];

export const BUMP_MODE_LABEL: Record<BumpMode, string> = { prioritise: 'Prioritise', ask: 'Ask' };

/**
 * The chat queue priority each mode's message goes in with: Prioritise steers the turn now running (`next`), Ask waits for it to
 * end (`later`). An idle session takes either at once.
 */
export const BUMP_PRIORITY: Record<BumpMode, 'next' | 'later'> = { prioritise: 'next', ask: 'later' };

/** The note is one line. */
export const BUMP_NOTE_MAX = 200;

/** Why a session can't be bumped: it ended, it waits on an approval (answer that first), or it works in another workspace. */
export type BumpRefusal = 'ended' | 'waiting' | 'other_workspace';

export const BUMP_REFUSAL_LABEL: Record<BumpRefusal, string> = {
  ended: 'Ended',
  waiting: 'Waiting on an approval',
  other_workspace: 'Another workspace',
};

/** A session the picker offers: the preferred one first (a ticket's assignee, a run's session), then the others of the workspace. */
export interface BumpTarget {
  id: string;
  title: string;
  state: ChatSessionState;
  workspaceId: string;
  lastActivityAt: string;
  /** The one the thing already belongs to. */
  preferred: boolean;
  /** Null: it can be bumped. Otherwise it is shown greyed out with the reason. */
  refusal: BumpRefusal | null;
}

/** What a bump asks for. */
export interface BumpRequest {
  sessionId: string;
  mode: BumpMode;
  /** One line, at most `BUMP_NOTE_MAX` characters. */
  note?: string;
}
