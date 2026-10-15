import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SIZE_MIN } from './size';

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

test('the phone touch floor (A5, 44 px) covers the kit Segmented choices, the Menu button and its items', () => {
  const m = /@media \(width < ([\d.]+)rem\) \{([^}]*)\}/.exec(css);
  assert.ok(m, 'index.css has the phone touch-target rule');
  assert.equal(Number(m[1]) * 16, SIZE_MIN.medium, 'the rule ends where the medium size class starts');
  const rule = m[2]!;
  for (const sel of ["[role='radiogroup'] > [role='radio']", "button[aria-haspopup='menu']", "[role='menu'] > [role='menuitem']"]) assert.ok(rule.includes(sel), sel);
  assert.match(rule, /min-height: calc\(var\(--spacing\) \* 11\);/);
  assert.match(rule, /min-width: calc\(var\(--spacing\) \* 11\);/);
});
