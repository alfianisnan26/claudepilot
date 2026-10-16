import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// T-772: under `forced-colors: active` a box-shadow ring is dropped, so a control that sets `outline-none` shows no focus
// indicator at all. Tailwind v4's `outline-hidden` keeps a transparent outline that forced-colors turns into a real one.
const dir = dirname(fileURLToPath(import.meta.url));

test('the ci feature never uses outline-none (use outline-hidden)', () => {
  const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'));
  assert.ok(files.length > 5);
  const hits: string[] = [];
  for (const f of files) {
    readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/(^|[\s'"`:])(?:[a-z-]+:)*outline-none(?=[\s'"`]|$)/.test(line)) hits.push(`${f}:${i + 1}`);
      });
  }
  assert.deepEqual(hits, []);
});
