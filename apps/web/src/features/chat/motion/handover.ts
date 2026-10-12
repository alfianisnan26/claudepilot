import type { ChatEvent } from '@portal/contracts';

const trimmed = (s: string | undefined) => (s ?? '').trimEnd();

/**
 * The stored reply a live one became: new since the live reply began (`startSeq` is the last `seq` there was then),
 * from the same agent, with the text that was shown (or that and a little more: the tail still arriving when the
 * stream ended). Returns its `seq` and the text to finish showing, always a continuation of what was shown (the
 * reveal carries on from where it is; anything else would start the reply over): the stored text when it extends the
 * shown one, the shown one when they differ only in trailing whitespace or the stored one is shorter.
 */
export function findStored(
  live: { text: string; agentLabel: string | null; startSeq: number },
  events: readonly ChatEvent[],
): { seq: number; text: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.seq <= live.startSeq) break;
    if (e.kind !== 'assistant' || (e.agentLabel ?? null) !== live.agentLabel) continue;
    const stored = e.text ?? '';
    if (stored.startsWith(live.text)) return { seq: e.seq, text: stored };
    if (live.text.startsWith(stored) || trimmed(stored) === trimmed(live.text)) return { seq: e.seq, text: live.text };
  }
  return null;
}
