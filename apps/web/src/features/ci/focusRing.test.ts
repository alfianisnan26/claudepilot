import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// T-772: under `forced-colors: active` a box-shadow ring is dropped, so a control that sets `outline-none` shows no focus
// indicator at all. Tailwind v4's `outline-hidden` keeps a transparent outline that forced-colors turns into a real one.
// The scan covers all of apps/web/src (tests excluded), not just the ci feature.
const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', '..');

function sourceFiles(): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .sort();
}

function lines(file: string): string[] {
  return readFileSync(join(srcDir, file), 'utf8').split('\n');
}

// `outline-none` is allowed only on a container that takes programmatic focus and says so with an explicit marker: the attribute
// `data-focus-container` (set where the container is made, on the same line or within the 14 lines above the class: dialogs,
// panels, popovers, <main>). The marker is not a stand-in for `tabindex="-1"`: a real control that happens to have
// `tabIndex={-1}` (a hidden submit, a KeyBar key) is not a container and must use `outline-hidden`. A marker is valid only
// on an element that also has `tabIndex={-1}` (a container nobody can tab to). Anything a person can tab to uses `outline-hidden`.
const OUTLINE_NONE = /(^|[\s'"`:\]])(?:[a-z-]+:)*outline-none(?=[\s'"`]|$)/;
const MARKER = /(^|[\s<])data-focus-container(?=[\s/>=]|$)/;
const PROGRAMMATIC_ONLY = /tabIndex=\{-1\}/;
const LOOKBACK = 14;

function outlineNoneHits(file: string, src: string[]): string[] {
  const hits: string[] = [];
  src.forEach((line, i) => {
    if (!OUTLINE_NONE.test(line)) return;
    const near = src.slice(Math.max(0, i - LOOKBACK), i + 1);
    if (!near.some((l) => MARKER.test(l))) hits.push(`${file}:${i + 1}`);
  });
  return hits;
}

/** A marker with no `tabIndex={-1}` beside it (up to the lookback, and a few lines after) would hide the ring of a tabbable element. */
function markerHits(file: string, src: string[]): string[] {
  const hits: string[] = [];
  src.forEach((line, i) => {
    if (!MARKER.test(line)) return;
    const near = src.slice(Math.max(0, i - LOOKBACK), i + LOOKBACK + 1);
    if (!near.some((l) => PROGRAMMATIC_ONLY.test(l))) hits.push(`${file}:${i + 1}`);
  });
  return hits;
}

test('no focusable control uses outline-none (use outline-hidden)', () => {
  const files = sourceFiles();
  assert.ok(files.length > 100, `expected the whole web source, got ${files.length} files`);
  const hits = files.flatMap((f) => outlineNoneHits(f, lines(f)));
  assert.deepEqual(hits, []);
});

test('a data-focus-container marker sits only on an element with tabIndex={-1}, and the 9 containers are all marked', () => {
  const files = sourceFiles();
  assert.deepEqual(files.flatMap((f) => markerHits(f, lines(f))), []);
  const marked = files.filter((f) => lines(f).some((l) => MARKER.test(l)));
  // the exact list: a marker on a real control (KeyBar, ModelPicker, ...) or a container left unmarked changes it
  assert.deepEqual(marked, [
    'components/AccountMenu.tsx',
    'components/AppShell.tsx',
    'components/Workbench.tsx',
    'features/chat/AgentsPanel.tsx',
    'features/chat/FilesPanel.tsx',
    'features/chat/ImageViewer.tsx',
    'features/chat/artifacts/FileViewer.tsx',
    'features/chat/btw/BtwCard.tsx',
    'features/glance/Popover.tsx',
  ]);
});

test('outline-none is only tolerated beside the data-focus-container marker', () => {
  assert.deepEqual(outlineNoneHits('x.tsx', ['<button className="outline-none focus-visible:ring-2">']), ['x.tsx:1']);
  assert.deepEqual(outlineNoneHits('x.tsx', ['<input className="focus:outline-none">']), ['x.tsx:1']);
  assert.deepEqual(outlineNoneHits('x.tsx', ['<div tabIndex={-1}', 'data-focus-container', 'className="outline-none">']), []);
  assert.deepEqual(outlineNoneHits('x.tsx', ['<div className="outline-hidden">']), []);
  // a REAL tabindex=-1 control (no marker) is not excluded: its outline-none is flagged
  assert.deepEqual(outlineNoneHits('x.tsx', ['<button type="button" tabIndex={-1}', 'className="outline-none">']), ['x.tsx:2']);
  // a marker is not matched inside another attribute name or a class string
  assert.deepEqual(outlineNoneHits('x.tsx', ['<div data-focus-containers className="outline-none">']), ['x.tsx:1']);
  // a marked container with no tabIndex={-1} is flagged: the marker would hide the ring of a tabbable element
  assert.deepEqual(markerHits('x.tsx', ['<div data-focus-container className="outline-none">']), ['x.tsx:1']);
  assert.deepEqual(markerHits('x.tsx', ['<div tabIndex={-1}', 'data-focus-container>']), []);
});

// Glued class names (`focus:outline-hiddenfocus-visible:ring-2`) are silently dead: neither utility applies. Two detectors:
// 1. `outline-hidden` (complete on its own) followed directly by a letter.
// 2. A variant (`focus:`, `forced-colors:`, `aria-[..]:`, `group-hover:`, `[&>svg]:` ...) whose name ends a chunk that starts with
//    something else: the chunk before the colon is split on `:` and each variant chunk must not end in a known variant root
//    that follows a finished utility. "Finished" means a digit, `)`, `%` or `]` right before the root, or letters inside a
//    hyphenated utility (`outline-hidden|focus`). A root after `-` is a compound variant (`group-focus`, `max-md`). Plain words
//    (`inactive:`, `cmd:`, `refocus:`) have no hyphen before the root, so they pass. `2xl` is a root, not `2` + `xl`.
const ROOTS = [
  'focus-visible', 'focus-within', 'focus', 'hover', 'active', 'disabled', 'enabled', 'checked', 'dark', 'forced-colors',
  'motion-safe', 'motion-reduce', 'placeholder', 'file', 'selection', 'first', 'last', 'odd', 'even', 'open', 'read-only',
  'empty', 'required', 'invalid', 'before', 'after', 'print', '2xl', 'xl', 'lg', 'md', 'sm',
  'aria-\\[[^\\]]*\\]', 'aria-[a-z-]+', 'data-\\[[^\\]]*\\]', 'data-[a-z-]+', 'group-[a-z-]+', 'peer-[a-z-]+', '\\[&[^\\]]*\\]',
];
const ROOT_AT_END = new RegExp(`(?:${ROOTS.join('|')})$`);

function gluedVariant(line: string): boolean {
  // a colon inside brackets (`[&:hover]`, `data-[a:b]`) is not a variant separator
  const masked = line.replace(/\[[^\]]*\]/g, (m) => m.replaceAll(':', '\u0001'));
  for (const token of masked.split(/[\s'"`{},;=]+/)) {
    const segs = token.split(':');
    if (segs.length < 2 || !segs[segs.length - 1]) continue;
    for (const seg of segs.slice(0, -1)) {
      const m = ROOT_AT_END.exec(seg);
      if (!m || m.index === 0) continue;
      const before = seg.slice(0, m.index);
      if (before.endsWith('-')) continue;
      if (/\d$/.test(before) && m[0] === 'xl') continue;
      if (/[)%\]\d]$/.test(before)) return true;
      if (/[a-z]$/.test(before) && before.includes('-')) return true;
    }
  }
  return false;
}

const GLUED: Array<(line: string) => boolean> = [(line) => /outline-hidden(?=[a-z])/.test(line), gluedVariant];

function isGlued(line: string): boolean {
  return GLUED.some((detect) => detect(line));
}

test('the glue detectors flag known glued strings and pass known good ones', () => {
  assert.ok(GLUED.length >= 2, 'GLUED must not be emptied');
  const glued = [
    'focus:outline-hiddenfocus-visible:ring-2',
    'outline-hiddenhover:bg-surface-2',
    'rounded-lgfocus:ring-2',
    'p-4hover:bg-surface',
    'w-[3px]sm:flex',
    'h-50%hover:flex',
    'w-(--x)md:flex',
    'sm:ring-2forced-colors:outline-hidden',
    'bg-accentaria-[y]:bg-surface',
    'ring-2data-[x]:flex',
    'ring-2motion-safe:transition',
    'ring-2motion-reduce:transition-none',
    'ring-2[&>svg]:size-4',
    'ring-2group-hover:bg-surface',
    'ring-2peer-focus:ring',
    'ring-2file:text-sm',
    'text-white/80placeholder:text-muted',
    'min-h-11focus-visible:ring-2',
  ];
  for (const s of glued) assert.ok(isGlued(`className="${s}"`), `should be flagged: ${s}`);
  const good = [
    '2xl:grid-cols-4',
    'max-md:flex',
    'sm:focus:ring',
    'group-focus:ring',
    'peer-focus:ring-2',
    'peer-focus:',
    'data-[x]:flex',
    'data-[state=open]:flex',
    'aria-[y]:flex',
    'aria-busy:opacity-50',
    'inactive:bg-surface',
    'cmd:run',
    'refocus:x',
    '[&>svg]:size-4',
    '[&:hover]:underline',
    'group-hover/item:underline',
    'forced-colors:outline-hidden',
    'motion-reduce:transition-none',
    'focus:outline-hidden focus-visible:ring-2',
    'placeholder:text-muted file:mr-2',
    'user-profile: string',
  ];
  for (const s of good) assert.ok(!isGlued(`className="${s}"`), `should not be flagged: ${s}`);
  // the line an earlier slice fixed (RunsTab) in its glued form
  assert.ok(isGlued('className="rounded-lg focus:outline-hiddenfocus-visible:ring-2"'));
});

test('no source file has glued class names', () => {
  const hits: string[] = [];
  for (const f of sourceFiles()) lines(f).forEach((line, i) => isGlued(line) && hits.push(`${f}:${i + 1}`));
  assert.deepEqual(hits, []);
});

// The EFFECTIVE outline of a declaration block (T-772 S2e): declarations apply in order, the `outline` shorthand resets style, width
// and colour to their initial values (none, medium, currentcolor), and a later longhand overrides it. A first-match regex on the
// shorthand would pass `outline: 2px solid Highlight; outline-width: 0`, which draws nothing.
interface Outline { style: string; width: string; color: string }
const STYLES = ['none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset', 'auto'];
const WIDTH = /^(?:thin|medium|thick|[+-]?(?:\d+\.?\d*|\.\d+)(?:[a-z%]+)?|calc\(.*\))$/i;

// CSS cascade order: an `!important` declaration beats every normal one, whatever the source order; among declarations of the same
// importance the later one wins. `important` remembers, per longhand, whether the current value came from an important declaration.
export function effectiveOutline(body: string): Outline {
  const out: Outline = { style: 'none', width: 'medium', color: 'currentcolor' };
  const important: Record<keyof Outline, boolean> = { style: false, width: false, color: false };
  const set = (key: keyof Outline, value: string, imp: boolean): void => {
    if (important[key] && !imp) return;
    out[key] = value;
    important[key] = imp;
  };
  for (const decl of body.split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const imp = /!\s*important/i.test(decl);
    const value = decl.slice(at + 1).replace(/!\s*important/i, '').trim();
    if (prop === 'outline') {
      // the shorthand resets all three longhands, each subject to the same importance rule
      let style = 'none';
      let width = 'medium';
      let color = 'currentcolor';
      for (const tok of value.split(/\s+(?![^(]*\))/).filter(Boolean)) {
        if (STYLES.includes(tok.toLowerCase())) style = tok.toLowerCase();
        else if (WIDTH.test(tok)) width = tok;
        else color = tok;
      }
      set('style', style, imp);
      set('width', width, imp);
      set('color', color, imp);
    } else if (prop === 'outline-style') set('style', value.toLowerCase(), imp);
    else if (prop === 'outline-width') set('width', value, imp);
    else if (prop === 'outline-color') set('color', value, imp);
  }
  return out;
}

interface Quantity { n: number; unit: string }

/** A tiny calc() evaluator: numbers with units, + - * / and parentheses. Null when it cannot be proven (mixed units, var(), a function). */
function evalCalc(expr: string): Quantity | null {
  const tokens = expr.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[a-z%]+)?|[()+\-*/]|\S/gi) ?? [];
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const number = (t: string): Quantity | null => {
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i.exec(t);
    return m ? { n: Number(m[1]), unit: m[2]!.toLowerCase() } : null;
  };
  const primary = (): Quantity | null => {
    const t = tokens[pos++];
    if (t === undefined) return null;
    if (t === '(') {
      const v = sum();
      if (tokens[pos++] !== ')') return null;
      return v;
    }
    return number(t);
  };
  const product = (): Quantity | null => {
    let left = primary();
    while (left && (peek() === '*' || peek() === '/')) {
      const op = tokens[pos++];
      const right = primary();
      if (!right) return null;
      if (op === '*') {
        if (left.unit && right.unit) return null;
        left = { n: left.n * right.n, unit: left.unit || right.unit };
      } else {
        if (right.unit || right.n === 0) return null;
        left = { n: left.n / right.n, unit: left.unit };
      }
    }
    return left;
  };
  const sum = (): Quantity | null => {
    let left = product();
    while (left && (peek() === '+' || peek() === '-' || /^[+-]\d/.test(peek() ?? ''))) {
      const t = tokens[pos];
      let sign = 1;
      if (t === '+' || t === '-') {
        sign = t === '-' ? -1 : 1;
        pos++;
      } else {
        // a signed number token right after a term (`1px -1px` is invalid CSS without spaces around the operator): not provable
        return null;
      }
      const right = product();
      if (!right || right.unit !== left.unit) return null;
      left = { n: left.n + sign * right.n, unit: left.unit };
    }
    return left;
  };
  const v = sum();
  return v && pos === tokens.length ? v : null;
}

