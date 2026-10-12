// Small words and numbers the widgets share (a phone's chip is narrow: five characters at most).

/** A count as a chip shows it: the number, or "99+". */
export const chipCount = (n: number): string => (n > 99 ? '99+' : String(Math.max(0, Math.trunc(n))));

/** A count in few characters for a place with little room: 999, 1.2k, 15k, 2.4M. */
export function compactCount(n: number): string {
  const v = Math.max(0, Math.trunc(n));
  if (v < 1000) return String(v);
  if (v < 999_500) return `${v < 10_000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') : Math.round(v / 1000)}k`;
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** "1 session", "3 sessions". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** How long ago, in the fewest characters: "now", "7m", "3h", "2d", "2mo". The full date is for a tooltip. */
export function shortAgo(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  if (s < 86_400 * 60) return `${Math.round(s / 86_400)}d`;
  return `${Math.round(s / (86_400 * 30))}mo`;
}

/** Items joined for a title: "2 approvals, 1 ticket and 1 failed run". Empty parts are left out. */
export function listWords(parts: (string | null | false | undefined)[]): string {
  const p = parts.filter((x): x is string => !!x);
  return p.length <= 1 ? (p[0] ?? '') : `${p.slice(0, -1).join(', ')} and ${p.at(-1)}`;
}

/** How long something has been going, in the fewest characters: "<1m", "7m", "3h", "2d". For a task's "running for". */
export function shortSpan(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return '<1m';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}
