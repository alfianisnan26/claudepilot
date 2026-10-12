// Chat content: which artifacts of a turn are shown, and where "Download all" goes. A turn is what one message
// of yours set off, up to your next one. The agent often writes the same file again (a draft, then the final):
// only the newest copy of a path is shown, and the one "Download all" for the turn sits under its last card.

import type { ChatEvent } from '@portal/contracts';

export interface TurnFiles {
  /** The turn's `artifact` events that still show something, in order: what "Download all" zips. */
  seqs: number[];
  /** How many files they show together. */
  count: number;
  /** This event is the last of them: the place for "Download all". */
  last: boolean;
  /** Positions in this event's `files` that a later write of the same path replaced. */
  replaced: ReadonlySet<number>;
}

/** The turn information of every `artifact` event, by its sequence number. */
export function artifactTurns(events: ChatEvent[]): Map<number, TurnFiles> {
  const out = new Map<number, TurnFiles>();
  let turn: ChatEvent[] = [];
  const close = () => {
    if (turn.length === 0) return;
    // A later file at the same path replaces an earlier one (a file without a path is never replaced).
    const newest = new Map<string, string>();
    for (const e of turn) (e.files ?? []).forEach((f, i) => f.path && newest.set(f.path, `${e.seq}:${i}`));
    const replaced = new Map<number, Set<number>>();
    const visible: { seq: number; count: number }[] = [];
    for (const e of turn) {
      const skip = new Set<number>();
      (e.files ?? []).forEach((f, i) => {
        if (f.path && newest.get(f.path) !== `${e.seq}:${i}`) skip.add(i);
      });
      replaced.set(e.seq, skip);
      const count = (e.files?.length ?? 0) - skip.size;
      if (count > 0) visible.push({ seq: e.seq, count });
    }
    const seqs = visible.map((v) => v.seq);
    const count = visible.reduce((n, v) => n + v.count, 0);
    for (const e of turn) out.set(e.seq, { seqs, count, last: seqs.at(-1) === e.seq, replaced: replaced.get(e.seq) ?? new Set() });
    turn = [];
  };
  for (const e of events) {
    if (e.kind === 'user' && !e.transfer) close();
    else if (e.kind === 'artifact') turn.push(e);
  }
  close();
  return out;
}