/** True only when the width is provably greater than zero: a keyword, a positive length, or a calc() the evaluator can prove. */
function widthProvenPositive(width: string): boolean {
  const w = width.trim().toLowerCase();
  if (w === 'thin' || w === 'medium' || w === 'thick') return true;
  const calc = /^calc\((.*)\)$/s.exec(w);
  const q = calc ? evalCalc(calc[1]!) : evalCalc(w);
  return q !== null && q.n > 0;
}

/** Why an outline draws nothing, or null when it is a visible system-colour outline. */
export function outlineProblem(o: Outline): string | null {
  if (o.style === 'none' || o.style === 'hidden') return `style ${o.style}`;
  if (!widthProvenPositive(o.width)) return `width ${o.width}`;
  if (!/^(?:Highlight|CanvasText)$/i.test(o.color)) return `colour ${o.color}`;
  return null;
}

interface Rule { selector: string; body: string }

/** Every `<selector> { ... }` rule inside the `@media ... (forced-colors: active) ...` blocks of a stylesheet, in order. The query is
 * matched by regex: no space after the colon, and `screen and (...)` forms count too (T-772 S2g). */
export function forcedColorsRules(css: string): Rule[] {
  const rules: Rule[] = [];
  const open = /@media[^{}]*\(\s*forced-colors\s*:\s*active\s*\)[^{}]*\{/g;
  for (let m = open.exec(css); m; m = open.exec(css)) {
    let depth = 1;
    let i = open.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    const media = css.slice(open.lastIndex, i - 1);
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    for (let r = rule.exec(media); r; r = rule.exec(media)) rules.push({ selector: r[1]!.trim(), body: r[2]! });
  }
  return rules;
}

const FC_SELECTOR = ':focus-visible:not([data-focus-container])';

/** Splits at the commas that are not inside parentheses or brackets. */
function topLevelParts(selector: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of selector) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && sep.test(ch)) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** One comma part targets only the marked containers when its subject (the last compound, after any descendant or child combinator)
 * names the marker outside `:not(`, and no `:is(`/`:where(` list in it mixes in another target. */
