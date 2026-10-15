// T-472: the context pack's path scope (contextPack.ts `packScope`, `scopedPack`) and a scoped rule file's layout (render.ts `contextFile`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packScope, scopedPack } from './contextPack.js';
import { contextFile } from './render.js';

const MAP = ['# Pack', '', '## Map', '', '- `../up/x`: no', '- `/etc/x/y`: no', '- `a b/c`: no', '- `src/app`: yes', '- `lib/x/main.ts`: a file', '- `web/features/*`: a folder', '- `tools/`: one level', '', '## Next', '- `other/place`: not the Map'].join('\n');

test('T-472: the scope is the Map’s folders: unsafe, absolute and one-level entries are left out, and nothing past the Map', () => {
  assert.deepEqual(packScope(MAP), ['src/app/**', 'lib/x/main.ts', 'web/features/**']);
});

test('T-472: a pack without a usable Map, or with its own frontmatter, stays as it is; else the frontmatter comes first', () => {
  assert.equal(scopedPack('# Pack\n\nNo map.'), '# Pack\n\nNo map.');
  const own = '---\npaths:\n  - "x/**"\n---\n## Map\n- `src/app`: yes';
  assert.equal(scopedPack(own), own);
  assert.equal(scopedPack(MAP), `---\npaths:\n  - "src/app/**"\n  - "lib/x/main.ts"\n  - "web/features/**"\n---\n${MAP}`);
});

test('T-472: a context with frontmatter keeps it at the top of its rule file; one without is delivered as before', () => {
  assert.equal(contextFile('x', 'X', 2, '---\npaths:\n  - "a/**"\n---\nBody\n').content, '---\npaths:\n  - "a/**"\n---\n<!-- Instruction context “X” r2, delivered by the portal. -->\nBody\n');
  assert.equal(contextFile('x', 'X', 2, 'Body').content, '<!-- Instruction context “X” r2, delivered by the portal. -->\nBody\n');
});
