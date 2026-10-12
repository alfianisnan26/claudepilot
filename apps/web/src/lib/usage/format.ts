// How the Usage page and the widgets write amounts: one rule each, so a figure reads the same wherever it shows.

/** "$0.084", "$1.23", "$12.3", "$1.2k", "$3.4M": short enough for an axis and a tile, whatever the amount. */
export function formatCost(v: number): string {
  if (v === 0) return '$0';
  if (v < 1) return `$${v.toFixed(v < 0.1 ? 3 : 2)}`;
  if (v < 100) return `$${v.toFixed(2).replace(/\.?0+$/, '')}`;
  if (v < 1000) return `$${Math.round(v)}`;
  return `$${scaled(v, [[1e3, 'k'], [1e6, 'M'], [1e9, 'B'], [1e12, 'T']])}`;
}

/** 1234 -> "1.2k"; the unit steps up at 999.5 of the one below, so a value never reads "1000k". */
function scaled(v: number, units: [number, string][]): string {
  let i = 0;
  while (i < units.length - 1 && v / units[i]![0] >= 999.5) i++;
  const [size, suffix] = units[i]!;
  const x = v / size;
  return `${x.toFixed(x < 9.95 ? 1 : 0)}${suffix}`;
}

/** "850", "12.3k", "1.2M", "4.5B", "9.9T" (the same rule as the chat's token counts, and beyond it). */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return scaled(n, [[1e3, 'k'], [1e6, 'M'], [1e9, 'B'], [1e12, 'T']]);
}

/** "$0.42/min". */
export const formatCostRate = (perMin: number): string => `${formatCost(perMin)}/min`;

/** "35k tok/min": tokens spent per minute, a whole number below 1000. */
export const formatTokenRate = (perMin: number): string => `${formatTokens(Math.round(perMin))} tok/min`;

/** "96 %", "1.2k %", "62M %": a percent as it is (it can pass 100), rounded, compact when huge. */
export function formatPercent(pct: number): string {
  const r = Math.round(pct);
  return `${Math.abs(r) >= 1000 ? `${r < 0 ? '-' : ''}${scaled(Math.abs(r), [[1e3, 'k'], [1e6, 'M'], [1e9, 'B'], [1e12, 'T']])}` : r} %`;
}

/** "72 %": a fraction 0 to 1 as a rounded percent. */
export const formatShare = (fraction: number): string => `${Math.round(fraction * 100)} %`;

/** "+12 %", "-8 %", "0 %", "+1.2k %": a percent change, rounded; a change that rounds to nothing is "0 %", and a huge one is compact. The sign is the minus sign's ASCII form on purpose (copy-paste). */
export function formatChange(pct: number): string {
  const r = Math.round(pct);
  if (r === 0) return '0 %';
  const size = Math.abs(r) >= 1000 ? scaled(Math.abs(r), [[1e3, 'k'], [1e6, 'M'], [1e9, 'B'], [1e12, 'T']]) : String(Math.abs(r));
  return `${r > 0 ? '+' : '-'}${size} %`;
}

/** "claude-opus-5-5" reads "Opus 5.5"; an id it does not know is shown as it is. */
export function prettyModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (!m) return id;
  const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}
