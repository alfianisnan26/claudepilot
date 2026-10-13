// The model catalogue (T-109): every model family the portal knows, in ONE place. Its capability rank (the automatic downgrade chain:
// Fable to Opus, Opus to Sonnet, Sonnet to Haiku; never up), the id patterns that name it, and the usage windows that belong to it. A new
// family is one line here. Used by auto move (which Claude can take a chat, with which model), the Move flow (apply the model, verify it,
// fall back along the chain) and the web (the Move dialog and the card say "Opus on sekar, was Fable").

export interface ModelFamilyInfo {
  /** `fable`, `opus`, `sonnet`, `haiku`: what `set_model` takes as an alias. */
  family: string;
  /** As people say it: "Fable". */
  name: string;
  /** Capability order: higher is more capable. The downgrade chain walks it down. */
  rank: number;
  /** Matches a model id or alias of the family (`claude-fable-5-1`, `opus[1m]`), case-insensitive. */
  pattern: RegExp;
  /** Usage window keys of the family's own limit (`week_opus`; `model:<slug>` is matched by the slug too). */
  windows: readonly string[];
  /**
   * Whether a Claude is taken to have the family until its `list_models` says otherwise. False for a family only some plans include
   * (Fable): until the list is known, only a Claude that shows the family's usage window counts as having it.
   */
  assumed: boolean;
}

export const MODEL_CATALOGUE: readonly ModelFamilyInfo[] = [
  { family: 'fable', name: 'Fable', rank: 40, pattern: /fable/i, windows: ['model:fable'], assumed: false },
  { family: 'opus', name: 'Opus', rank: 30, pattern: /opus/i, windows: ['week_opus', 'model:opus'], assumed: true },
  { family: 'sonnet', name: 'Sonnet', rank: 20, pattern: /sonnet/i, windows: ['week_sonnet', 'model:sonnet'], assumed: true },
  { family: 'haiku', name: 'Haiku', rank: 10, pattern: /haiku/i, windows: ['model:haiku'], assumed: true },
];

/** The family of a model id or alias (`claude-fable-5-1` is `fable`), or null for one the catalogue doesn't know. */
export function modelFamilyOf(model: string | null | undefined): string | null {
  if (!model) return null;
  return MODEL_CATALOGUE.find((m) => m.pattern.test(model))?.family ?? null;
}

export function modelInfo(family: string | null | undefined): ModelFamilyInfo | null {
  return MODEL_CATALOGUE.find((m) => m.family === family) ?? null;
}

/** "Fable" for `fable` or `claude-fable-5-1`; the value itself when unknown. */
export function modelDisplayName(model: string | null | undefined): string {
  const info = modelInfo(modelFamilyOf(model));
  return info?.name ?? model ?? '';
}

/** Whether a usage window is the family's own limit (`week_opus`, `model:fable`, `model:claude-opus-4`). */
export function isWindowOfFamily(key: string, family: string | null | undefined): boolean {
  const info = modelInfo(family);
  if (!info) return false;
  if (info.windows.includes(key)) return true;
  return key.startsWith('model:') && info.pattern.test(key.slice(6));
}

/**
 * The models to try for a chat on `family`, best first: the family itself, then (with no `override`) every family below it by rank, or
 * the owner's order (`automove.modelFallback`) when given, keeping only families the catalogue knows and never one above `family`.
 * Unknown `family`: just the override.
 */
export function downgradeChain(family: string | null | undefined, override: readonly string[] = []): string[] {
  const info = modelInfo(family);
  const known = override.map((f) => f.trim().toLowerCase()).filter((f) => modelInfo(f));
  if (!info) return [...new Set(known)];
  const below = known.length ? known.filter((f) => modelInfo(f)!.rank <= info.rank) : MODEL_CATALOGUE.filter((m) => m.rank < info.rank).map((m) => m.family);
  return [...new Set([info.family, ...below])];
}

/** Efforts in order, for "the nearest level" when a model lacks the one a chat had. */
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** The effort to ask of a model that supports `levels`: `wanted` when it does, else the nearest (lower on a tie); null when none is known. */
export function nearestEffort(wanted: string | null | undefined, levels: readonly string[]): string | null {
  if (!wanted) return null;
  if (!levels.length || levels.includes(wanted)) return wanted;
  const at = (e: string) => (EFFORT_ORDER as readonly string[]).indexOf(e);
  const w = at(wanted);
  if (w < 0) return null;
  const ranked = levels.filter((l) => at(l) >= 0).sort((a, b) => Math.abs(at(a) - w) - Math.abs(at(b) - w) || at(a) - at(b));
  return ranked[0] ?? null;
}
