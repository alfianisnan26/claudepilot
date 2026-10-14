// T-102: what a delivery changed, by area, from the manifest the workspace had and the one written (owner names only).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedAreas } from './changes.js';
import { dropInPath } from './ownership.js';
import type { Manifest } from './types.js';

const manifest = (over: Partial<Manifest> = {}): Manifest => ({ portalId: 'p', generation: 1, compiledAt: '', pools: [], files: {}, ...over });

test('changedAreas: pools added, removed or revised; changed, new and removed files by their owner; plugin folders; the foundation only alone', () => {
  const mcp = dropInPath('mcpset')!;
  const before = manifest({ pools: [{ type: 'mcpset', id: 'm1', revision: 1 }], files: { [mcp]: 'a' } });
  assert.deepEqual(changedAreas(before, before), [], 'nothing changed');
  assert.deepEqual(changedAreas(before, manifest({ pools: [{ type: 'mcpset', id: 'm1', revision: 2 }], files: { [mcp]: 'a' } })), ['mcpset'], 'a new revision');
  assert.deepEqual(changedAreas(before, manifest({ pools: [], files: {} })), ['mcpset'], 'removed');
  assert.deepEqual(
    changedAreas(before, manifest({ pools: [{ type: 'mcpset', id: 'm1', revision: 1 }, { type: 'secrets', id: 's1', revision: 3 }], files: { [mcp]: 'a' } })),
    ['secrets'],
    'added beside one that did not change',
  );
  const plugin = { owner: 'skillset' as const, name: 'frontend', version: '1', treeHash: 'x'.repeat(64) };
  assert.deepEqual(changedAreas(manifest(), manifest({ plugins: [plugin] })), ['skillset']);
  assert.deepEqual(changedAreas(manifest({ plugins: [plugin] }), manifest({ plugins: [{ ...plugin, treeHash: 'y'.repeat(64) }] })), ['skillset']);
  assert.deepEqual(changedAreas(null, manifest({ files: { '/nowhere/anyone/writes': 'z' } })), ['other'], 'a file nobody may write is named other');
});

test('changedAreas: a drop-in whose content changed is its owner\'s, even without a new revision (a rotated value)', () => {
  for (const owner of ['settings', 'secrets', 'mcpset', 'persona'] as const) {
    const path = dropInPath(owner)!;
    assert.deepEqual(changedAreas(manifest({ files: { [path]: 'a' } }), manifest({ files: { [path]: 'b' } })), [owner]);
  }
});
