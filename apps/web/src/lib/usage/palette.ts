// One colour per Claude and per model, everywhere (round 4 plan P3, docs/prd/claude-usage.md §20.6). The portal gives each Claude and model a
// stable slot (0 to 7, or null) and keeps it; this file owns what a slot LOOKS like, so a chart, a legend, a chip, a widget and the Move
// dialog all draw the same Claude in the same colour.
//
// Import from `@/lib/usage` (the index: it also loads palette.css, where the colours live as CSS variables), never from this file.
//
// THE PALETTE. Hue families after the Okabe-Ito set (reddish purple, bluish green, vermillion, blue, sky blue, and the yellow stepped down
// to olive so it holds 3:1 on white) plus violet and red, one hex per slot per mode, each stepped into the lightness band for the card
// surface the charts sit on (#ffffff light, #141415 dark: `--color-surface`). The order is the safety mechanism: a search over families,
// lightness and order maximised the colour-blind separation of neighbouring slots, then the data-viz validator checked the result
// (scripts/validate_palette.js; CVD simulated with the Machado-Oliveira-Fernandes 2009 model at severity 1; Delta E is OKLab x 100):
//   neighbouring slots (n and n+1: the pairs that touch in a stack)        light             dark
//     worst CVD separation, protan and deutan (target 8)                   13.2              13.9
//     worst tritan separation                                              12.1              12.4
//     worst normal-vision separation (floor 15)                            22.5              22.1
//   the first four slots, ALL pairs (any two touch once a slot is hidden)  CVD 11.2, normal 15.3 | CVD 12.2, normal 17.2
// Every colour sits in the lightness band (OKLCH L 0.43 to 0.77 light, 0.48 to 0.67 dark), has chroma >= 0.10 and reaches 3:1 on its
// surface. All eight in all pairs cannot pass (no ordering of eight can: the data-viz notes say so), so slots 5 to 8 lean on the
// non-colour cues below. `palette.test.ts` re-computes every number in this comment from the hex values.
//
// NON-COLOUR CUES (colour is never the only signal): a stack always runs in slot order from the baseline with "Others" on top and the
// legend lists the same order; the tooltip names every segment; each slot has a hatch pattern (SLOT_PATTERNS) that the legend and the
// bars can wear (the Patterns switch, on by default under `forced-colors` and `prefers-contrast: more`); segments are 2 px apart.

import { USAGE_PALETTE_SLOTS, type PaletteSlot } from '@portal/contracts';

export type PaletteMode = 'light' | 'dark';

/** The colours, slot 0 to 7, per mode. Kept in step with palette.css (palette.test.ts checks they agree). */
export const SLOT_HEX: Record<PaletteMode, readonly string[]> = {
  light: ['#a0429f', '#009e73', '#9d78ed', '#b14d00', '#4e62d0', '#e8605b', '#0096c3', '#928e00'],
  dark: ['#a73f95', '#00a97b', '#a07bf0', '#b95100', '#5468d6', '#eb635e', '#0093bf', '#8f8b00'],
};

/** "Others" and anything without a slot: a neutral grey, 3:1 or better on its surface. */
export const OTHERS_HEX: Record<PaletteMode, string> = { light: '#8a8a86', dark: '#8b8b92' };

/** What each slot's hue is called (for tests and docs, never the only way to tell them apart). */
export const SLOT_HUES = ['magenta', 'bluish green', 'violet', 'vermillion', 'indigo', 'red', 'sky blue', 'olive'] as const;

/** The key "Others" has in a chart (a Claude or model id can never be this: ids are `claude-...`, UUIDs or `default:...`). */
export const OTHERS_KEY = 'others';

/** The slot as 0 to 7, or null for none (null, undefined or out of range: all drawn grey). */
export function slotIndex(slot: PaletteSlot | undefined): number | null {
  return typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot < USAGE_PALETTE_SLOTS ? slot : null;
}

/** The CSS colour of a slot (`var(--usage-slot-3)`, or the neutral grey): for `fill`, `stroke`, `background` and `color`, in HTML and SVG. */
export function slotColor(slot: PaletteSlot | undefined): string {
  const i = slotIndex(slot);
  return i === null ? 'var(--usage-others)' : `var(--usage-slot-${i})`;
}

/** One mark of a pattern tile (6 x 6). */
export type PatternMark = { type: 'path'; d: string } | { type: 'circle'; cx: number; cy: number; r: number };

export const PATTERN_TILE = 6;

/**
 * A hatch for each slot, drawn over the colour in the surface's own colour so it reads on every slot in both themes. Slot 0 is solid (the
 * absence of a pattern is itself one), the others differ in direction and kind so no two look alike even in grey: / lines, dots, horizontal
 * lines, \ lines, vertical lines, a grid, a sparse dot grid. "Others" is solid grey.
 */
export const SLOT_PATTERNS: readonly (readonly PatternMark[])[] = [
  [],
  [{ type: 'path', d: 'M-1,1 L1,-1 M0,6 L6,0 M5,7 L7,5' }],
  [{ type: 'circle', cx: 3, cy: 3, r: 1.15 }],
  [{ type: 'path', d: 'M0,1.5 H6 M0,4.5 H6' }],
  [{ type: 'path', d: 'M-1,5 L1,7 M0,0 L6,6 M5,-1 L7,1' }],
  [{ type: 'path', d: 'M1.5,0 V6 M4.5,0 V6' }],
  [{ type: 'path', d: 'M0,3 H6 M3,0 V6' }],
  [{ type: 'circle', cx: 1.5, cy: 1.5, r: 0.8 }, { type: 'circle', cx: 4.5, cy: 4.5, r: 0.8 }],
];

/**
 * Who the browser's preferences belong to. The portal has one owner today (`u_owner`); several users are coming (PLAN-10), and a preference
 * a person sets (a range, the patterns switch) must then be theirs alone, so every such key carries the user's id.
 */
export const USER_ID = 'u_owner';
export const userKey = (name: string): string => `${USER_ID}.${name}`;

/** Where a person turned patterns on or off (a per-device, per-user choice). */
export const PATTERNS_KEY = userKey('pilot.usage.patterns');
