import { PACE } from './tokens';

/** By time `t` (ms), `total` words had arrived in all: one entry per burst of new words, `total` rising. */
export interface Arrival {
  t: number;
  total: number;
}

export type PaceConfig = Pick<typeof PACE, 'maxLagMs' | 'tauMs' | 'minWps' | 'flushMs' | 'margin'>;

/** How many words show when the reveal is at `pos` (fractional: a word shows as soon as it is started). */
export const shown = (pos: number, total: number): number => Math.min(total, Math.ceil(pos - 1e-9));

/**
 * The reveal position (in words, fractional) at `now`, from where it was at `from`.
 *
 * Words arrive in irregular bursts and are shown at a steady speed instead: the backlog closes with time
 * constant `tauMs` (so a steady stream sits about that far behind and a burst is spread out rather than
 * dumped), never slower than `minWps` (so a trickle of single words shows at once). On top of that sits a
 * deadline: a word that arrived at `t` must show by `t + maxLagMs`, so the speed rises as far as that needs
 * (this is what makes "never more than about half a second behind" a guarantee, not a hope). After the stream
 * has ended (`endedAt`) the deadline for everything left is `flushMs`, so the tail shows quickly.
 *
 * Pure: a fake clock and a list of arrivals are all it needs.
 */
export function advance(
  pos: number,
  from: number,
  now: number,
  arrivals: readonly Arrival[],
  endedAt: number | null = null,
  cfg: PaceConfig = PACE,
): number {
  const last = arrivals[arrivals.length - 1];
  const total = last ? last.total : 0;
  if (pos >= total) return total;
  const dt = Math.max(0, now - from) / 1000;
  let speed = Math.max(cfg.minWps, ((total - pos) * 1000) / cfg.tauMs);
  let floor = pos;
  for (const a of arrivals) {
    if (a.total <= pos) continue;
    let deadline = a.t + cfg.maxLagMs;
    if (endedAt !== null) deadline = Math.min(deadline, endedAt + cfg.flushMs);
    const left = deadline - now;
    if (left <= 0) floor = Math.max(floor, a.total);
    else speed = Math.max(speed, (cfg.margin * (a.total - pos)) / (left / 1000));
  }
  return Math.min(total, Math.max(floor, pos + speed * dt));
}
