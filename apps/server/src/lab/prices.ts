// Efficiency lab (T-287): the input price per model, in US dollars per million tokens. The cost of a slice is its units (the design's
// weights: cache read 0.1, cache write 1.25 for 5 minutes or 2.0 for 1 hour, output 5, plain input 1; token-economy-design.md) times this
// price. Source: Anthropic's first-party price list as cached in the claude-api reference on 2026-10-06. The design's 0.1 read weight is
// the standard ratio; a model whose cache read is priced lower (Opus 5.5: 0.05, Fable 5.1: 0.025) is over-estimated by the read part.
// A model not in the list has no price: its cost is null ("unavailable"), never a guess.

const INPUT_USD_PER_MTOK: [prefix: string, usd: number][] = [
  ['claude-fable-5-1', 10],
  ['claude-fable-5', 10],
  ['claude-mythos-5-1', 10],
  ['claude-opus-5-5', 4],
  ['claude-opus-5', 5],
  ['claude-opus-4-8', 5],
  ['claude-opus-4-7', 5],
  ['claude-opus-4-6', 5],
  ['claude-sonnet-5-5', 2],
  ['claude-sonnet-5', 2],
  ['claude-sonnet-4-6', 3],
  ['claude-haiku-5-5', 0.1],
  ['claude-haiku-4-5', 1],
];

/** Dollars per input token for a model id (`claude-opus-5-5`, `claude-opus-5-5[1m]`, a dated id), or null when unknown. */
export function inputPricePerToken(model: string | null | undefined): number | null {
  if (!model) return null;
  const id = model.replace(/\[[^\]]*\]$/, '');
  let best: [string, number] | null = null;
  for (const row of INPUT_USD_PER_MTOK) {
    if ((id === row[0] || id.startsWith(row[0] + '-')) && (!best || row[0].length > best[0].length)) best = row;
  }
  return best ? best[1] / 1e6 : null;
}
