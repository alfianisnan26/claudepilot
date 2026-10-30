// T-1988: the Timeline's Done colour (index.css `--done`, the `bg-done` class) in both themes: it must read against the surface the chart
// sits on, stand apart from In progress (the accent green it used to share), and carry its white letter.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { contrastRatio, dark, light } from '@isnanme/tokens';
import { STATE_LOOK } from './layout';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'index.css'), 'utf8');

/** Every `--done: #hex` in index.css, in order: light first, then the two dark rules (system dark and data-theme dark). */
const doneValues = (): string[] => [...css.matchAll(/--done:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => m[1]!);

test('Done has its own token, wired to the bar and the legend swatch', () => {
  assert.equal(STATE_LOOK.done.bar, 'bg-done');
  assert.match(css, /--color-done:\s*var\(--done\)/);
  const [lightDone, ...darkDone] = doneValues();
  assert.ok(lightDone, 'a light value');
  assert.equal(darkDone.length, 2, 'both dark rules set it');
  assert.equal(darkDone[0], darkDone[1], 'the two dark rules agree');
});

test('Done reads against the surface, apart from In progress, and under its white letter, in light and in dark', () => {
  const [lightDone, darkDone] = doneValues();
  for (const [name, theme, done] of [
    ['light', light, lightDone!],
    ['dark', dark, darkDone!],
  ] as const) {
    assert.ok(contrastRatio(done, theme.colors.surface) >= 3, `${name}: 3:1 against the surface`);
    assert.ok(contrastRatio(done, theme.colors.accent) >= 1.8, `${name}: apart from the accent (In progress) in lightness, not only hue`);
    assert.ok(contrastRatio(done, '#ffffff') >= 4.5, `${name}: the white letter`);
  }
  assert.equal(STATE_LOOK.done.ink, 'text-white');
});