function containerOnly(part: string): boolean {
  const compounds = topLevelParts(part, /[\s>+~]/);
  const subject = (compounds[compounds.length - 1] ?? '').replace(/:not\((?:[^()]|\([^()]*\))*\)/g, '');
  if (!/\[data-focus-container\]/.test(subject)) return false;
  return !/:(?:is|where)\([^)]*,/.test(subject);
}

/** The bodies that decide the ring of a focusable control: the generic rule first, then EVERY other `:focus-visible` rule (a narrower
 * `button:focus-visible { outline-style: none }` removes the ring from its target). A rule whose every comma part targets only the
 * marked containers (they keep no ring on purpose) is skipped; one part that reaches another element counts. */
export function focusVisibleBodies(css: string): { generic: string[]; others: string[] } {
  const generic: string[] = [];
  const others: string[] = [];
  for (const { selector, body } of forcedColorsRules(css)) {
    if (selector === FC_SELECTOR) generic.push(body);
    else if (/:focus-visible/.test(selector) && !topLevelParts(selector, /,/).every(containerOnly)) others.push(body);
  }
  return { generic, others };
}

test('the effective outline reads shorthand then longhands in order', () => {
  const ok = 'outline: 2px solid Highlight; outline-offset: 2px;';
  assert.equal(outlineProblem(effectiveOutline(ok)), null);
  assert.equal(outlineProblem(effectiveOutline('outline: 2px solid CanvasText')), null);
  // the mutants: each draws nothing although the shorthand alone looks right
  assert.match(outlineProblem(effectiveOutline('outline: 2px solid Highlight; outline-color: transparent;'))!, /colour transparent/);
  assert.match(outlineProblem(effectiveOutline('outline: 2px solid Highlight; outline-width: 0;'))!, /width 0/);
  assert.match(outlineProblem(effectiveOutline('outline: 2px solid Highlight; outline-width: 0px !important;'))!, /width 0px/);
  assert.match(outlineProblem(effectiveOutline('outline: 2px solid Highlight; outline-style: none;'))!, /style none/);
  assert.match(outlineProblem(effectiveOutline('outline: 2px solid Highlight; outline: none;'))!, /style none/);
  assert.match(outlineProblem(effectiveOutline('outline: 2px solid Highlight; outline: 0;'))!, /style none/);
  // a longhand BEFORE the shorthand is reset by it, so it does not count
  assert.equal(outlineProblem(effectiveOutline('outline-width: 0; outline: 2px solid Highlight;')), null);
  // a later longhand that repairs an earlier break is fine
  assert.equal(outlineProblem(effectiveOutline('outline: none; outline-style: solid; outline-width: 2px; outline-color: Highlight;')), null);
  assert.match(outlineProblem(effectiveOutline('outline: 2px solid red;'))!, /colour red/);
  // the valid control stays green
  assert.equal(outlineProblem(effectiveOutline('outline: 2px dotted Highlight;')), null);
});

