import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { OTHERS_HEX, SLOT_HEX, SLOT_PATTERNS, slotColor, slotIndex, type PaletteMode } from './palette.js';

// The checks of the data-viz validator (scripts/validate_palette.js), written again here from their definitions so the palette's claims
// are re-computed from its hex values and a change to a colour that breaks them fails: OKLab Delta E x 100, colour-blind vision by the
// Machado-Oliveira-Fernandes (2009) matrices at severity 1, WCAG contrast against the card surface (#ffffff light, #141415 dark).
const SURFACE: Record<PaletteMode, string> = { light: '#ffffff', dark: '#141415' };
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
} as const;
type Kind = keyof typeof MACHADO;

const srgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linear = (hex: string) => srgb(hex).map(toLinear) as [number, number, number];
const oklab = ([r, g, b]: number[]) => {
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s] as const;
};
const simulate = (hex: string, kind: Kind) => {
  const lin = linear(hex);
  const M = MACHADO[kind];
  return M.map((row) => Math.max(0, Math.min(1, row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])));
};
const deltaE = (a: string, b: string, kind?: Kind): number => {
  const x = oklab(kind ? simulate(a, kind) : linear(a));
  const y = oklab(kind ? simulate(b, kind) : linear(b));
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};
const luminance = (hex: string) => {
  const [r, g, b] = linear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi! + 0.05) / (lo! + 0.05);
};
const lightness = (hex: string) => oklab(linear(hex))[0];
const chroma = (hex: string) => Math.hypot(oklab(linear(hex))[1], oklab(linear(hex))[2]);
const round1 = (v: number) => Math.round(v * 10) / 10;
const min = (xs: number[]) => Math.min(...xs);
const modes: PaletteMode[] = ['light', 'dark'];

