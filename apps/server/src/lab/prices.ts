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

/**
 * The cache-read weight per model (slice 2), as a fraction of the input price. Source: the same price list as above (cache read Opus 5.5 0.05,
 * Fable 5.1 0.025 of input); every other model at the design's 0.1 (token-economy-design.md, the standard ratio). `units.read` keeps 0.1 so
 * the lab equals the reference script; the cost uses this weight.
 */
const READ_WEIGHT: [prefix: string, weight: number][] = [
  ['claude-opus-5-5', 0.05],
  ['claude-fable-5-1', 0.025],
];

export function cacheReadWeight(model: string | null | undefined): number {
  const id = (model ?? '').replace(/\[[^\]]*\]$/, '');
  const hit = READ_WEIGHT.find(([p]) => id === p || id.startsWith(p + '-'));
  return hit ? hit[1] : 0.1;
}

/**
 * T-343: what one API call cost at list price, an ESTIMATE with the same weights as the lab (cache read per model, cache write 1.25 for
 * 5 minutes or 2.0 for 1 hour, output 5) times the model's input price. Null when the model has no price ("unavailable", never a guess).
 */
export function callCostUsd(
  model: string | null | undefined,
  t: { input: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; output: number },
): number | null {
  const price = inputPricePerToken(model);
  if (price === null) return null;
  return (t.input + cacheReadWeight(model) * t.cacheRead + 1.25 * t.cacheWrite5m + 2 * t.cacheWrite1h + 5 * t.output) * price;
}
