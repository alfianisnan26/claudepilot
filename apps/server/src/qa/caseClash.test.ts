// T-296: no two paths of the repository may be one path on a case-insensitive file system (the owner's macOS checkout). The gate runs
// on a `git archive` copy (no .git), so the check walks the tree and skips what is not source.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { caseClashes } from './caseClash.js';

test('a module next to another whose name differs only by case clashes (Deck.tsx and deck.ts)', () => {
  assert.deepEqual(caseClashes(['web/attention/Deck.tsx', 'web/attention/deck.ts', 'web/attention/deck.test.ts']), [
    ['web/attention/Deck.tsx', 'web/attention/deck.ts'],
  ]);
});

test('files and directories equal ignoring case clash; other extensions and other folders do not', () => {
  assert.deepEqual(caseClashes(['docs/X.md', 'docs/x.md']), [['docs/X.md', 'docs/x.md']]);
  assert.deepEqual(caseClashes(['Web/a.ts', 'web/b.ts']), [['Web/', 'web/']]);
  assert.deepEqual(caseClashes(['a/Deck.tsx', 'b/deck.ts', 'a/x.ts', 'a/x.tsx', 'a/README.md', 'a/readme.txt', 'a/Deck.css']), []);
});

const SKIP = new Set(['node_modules', '.git', 'dist', '.data', '.home', 'references', 'coverage', 'test-results']);

function walk(root: string, dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (relative(root, full) === join('.pilot', 'out')) continue;
    if (e.isDirectory()) walk(root, full, out);
    else out.push(relative(root, full).split('\\').join('/'));
  }
}

test('the repository has no paths that clash on a case-insensitive file system', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const paths: string[] = [];
  walk(root, root, paths);
  assert.ok(paths.some((p) => p === 'apps/server/src/qa/caseClash.ts'), `walked the wrong root: ${root}`);
  assert.deepEqual(caseClashes(paths), [], 'rename one of each group (macOS checkouts are case-insensitive)');
});