test('a calc() width counts only when it is proven above zero', () => {
  const base = 'outline: 2px solid Highlight;';
  for (const w of ['calc(0px)', 'calc(1px - 1px)', 'calc(2px * 0)', 'calc(0 * 5px)', 'calc(1px - 2px)', 'calc(var(--w))', 'calc(1px + 1em)', 'calc(2px / 0)', 'calc(']) {
    assert.match(outlineProblem(effectiveOutline(`${base} outline-width: ${w};`))!, /width calc/, w);
  }
  for (const w of ['calc(2px)', 'calc(1px + 1px)', 'calc(3px - 1px)', 'calc(1px * 2)', 'calc((1px + 1px) * 2)', 'calc(4px / 2)', 'thick', '2px']) {
    assert.equal(outlineProblem(effectiveOutline(`${base} outline-width: ${w};`)), null, w);
  }
});

test('!important follows the cascade, not the source order', () => {
  const base = 'outline: 2px solid Highlight;';
  // an earlier important declaration beats a later normal one
  assert.match(outlineProblem(effectiveOutline(`outline-style: none !important; ${base}`))!, /style none/);
  assert.match(outlineProblem(effectiveOutline(`outline: 0 !important; ${base}`))!, /style none/);
  assert.match(outlineProblem(effectiveOutline(`outline-width: 0px !important; ${base}`))!, /width 0px/);
  // an important declaration also beats a later normal one that would repair it, and a later important one wins again
  assert.match(outlineProblem(effectiveOutline(`${base} outline-color: red !important; outline-color: Highlight;`))!, /colour red/);
  assert.equal(outlineProblem(effectiveOutline(`outline-style: none !important; outline-style: solid !important; ${base}`)), null);
  // an important valid ring is not undone by a later normal break
  assert.equal(outlineProblem(effectiveOutline(`outline: 2px solid Highlight !important; outline-style: none;`)), null);
});

