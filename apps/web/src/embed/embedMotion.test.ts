// The panel's motion rules (owner, 2026-11-01): short, transform and opacity only, and none with reduced motion.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('./embed.css', import.meta.url), 'utf8');
const cut = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
const motion = css.slice(css.indexOf('/* Motion (owner, 2026-11-01)'), cut);
const reduced = css.slice(cut);

const classes = [...motion.matchAll(/^\.(anim-[\w-]+) \{\n\s+animation: (pr-[\w-]+) (\d+)ms/gm)].map((m) => ({ cls: m[1]!, frames: m[2]!, ms: Number(m[3]) }));

test('every anim-* class lasts 150-250 ms', () => {
  assert.ok(classes.length >= 5, `found ${classes.map((c) => c.cls).join(', ')}`);
  for (const c of classes) assert.ok(c.ms >= 150 && c.ms <= 250, `${c.cls} ${c.ms} ms`);
});

test('their keyframes animate transform or opacity only (GPU-friendly, no layout)', () => {
  for (const c of classes) {
    const body = new RegExp(`@keyframes ${c.frames} \\{([\\s\\S]*?)\\n\\}`).exec(motion)?.[1];
    assert.ok(body, `keyframes ${c.frames}`);
    const props = [...body.matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]);
    for (const p of props) assert.ok(p === 'opacity' || p === 'transform', `${c.frames} animates ${p}`);
  }
});

test('reduced motion turns every anim-* class and the spinner off', () => {
  for (const c of classes) assert.match(reduced, new RegExp(`\\.${c.cls}[,\\s]`), `${c.cls} under reduced motion`);
  assert.match(reduced, /\.spinner \{\s+animation: none;/);
});
