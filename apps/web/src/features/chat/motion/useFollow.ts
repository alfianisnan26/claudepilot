import { useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { frameTask, type FrameTask } from './frames';
import { chase, jumpDuration, jumpTo } from './glide';
import { FOLLOW } from './tokens';

/** How long after the reader's last touch, wheel or key the follower keeps its hands off. */
const HOLD_MS = 250;

export interface Follow {
  /**
   * The content grew or moved: keep the bottom in view. It glides (an exponential approach, re-aimed every frame, so
   * a block resizing never makes it jump or jitter); with `snap`, or when the gap is a screen or more (a history
   * load, a big image) or motion is reduced, it goes there at once.
   */
  pin(snap?: boolean): void;
  /** The reader took over (wheel, touch, key): stop at once. They are pinned again by scrolling back down or by `jump`. */
  interrupt(): void;
  /** "Jump to latest": glides to the bottom and keeps following it as it grows. */
  jump(): void;
  /** Whether a scroll event at `top` is the echo of the follower's own last move (not the reader's). */
  own(top: number): boolean;
}

/**
 * Keeps a scroll area at its end while the content grows, smoothly. It owns no notion of whether the reader is at
 * the bottom: `pinned` is the caller's (the transcript's `nearBottom`), and the follower stops the moment it is false.
 */
export function useFollow(ref: RefObject<HTMLElement | null>, pinned: RefObject<boolean>): Follow {
  const reduced = useReducedMotion();
  const still = useRef(!!reduced);
  useEffect(() => {
    still.current = !!reduced;
  }, [reduced]);

  const task = useRef<FrameTask | null>(null);
  // The glide's own state: the position it last wrote (it may be fractional: the browser's read-back is not), what it is doing, and when the reader last acted.
  const s = useRef({ mode: 'idle' as 'idle' | 'chase' | 'jump', pos: 0, from: 0, at: 0, ms: 0, hold: 0, wrote: -Infinity });

  useEffect(() => {
    const t = frameTask(20, (now, dt) => {
      const el = ref.current;
      const g = s.current;
      if (!el || !pinned.current || g.mode === 'idle') {
        g.mode = 'idle';
        return false;
      }
      if (now < g.hold) return true;
      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      // Someone else moved it (the reader, a snap): start from where it really is.
      if (Math.abs(el.scrollTop - g.pos) > 1.5) g.pos = el.scrollTop;
      const gap = target - g.pos;
      if (gap <= 0.5) {
        if (gap < 0 && el.scrollTop > target) el.scrollTop = target;
        g.mode = 'idle';
        return false;
      }
      let next: number;
      if (g.mode === 'jump') {
        next = jumpTo(g.from, target, now - g.at, g.ms);
        if (now - g.at >= g.ms) g.mode = 'chase';
      } else next = chase(g.pos, target, dt, el.clientHeight);
      next = Math.min(target, Math.max(g.pos, next));
      g.pos = next;
      g.wrote = now;
      el.scrollTop = next;
      return true;
    });
    task.current = t;
    return () => {
      t.dispose();
      task.current = null;
    };
  }, [ref, pinned]);

  return useMemo<Follow>(
    () => ({
      pin(snap = false) {
        const el = ref.current;
        const g = s.current;
        if (!el || !pinned.current) return;
        // A "Jump to latest" under way already follows the end as it moves (a growing reply must not cut it short).
        if (g.mode === 'jump') return task.current?.wake();
        const target = Math.max(0, el.scrollHeight - el.clientHeight);
        const gap = target - el.scrollTop;
        if (snap || still.current || gap > FOLLOW.snapScreens * el.clientHeight) {
          g.mode = 'idle';
          if (gap > 0.5 || gap < -0.5) el.scrollTop = target;
          g.pos = el.scrollTop;
          g.wrote = performance.now();
          return;
        }
        if (gap <= 0.5) return;
        if (g.mode === 'idle') {
          g.pos = el.scrollTop;
          g.mode = 'chase';
        }
        task.current?.wake();
      },
      interrupt() {
        const g = s.current;
        g.mode = 'idle';
        g.hold = performance.now() + HOLD_MS;
      },
      jump() {
        const el = ref.current;
        const g = s.current;
        if (!el) return;
        const target = Math.max(0, el.scrollHeight - el.clientHeight);
        const gap = target - el.scrollTop;
        if (still.current || gap <= 1) {
          el.scrollTop = target;
          g.mode = 'idle';
          g.pos = el.scrollTop;
          g.wrote = performance.now();
          return;
        }
        g.mode = 'jump';
        g.pos = el.scrollTop;
        g.from = el.scrollTop;
        g.at = performance.now();
        g.ms = jumpDuration(gap);
        g.hold = 0;
        task.current?.wake();
      },
      own(top) {
        const g = s.current;
        return performance.now() - g.wrote < 120 && Math.abs(top - g.pos) < 1.5;
      },
    }),
    [ref, pinned],
  );
}
