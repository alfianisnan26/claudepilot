// Glob matching shared by the portal (branch and tag filters) and the runner (artifact paths). No imports.

const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** GitHub's glob: `*` stays inside one `/` segment, `**` crosses them, `?` is one character. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        // `**/` also matches nothing, so `**/x` matches `x`.
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

export const globMatches = (globs: readonly string[], name: string): boolean => globs.some((g) => globToRegExp(g).test(name));

/** An artifact path matches a file when it is a glob that matches, or a folder (or file) it names exactly. */
export function artifactMatches(patterns: readonly string[], rel: string): boolean {
  return patterns.some((p) => {
    const bare = p.replace(/\/+$/, '');
    if (!/[*?]/.test(bare)) return rel === bare || rel.startsWith(`${bare}/`);
    return globToRegExp(bare).test(rel) || globToRegExp(`${bare}/**`).test(rel);
  });
}