test('eight distinct colours per mode, each a #rrggbb', () => {
  for (const mode of modes) {
    assert.equal(SLOT_HEX[mode].length, 8);
    assert.equal(new Set(SLOT_HEX[mode]).size, 8);
    for (const hex of [...SLOT_HEX[mode], OTHERS_HEX[mode]]) assert.match(hex, /^#[0-9a-f]{6}$/);
  }
});

test('palette.css holds the same colours as SLOT_HEX, light first, then both dark selectors', () => {
  const css = readFileSync(new URL('./palette.css', import.meta.url), 'utf8');
  const block = (open: string) => {
    const at = css.indexOf(open);
    assert.ok(at >= 0, `missing ${open}`);
    return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  };
  const read = (body: string) => ({
    slots: Array.from({ length: 8 }, (_, i) => new RegExp(`--usage-slot-${i}:\\s*(#[0-9a-f]{6})`).exec(body)?.[1]),
    others: /--usage-others:\s*(#[0-9a-f]{6})/.exec(body)?.[1],
  });
  const light = read(block(':root {'));
  assert.deepEqual(light.slots, [...SLOT_HEX.light]);
  assert.equal(light.others, OTHERS_HEX.light);
  for (const open of [":root:not([data-theme='light']) {", ":root[data-theme='dark'] {"]) {
    const dark = read(block(open));
    assert.deepEqual(dark.slots, [...SLOT_HEX.dark], open);
    assert.equal(dark.others, OTHERS_HEX.dark, open);
  }
});

test('every colour is in the lightness band, has chroma of at least 0.10 and 3:1 on its surface', () => {
  const band = { light: [0.43, 0.77], dark: [0.48, 0.67] } as const;
  for (const mode of modes) {
    for (const hex of SLOT_HEX[mode]) {
      const L = lightness(hex);
      assert.ok(L >= band[mode][0] && L <= band[mode][1], `${mode} ${hex} L ${L.toFixed(3)} outside ${band[mode]}`);
      assert.ok(chroma(hex) >= 0.1, `${mode} ${hex} chroma ${chroma(hex).toFixed(3)}`);
      assert.ok(contrast(hex, SURFACE[mode]) >= 3, `${mode} ${hex} contrast ${contrast(hex, SURFACE[mode]).toFixed(2)}`);
    }
    assert.ok(contrast(OTHERS_HEX[mode], SURFACE[mode]) >= 3, `${mode} others contrast`);
  }
});

test('neighbouring slots: colour-blind separation of 8 or more, normal vision of 15 or more (the validator, re-computed)', () => {
  // The numbers quoted in palette.ts: worst neighbouring pair, CVD (protan and deutan), tritan and normal vision, light then dark.
  const quoted = { light: { cvd: 13.2, tritan: 12.1, normal: 22.5 }, dark: { cvd: 13.9, tritan: 12.4, normal: 22.1 } };
  for (const mode of modes) {
    const hex = SLOT_HEX[mode];
    const pairs = hex.slice(0, -1).map((h, i) => [h, hex[i + 1]!] as const);
    const cvd = min(pairs.map(([a, b]) => Math.min(deltaE(a, b, 'protan'), deltaE(a, b, 'deutan'))));
    const tritan = min(pairs.map(([a, b]) => deltaE(a, b, 'tritan')));
    const normal = min(pairs.map(([a, b]) => deltaE(a, b)));
    assert.ok(cvd >= 8 && normal >= 15, `${mode}: cvd ${cvd.toFixed(1)}, normal ${normal.toFixed(1)}`);
    assert.deepEqual({ cvd: round1(cvd), tritan: round1(tritan), normal: round1(normal) }, quoted[mode]);
  }
});

test('the first four slots stay apart in every pairing (they are the ones most installs use)', () => {
  const quoted = { light: { cvd: 11.2, normal: 15.3 }, dark: { cvd: 12.2, normal: 17.2 } };
  for (const mode of modes) {
    const hex = SLOT_HEX[mode].slice(0, 4);
    const pairs = hex.flatMap((a, i) => hex.slice(i + 1).map((b) => [a, b] as const));
    const cvd = min(pairs.map(([a, b]) => Math.min(deltaE(a, b, 'protan'), deltaE(a, b, 'deutan'))));
    const normal = min(pairs.map(([a, b]) => deltaE(a, b)));
    assert.ok(cvd >= 8 && normal >= 15, `${mode}: cvd ${cvd.toFixed(1)}, normal ${normal.toFixed(1)}`);
    assert.deepEqual({ cvd: round1(cvd), normal: round1(normal) }, quoted[mode]);
  }
});

test('"Others" is a grey: it has almost no chroma, so no slot can be mistaken for it by hue', () => {
  for (const mode of modes) assert.ok(chroma(OTHERS_HEX[mode]) < 0.02, `${mode} others chroma ${chroma(OTHERS_HEX[mode]).toFixed(3)}`);
});

test('slotIndex and slotColor: a number 0 to 7 is a slot, anything else is the grey', () => {
  assert.equal(slotIndex(0), 0);
  assert.equal(slotIndex(7), 7);
  for (const bad of [null, undefined, 8, -1, 1.5, Number.NaN]) assert.equal(slotIndex(bad), null);
  assert.equal(slotColor(3), 'var(--usage-slot-3)');
  assert.equal(slotColor(null), 'var(--usage-others)');
  assert.equal(slotColor(undefined), 'var(--usage-others)');
  assert.equal(slotColor(9), 'var(--usage-others)');
});

test('each slot has its own hatch: slot 0 is solid, the other seven all differ', () => {
  assert.equal(SLOT_PATTERNS.length, 8);
  assert.equal(SLOT_PATTERNS[0]!.length, 0);
  const seen = new Set(SLOT_PATTERNS.slice(1).map((marks) => JSON.stringify(marks)));
  assert.equal(seen.size, 7);
  for (const marks of SLOT_PATTERNS.slice(1)) assert.ok(marks.length > 0);
});
