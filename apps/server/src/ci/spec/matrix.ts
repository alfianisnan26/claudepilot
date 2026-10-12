// `strategy.matrix` (PRD §9.4): the combinations a job expands to, GitHub's way. The values are literals in the file, so the
// expansion is known when the file is read and its size can be refused before anything runs.

export type Scalar = string | number | boolean;
export type Combo = Record<string, Scalar>;

export interface MatrixDef {
  /** Each key and its values. */
  axes: Record<string, Scalar[]>;
  include: Combo[];
  exclude: Combo[];
}

const same = (a: Scalar | undefined, b: Scalar | undefined) => a !== undefined && b !== undefined && String(a) === String(b);

/**
 * The cartesian product of the axes, minus what `exclude` names, with each `include` entry added to the combinations it can be
 * added to without changing a value an axis gave them, or as a combination of its own when it fits none.
 */
export function expandMatrix(def: MatrixDef): Combo[] {
  const keys = Object.keys(def.axes);
  let combos: Combo[] = keys.length ? [{}] : [];
  for (const key of keys) combos = combos.flatMap((c) => def.axes[key]!.map((v) => ({ ...c, [key]: v })));
  combos = combos.filter((c) => !def.exclude.some((x) => Object.keys(x).every((k) => same(c[k], x[k]))));
  // Includes work on the combinations the axes made, never on each other's.
  const extra: Combo[] = [];
  for (const inc of def.include) {
    let added = false;
    for (const c of combos) {
      // It fits when it does not give an axis key another value than the combination already has.
      if (keys.every((k) => !(k in inc) || same(c[k], inc[k]))) {
        for (const [k, v] of Object.entries(inc)) if (!keys.includes(k)) c[k] = v;
        added = true;
      }
    }
    if (!added) extra.push({ ...inc });
  }
  return [...combos, ...extra];
}

/** `20, linux`: the values of a combination, for a job's display name. */
export const comboLabel = (combo: Combo): string => Object.values(combo).map(String).join(', ');
