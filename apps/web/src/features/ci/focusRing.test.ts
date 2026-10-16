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

// Glued class names (`focus:outline-hiddenfocus-visible:ring-2`) are silently dead: neither utility applies. Two narrow patterns:
// `outline-hidden` (complete on its own) followed directly by a letter, and a well-known variant prefix (`focus:`, `focus-visible:`,
// `hover:`, `sm:` ...) that starts right after a letter, digit or `]` instead of after a space, quote or another variant's colon.
// Prefixes joined with `-` (`group-focus:`) or `:` (`sm:focus:`) are not flagged.
const VARIANTS = 'focus-visible|focus-within|focus|hover|active|disabled|dark|sm|md|lg|xl|2xl';
const GLUED = [/outline-hidden(?=[a-z])/, new RegExp(`[a-z0-9\\]](?:${VARIANTS}):[a-z\\[]`)];

test('the ci feature has no glued class names', () => {
  const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'));
  const hits: string[] = [];
  for (const f of files) {
    readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (GLUED.some((re) => re.test(line))) hits.push(`${f}:${i + 1}`);
      });
  }
  assert.deepEqual(hits, []);
});
