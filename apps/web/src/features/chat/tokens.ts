// Token counts as the portal prints them ("950", "84k", "1.2M"). No React: the reporter panel's chat header uses it too (PILOT-1111).

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_500) return `${(n / 1000).toFixed(n < 9_950 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A small dollar amount: more decimals the smaller it is, so cents still read. */
export const formatUsd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
