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

test('a data-focus-container marker sits only on an element with tabIndex={-1}, and the 8 containers are all marked', () => {
  const files = sourceFiles();
  assert.deepEqual(files.flatMap((f) => markerHits(f, lines(f))), []);
  const marked = files.filter((f) => lines(f).some((l) => MARKER.test(l)));
  assert.equal(marked.length, 8, `marked files: ${marked.join(', ')}`);
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

test('index.css keeps a real outline for focusable controls under forced-colors', () => {
  const css = readFileSync(join(srcDir, 'index.css'), 'utf8');
  assert.match(
    css,
    /@media \(forced-colors: active\) \{\s*:focus-visible:not\(\[data-focus-container\]\) \{[^}]*outline: [^;}]*solid[^;}]*;/,
  );
  // the exclusion is the marker, never tabindex=-1 (a real control with tabindex=-1 keeps its ring)
  assert.doesNotMatch(css, /:focus-visible:not\(\[tabindex/);
});
