import type { ChatEvent } from '@portal/contracts';
import { useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatDelta } from '../useChatSocket';
import { findStored } from './handover';

/** A reply that is being shown as it is written: the stream's delta, or the stored reply finishing. */
export interface LiveReply {
  /** Names this reply for as long as it is on screen (a different reply is a different `id`: its words show afresh). */
  id: number;
  agentLabel: string | null;
  text: string;
  thinking?: ChatDelta['thinking'];
  /** The stream is over: what is left shows quickly. */
  ended?: boolean;
}

export interface Handover {
  /** What the live slot shows. */
  live: LiveReply | null;
  /** Rows from this `seq` on wait until the reply above has finished showing (they would otherwise sit above it). */
  holdFrom: number | null;
  /** The reply shown live has finished showing: the stored one takes its place. */
  settled: () => void;
  /** Stored replies that were just shown live: they take their place as they are, with no rise or animation. */
  adopted: ReadonlySet<number>;
}

/** Longest the stored reply waits for the live one to finish showing (a hidden tab does not run animation frames). */
const GIVE_UP_MS = 1800;

const NONE: ReadonlySet<number> = new Set();

/**
 * The live reply's way into the transcript. When a reply stops streaming, the stored copy arrives at the same
 * moment; shown naively, the live text vanishes, its last words (still waiting their turn) pop in at once, and the
 * stored row rises in from nothing. Here the live reply stays up in the stored one's final text until its last
 * word has shown (the engine flushes quickly once the stream has ended), the rows below it wait, and then the
 * stored reply takes over in the same place without rising in. Reduced motion and a hidden tab skip the wait.
 */
export function useHandover(sessionId: string, delta: ChatDelta | null, events: ChatEvent[]): Handover {
  const reduced = !!useReducedMotion();
  const last = useRef<{ text: string; agentLabel: string | null; startSeq: number } | null>(null);
  const [seen, setSeen] = useState<ReadonlySet<number>>(NONE);
  const [finishing, setFinishing] = useState<{ seq: number; text: string; agentLabel: string | null; id: number } | null>(null);
  // Which reply is being written: a new one when the agent differs, the text is not a continuation, or there was none in between.
  // (Worked out while rendering, so the commit that shows the new reply already has its own `id`; the same inputs give the same answer.)
  const reply = useRef({ id: 0, text: '', agent: null as string | null, open: false });
  if (delta && !delta.thinking) {
    const r = reply.current;
    reply.current = !r.open || r.agent !== delta.agentLabel || !delta.text.startsWith(r.text) ? { id: r.id + 1, text: delta.text, agent: delta.agentLabel, open: true } : { ...r, text: delta.text };
  } else if (!delta && reply.current.open) reply.current = { ...reply.current, open: false };
  const top = events.length ? events[events.length - 1]!.seq : 0;
  const topRef = useRef(top);
  topRef.current = top;

  // A reply that has just stopped streaming and has been stored: found while rendering, so the very commit that
  // removes the live block already knows which stored row takes its place.
  const found = !delta && last.current ? findStored(last.current, events) : null;
  const now = found && !reduced && typeof document !== 'undefined' && !document.hidden ? { ...found, agentLabel: last.current!.agentLabel, id: reply.current.id } : null;
  const f = finishing ?? now;

  useLayoutEffect(() => {
    if (delta && !delta.thinking && delta.text) {
      if (!last.current || last.current.agentLabel !== delta.agentLabel) last.current = { text: delta.text, agentLabel: delta.agentLabel, startSeq: topRef.current };
      else last.current.text = delta.text;
    } else if (!delta && last.current) {
      if (found) setSeen((prev) => (prev.has(found.seq) ? prev : new Set([...prev].slice(-15)).add(found.seq)));
      if (now) setFinishing(now);
      last.current = null;
    }
    // Something new is being written: whatever was finishing gives way (its stored row is already in).
    if (delta) setFinishing((x) => (x ? null : x));
  }, [delta, found, now]);

  // Another session: nothing carries over.
  useEffect(() => {
    last.current = null;
    setSeen(NONE);
    setFinishing(null);
  }, [sessionId]);

  const settled = useCallback(() => setFinishing(null), []);
  useEffect(() => {
    if (!finishing) return;
    const t = window.setTimeout(settled, GIVE_UP_MS);
    const onHide = () => document.hidden && settled();
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [finishing, settled]);

  const live: LiveReply | null = f ? { id: f.id, agentLabel: f.agentLabel, text: f.text, ended: true } : delta ? { ...delta, id: reply.current.id } : null;
  return {
    live,
    holdFrom: f ? f.seq : null,
    settled,
    // (A new set only while the hand-over is under way: the rows below are not rendered again for a stream's every piece.)
    adopted: found && !seen.has(found.seq) ? new Set(seen).add(found.seq) : seen,
  };
}
