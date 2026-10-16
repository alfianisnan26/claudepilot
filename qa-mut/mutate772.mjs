// QA mutation helper (T-772 S2e, fc9158ed): changes ONE thing in apps/web/src/index.css. Run from apps/web.
// Fails (rc 1) when the text to change is not found exactly once.
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/index.css';
const SEL = ':focus-visible:not([data-focus-container])';
const HEAD = '@media (forced-colors: active) {\n  ' + SEL + ' {\n';
const SHORT = '    outline: 2px solid Highlight;\n';
const FULL = HEAD + SHORT + '    outline-offset: 2px;\n';
const after = (extra) => [FULL, FULL + extra];
const M = {
  // the three of the brief: appended after the shorthand
  M1: after('    outline-color: transparent;\n'),
  M2: after('    outline-width: 0;\n'),
  M3: after('    outline-style: none;\n'),
  // my own
  colorred: [FULL, HEAD + '    outline: 2px solid red;\n    outline-offset: 2px;\n'],
  shortzero: [FULL, HEAD + '    outline: 0 solid Highlight;\n    outline-offset: 2px;\n'],
  zerofloat: after('    outline-width: 0.0em;\n'),
  upper: after('    OUTLINE-STYLE: NONE;\n'),
  hidden: after('    outline-style: hidden;\n'),
  colorvar: after('    outline-color: var(--ring);\n'),
  canvas: after('    outline-color: Canvas;\n'),
  // a second forced-colors block at the end of the file breaks the outline (cross-rule order): the file ends with a newline
  block2: ['\n@media (forced-colors: active) {\n  ' + SEL + ' {\n    outline-style: none;\n  }\n}\n', null],
  // the rule leaves forced-colors
  media: [HEAD, '@media (forced-colors: none) {\n  ' + SEL + ' {\n'],
  // the zero width hidden in a calc: the width test does not see a zero here
  calczero: after('    outline-width: calc(0px);\n'),
  // a visible alternative style is fine: a CONTROL, expected to stay green
  dotted: [FULL, HEAD + '    outline: 2px dotted Highlight;\n    outline-offset: 2px;\n'],
  // a narrower selector with a broken outline: the test reads only the exact selector
  sel2: [HEAD, '@media (forced-colors: active) {\n  button:focus-visible { outline-style: none; }\n  ' + SEL + ' {\n'],
};
const name = process.argv[2];
if (!M[name]) { console.error('unknown mutant', name); process.exit(1); }
const [from, to] = M[name];
const src = readFileSync(file, 'utf8');
if (to === null) {
  // append mode
  writeFileSync(file, src.replace(/\n*$/, '\n') + from);
  console.log(`mutant ${name} applied (appended)`);
} else {
  const n = src.split(from).length - 1;
  if (n !== 1) { console.error(`mutant ${name}: the text to change was found ${n} times (need 1)`); process.exit(1); }
  writeFileSync(file, src.replace(from, () => to));
  console.log(`mutant ${name} applied`);
}
