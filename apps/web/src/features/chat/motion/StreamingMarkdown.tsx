import { cn } from '@isnanme/ui';
import { useReducedMotion } from 'motion/react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import { COMPONENTS, PLUGINS } from '../Markdown';
import { BlockSplitter } from './blocks';
import { RevealEngine, type RevealView } from './engine';
import { frameTask } from './frames';
import './motion.css';
import { rehypeReveal } from './reveal';
import { StreamTable } from './StreamTable';
import { motionVars, PACE } from './tokens';

/** "All of it": a block the reveal has gone past. */
const WHOLE = Infinity;

/** The chat's components, with the table that lets its cells glide as the columns find their widths. */
const LIVE_COMPONENTS = { ...COMPONENTS, table: StreamTable };

const EMPTY: RevealView = { text: '', cut: 0, staticCut: 0 };
const style = motionVars();

/**
 * One block of the reply, rendered once it is reached. A block the reveal has gone past has the same props from
 * then on, so it is never rendered again; the block being revealed is parsed again only when it changes.
 */
const Block = memo(function Block({ text, cut, still }: { text: string; cut: number; still: number }) {
  return (
    <ReactMarkdown remarkPlugins={PLUGINS} rehypePlugins={[[rehypeReveal, { cut, staticCut: still }]]} components={LIVE_COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
});

/**
 * The reply as it is being written: the text as it arrives (`text`, growing), shown word by word at a steady
 * pace (see pacing.ts) with each word pulling into focus (motion.css). `ended` says the stream is over: the
 * rest shows quickly, and `onSettled` is called once every word has shown and finished playing, so the stored
 * reply can take over without a visible change.
 *
 * The Markdown is parsed as it stands, in blocks (blocks.ts): finished blocks are rendered once and only the
 * one being revealed is parsed again, at most about 30 times a second, so a long reply costs the same per
 * frame as a short one. A new text that is not a continuation of the old one (the reply was replaced) starts over.
 *
 * It is not announced word by word: `aria-live="off"` here, and the transcript announces the stored reply
 * once, when it arrives.
 */
export function StreamingMarkdown({
  text,
  ended = false,
  onSettled,
  className,
}: {
  text: string;
  ended?: boolean;
  onSettled?: () => void;
  className?: string;
}) {
  const reduced = !!useReducedMotion();
  const [view, setView] = useState<RevealView>(EMPTY);
  const engine = useRef<RevealEngine | null>(null);
  engine.current ??= new RevealEngine();
  const splitter = useRef<BlockSplitter | null>(null);
  splitter.current ??= new BlockSplitter();
  const root = useRef<HTMLDivElement>(null);
  const wake = useRef<() => void>(() => undefined);
  const latest = useRef({ reduced, onSettled });
  const committed = useRef<RevealView>(EMPTY);

  // What the frame loop needs from the latest render.
  useLayoutEffect(() => {
    latest.current = { reduced, onSettled };
  });

  // The text is handed to the engine as it arrives (cheap: it only scans the new words); the loop shows it.
  useLayoutEffect(() => {
    engine.current!.feed(text, ended, performance.now());
    wake.current();
  }, [text, ended, reduced]);

  useEffect(() => {
    const e = engine.current!;
    let lastCommit = -Infinity;
    let settled = false;
    // What a render of the reveal costs (smoothed): the page is rendered no more often than this allows, so a very
    // long block on a slow phone gets fewer, bigger steps instead of a stuttering frame rate.
    let cost = 0;
    // A device that cannot keep up while words play (frames taking well over their time) drops the blur and keeps the fade.
    let slow = 0;
    let lite = false;
    const task = frameTask(10, (now, dt) => {
      const v = e.step(now, latest.current.reduced);
      if (!lite && !latest.current.reduced && e.busy(now)) {
        slow = dt > PACE.slowFrameMs ? slow + 1 : Math.max(0, slow - 2);
        if (slow > PACE.slowFrames) {
          lite = true;
          root.current?.setAttribute('data-mo-lite', '');
        }
      }
      const c = committed.current;
      const changed = v.cut !== c.cut || v.staticCut !== c.staticCut || v.text !== c.text;
      // The page renders the reveal at most about 30 times a second; the engine itself runs every frame.
      let pending = changed;
      if (changed && now - lastCommit >= Math.max(PACE.frameMs - 3, Math.min(PACE.slowestMs, cost / PACE.budget))) {
        lastCommit = now;
        committed.current = v;
        const started = performance.now();
        flushSync(() => setView(v));
        const spent = performance.now() - started;
        cost = cost ? cost * 0.7 + spent * 0.3 : spent;
        pending = false;
      }
      if (v.text.length < c.text.length) settled = false;
      if (!settled && e.settledAt(now) && !pending) {
        settled = true;
        latest.current.onSettled?.();
      }
      return pending || e.busy(now);
    });
    wake.current = task.wake;
    task.wake();
    return () => {
      task.dispose();
      wake.current = () => undefined;
    };
  }, []);

  // Only what the frame loop committed is rendered (a parent rendering again with a longer text changes nothing here).
  const blocks = useMemo(
    () =>
      splitter.current!.update(view.text).map((b, i) => {
        const cut = view.cut - b.start;
        // Nothing of this block is revealed yet, and nothing after it either.
        if (cut <= 0) return null;
        const len = b.end - b.start;
        const still = view.staticCut - b.start;
        return <Block key={i} text={view.text.slice(b.start, b.end)} cut={cut >= len ? WHOLE : cut} still={still >= len ? WHOLE : Math.max(0, still)} />;
      }),
    [view],
  );
  return (
    <div ref={root} className={cn('min-w-0 break-words', className)} style={style} aria-live="off" data-reveal="">
      {blocks}
    </div>
  );
}
