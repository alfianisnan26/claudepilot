import { FOLLOW } from './tokens';

/** How far the follower has gone in a frame of `dt` ms: an exponential approach to `target`, quicker the further behind. */
export function chase(pos: number, target: number, dt: number, viewport: number): number {
  const gap = target - pos;
  if (gap <= 0) return pos;
  // The further behind, the quicker it closes in (so a burst of lines never leaves it a screen behind).
  const tau = FOLLOW.tauMs / (1 + gap / (0.5 * viewport));
  return Math.min(target, pos + gap * (1 - Math.exp(-dt / tau)));
}

const easeOut = (p: number) => 1 - (1 - p) ** 3;

/** Where a "Jump to latest" that began at `from`, `elapsed` ms ago and takes `ms`, has got to on its way to `target` (which may have moved). */
export function jumpTo(from: number, target: number, elapsed: number, ms: number): number {
  const p = Math.min(1, Math.max(0, elapsed / ms));
  return from + (target - from) * easeOut(p);
}

/** How long a jump over `distance` takes: more distance, more time, within bounds. */
export const jumpDuration = (distance: number): number => Math.min(FOLLOW.jumpMs.max, Math.max(FOLLOW.jumpMs.min, distance * 0.45));
