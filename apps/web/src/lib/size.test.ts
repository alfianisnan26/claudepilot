import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { atLeast, SIZE_CLASSES, SIZE_MIN, sizeClassOf } from './size';

test('each width falls in its size class, the edges included', () => {
  const cases: [number, string][] = [
    [0, 'compact'],
    [390, 'compact'],
    [599, 'compact'],
    [600, 'medium'],
    [768, 'medium'],
    [1023, 'medium'],
    [1024, 'expanded'],
    [1280, 'expanded'],
    [1599, 'expanded'],
    [1600, 'large'],
    [1920, 'large'],
    [2559, 'large'],
    [2560, 'xlarge'],
    [3440, 'xlarge'],
    [3840, 'xlarge'],
  ];
  for (const [w, want] of cases) assert.equal(sizeClassOf(w), want, `${w} px`);
});

test('atLeast orders the classes from compact to xlarge', () => {
  assert.ok(atLeast('expanded', 'expanded'));
  assert.ok(atLeast('xlarge', 'medium'));
  assert.ok(!atLeast('medium', 'expanded'));
  assert.ok(!atLeast('compact', 'medium'));
  for (const s of SIZE_CLASSES) assert.ok(atLeast(s, 'compact'));
});

test('the CSS breakpoint tokens are the same thresholds as SIZE_MIN (defined once, mirrored, kept equal)', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
  for (const s of SIZE_CLASSES.slice(1)) {
    const m = new RegExp(`--breakpoint-${s}:\\s*([\\d.]+)rem;`).exec(css);
    assert.ok(m, `index.css has --breakpoint-${s}`);
    assert.equal(Number(m[1]) * 16, SIZE_MIN[s], `--breakpoint-${s}`);
  }
});
