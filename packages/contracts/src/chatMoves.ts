// A chat's moves to other Claudes, as the transcript shows them (Workspace Claudes FR14, FR18; the owner's
// correction of 2026-10-12): one stream, with a divider where the Claude changed and one card behind it. A
// move writes progress rows, the handoff request and its document, the opening and its acknowledgement into the
// chat, all tagged with the move's id; the transcript folds them away and shows the card.

import type { ChatEvent } from './chat.js';

export interface ChatMove {
  /** The move's id (`handoffId` of every event it wrote). */
  id: string;
  /** The divider: the "Moved to …" row a finished move ends with. Null while it runs, or when it didn't finish. */
  marker: ChatEvent | null;
  /** Everything the move wrote, in order. */
  members: ChatEvent[];
  /** `done` has its divider; `failed` ends in the row that says it didn't finish; `running` is still under way. */
  status: 'done' | 'failed' | 'running';
  /** The context the new Claude was sent (the opening), and what it first answered. */
  opening: ChatEvent | null;
  acknowledgement: string | null;
}

/** The row a failed move leaves behind: what it says begins like this (the controller writes it). */
const FAILED = /^The move to /;

/**
 * Folds each move's events out of the transcript, leaving one row to stand for it: the divider (with its card)
 * when it finished, else the last row it wrote ("Starting Work…", or why it didn't finish). `moves` is keyed
 * by the `seq` of that row. Events of no move, and the transcripts of sessions from before moves were tagged,
 * are returned as they are.
 */
export function foldMoves(events: readonly ChatEvent[]): { events: ChatEvent[]; moves: Map<number, ChatMove> } {
  const groups = new Map<string, ChatEvent[]>();
  for (const e of events) {
    if (!e.handoffId) continue;
    const g = groups.get(e.handoffId);
    if (g) g.push(e);
    else groups.set(e.handoffId, [e]);
  }
  const moves = new Map<number, ChatMove>();
  if (groups.size === 0) return { events: [...events], moves };
  const hidden = new Set<number>();
  for (const [id, members] of groups) {
    const marker = events.find((e) => e.kind === 'system' && e.transfer?.handoffId === id) ?? null;
    const last = members.findLast((e) => e.kind === 'system') ?? null;
    const shown = marker ?? last;
    for (const m of members) hidden.add(m.seq);
    if (!shown) continue;
    hidden.delete(shown.seq);
    const opening = members.find((e) => e.kind === 'user' && !!e.transfer) ?? null;
    const ack = opening ? members.find((e) => e.kind === 'assistant' && !e.agentLabel && e.seq > opening.seq)?.text?.trim() : undefined;
    moves.set(shown.seq, { id, marker, members, status: marker ? 'done' : last && FAILED.test(last.text ?? '') ? 'failed' : 'running', opening, acknowledgement: ack || null });
  }
  return { events: events.filter((e) => !hidden.has(e.seq)), moves };
}
