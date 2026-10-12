import { ease } from '@isnanme/ui';
import type { CSSProperties } from 'react';

/**
 * The chat's motion language, in one place. Durations, curves and amounts for everything that moves in a
 * session (a word arriving, a row entering or leaving, the transcript following a growing reply) come from
 * here, so a change is one edit and nothing drifts. The curve is the kit's own ease-out (fast start, soft
 * landing, no overshoot), so the chat moves like the rest of the portal.
 */
export const MOTION = {
  ease,
  /** The same curve, for CSS keyframes. */
  easeCss: `cubic-bezier(${ease.join(', ')})`,
  /** A word as it is revealed: it pulls into focus from a soft blur, fading in with a small rise. */
  word: { ms: 280, blurPx: 5, risePx: 3 },
  /** A row entering (the reply's Thinking line, an activity row) and leaving. */
  enter: { duration: 0.24, ease },
  exit: { duration: 0.14, ease },
  /** A label crossfading to the next one; a row opening or closing. */
  swap: { duration: 0.18, ease },
  expand: { duration: 0.24, ease },
  /** Rows rising in (springs settle without a visible bounce). */
  rise: { type: 'spring', stiffness: 380, damping: 32 },
  /** Small things popping in: an activity icon, a message you just sent. */
  pop: { type: 'spring', stiffness: 520, damping: 30 },
} as const;

/**
 * How the live reply is paced. Words arrive in irregular bursts; they are shown at a steady, adaptive
 * speed that closes the backlog in about `tauMs`, never later than `maxLagMs` after a word arrived, and
 * quickly once the stream has ended.
 */
export const PACE = {
  /** No word waits longer than this behind the stream. */
  maxLagMs: 500,
  /** The backlog closes with this time constant: a steady stream sits about this far behind. */
  tauMs: 180,
  /** The slowest speed (words per second), so a trickle of single words shows at once. */
  minWps: 10,
  /** Once the stream has ended, whatever is left shows within this. */
  flushMs: 220,
  /** Safety on the speed the deadline asks for. */
  margin: 1.15,
  /** The page renders the reveal at most this often (about 30 fps)... */
  frameMs: 33,
  /** ...and no more often than a render's cost allows: it may use this share of the time (cost / budget between renders)... */
  budget: 0.35,
  /** ...but never less often than this (a long block on a slow phone still moves). */
  slowestMs: 160,
  /** Frames longer than this while words play count as slow; after this many (net of good ones) the blur is dropped. */
  slowFrameMs: 28,
  slowFrames: 30,
  /** A word keeps its animation class this long (longer than the animation), then it is plain text. */
  freshMs: 400,
} as const;

/** The transcript following the end of a growing reply. */
export const FOLLOW = {
  /** Time constant of the exponential approach to the bottom. */
  tauMs: 130,
  /** A gap larger than this many viewport heights (a history load, a big image) snaps instead of gliding. */
  snapScreens: 1.2,
  /** "Jump to latest" glides for this long (more distance, more time, within these bounds). */
  jumpMs: { min: 260, max: 640 },
} as const;

/** The motion tokens as CSS variables, set on the element that holds the animated words. */
export const motionVars = (): CSSProperties =>
  ({
    '--mo-ms': `${MOTION.word.ms}ms`,
    '--mo-ease': MOTION.easeCss,
    '--mo-blur': `${MOTION.word.blurPx}px`,
    '--mo-rise': `${MOTION.word.risePx}px`,
  }) as CSSProperties;