test('every :focus-visible rule of the forced-colors block counts, not only the generic selector', () => {
  const css = (extra: string): string =>
    `@media (forced-colors: active) {\n  ${FC_SELECTOR} {\n    outline: 2px solid Highlight;\n  }\n  ${extra}\n}`;
  const problem = (extra: string): string | null => {
    const { generic, others } = focusVisibleBodies(css(extra));
    return outlineProblem(effectiveOutline([...generic, ...others].join(';')));
  };
  assert.match(problem('button:focus-visible { outline-style: none }')!, /style none/);
  assert.match(problem('a:focus-visible, button:focus-visible { outline-width: calc(0px) }')!, /width calc/);
  assert.match(problem('input:focus-visible:not([data-focus-container]) { outline: none }')!, /style none/);
  assert.equal(problem('button:hover { outline-style: none }'), null);
  // a rule for the marked containers only is the documented exception
  assert.equal(problem('[data-focus-container]:focus-visible { outline: none }'), null);
  assert.equal(problem('button:focus-visible { outline-offset: 4px }'), null);
});

test('T-772 S2g: comma selectors and every forced-colors media query form are scanned; a rule missing its ring is caught', () => {
  const generic = `${FC_SELECTOR} {\n    outline: 2px solid Highlight;\n  }`;
  const problemIn = (css: string): string | null => {
    const { generic: g, others } = focusVisibleBodies(css);
    return outlineProblem(effectiveOutline([...g, ...others].join(';')));
  };
  const inMedia = (query: string, extra: string): string => `@media ${query} {\n  ${generic}\n  ${extra}\n}`;
  const bad = 'outline: none';
  // a container part in a comma list does not hide the control part (negative: each is caught)
  for (const sel of [
    `[data-focus-container]:focus-visible, button:focus-visible`,
    `[data-focus-container] button:focus-visible`,
    `:where(button, [data-focus-container]):focus-visible`,
    `a:focus-visible, button:focus-visible`,
  ]) {
    assert.match(problemIn(inMedia('(forced-colors: active)', `${sel} { ${bad} }`))!, /style none/, sel);
  }
  // positive controls: container-only lists stay the documented exception
  for (const sel of [
    `[data-focus-container]:focus-visible`,
    `[data-focus-container]:focus-visible, div[data-focus-container]:focus-visible`,
    `:is([data-focus-container]):focus-visible`,
  ]) {
    assert.equal(problemIn(inMedia('(forced-colors: active)', `${sel} { ${bad} }`)), null, sel);
  }
  // the media query is matched by regex: no space, and `screen and (...)` forms hold a rule that loses the ring
  for (const q of ['(forced-colors:active)', '(forced-colors: active)', 'screen and (forced-colors: active)', 'screen and (forced-colors:active) and (min-width: 1px)']) {
    assert.equal(forcedColorsRules(inMedia(q, 'button:focus-visible { outline: none }')).length, 2, q);
    assert.match(problemIn(inMedia(q, `button:focus-visible { ${bad} }`))!, /style none/, q);
  }
  // other media queries are not scanned
  assert.equal(forcedColorsRules(inMedia('(min-width:1px)', 'button:focus-visible { outline: none }')).length, 0);
});

test('index.css keeps a real outline for focusable controls under forced-colors', () => {
  const css = readFileSync(join(srcDir, 'index.css'), 'utf8');
  const { generic, others } = focusVisibleBodies(css);
  assert.ok(generic.length >= 1, 'the forced-colors rule for focusable controls is missing');
  // the effective outline (every declaration, in order, across every :focus-visible rule of the block): visible style, a width
  // proven above zero, a system colour
  const effective = effectiveOutline([...generic, ...others].join(';'));
  assert.equal(outlineProblem(effective), null, `the forced-colors outline draws nothing: ${JSON.stringify(effective)}`);
  // a transparent outline is not a system colour: forced-colors would repaint it, but the rule must name the colour itself
  assert.doesNotMatch(css, /:focus-visible:not\(\[data-focus-container\]\) \{[^}]*outline: [^;}]*transparent/);
  // the exclusion is the marker, never tabindex=-1 (a real control with tabindex=-1 keeps its ring)
  assert.doesNotMatch(css, /:focus-visible:not\(\[tabindex/);
});
