// T-296: paths that are one path on a case-insensitive file system (the owner's macOS checkout). Linux (the gate, the cluster) keeps
// them apart, so a clash only breaks on the Mac: `import './Deck'` found deck.ts next to Deck.tsx. Two kinds clash:
//   - two directories, or two files, whose paths are equal ignoring case (X.md and x.md, Web/ and web/);
//   - two modules in one directory whose specifiers are equal ignoring case (Deck.tsx and deck.ts are both './Deck' to the resolver).
// Same name, same case, other extension (a.ts and a.tsx) is not a case clash and is left alone.
const MODULE_EXT = /\.(d\.ts|tsx?|jsx?|mjs|cjs|mts|cts)$/;

/** Groups of paths that collide on a case-insensitive file system; empty when there are none. */
export function caseClashes(paths: readonly string[]): string[][] {
  const groups = new Map<string, Set<string>>();
  const add = (key: string, original: string, shown: string) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = new Set()));
    g.add(`${original}\u0000${shown}`);
  };
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/') + '/';
      add(`d:${dir.toLowerCase()}`, dir, dir);
    }
    add(`f:${path.toLowerCase()}`, path, path);
    if (MODULE_EXT.test(path)) {
      const stem = path.replace(MODULE_EXT, '');
      add(`m:${stem.toLowerCase()}`, stem, path);
    }
  }
  const out: string[][] = [];
  for (const g of groups.values()) {
    const originals = new Set([...g].map((e) => e.split('\u0000')[0]));
    if (originals.size > 1) out.push([...new Set([...g].map((e) => e.split('\u0000')[1]))].sort());
  }
  return out;
}
