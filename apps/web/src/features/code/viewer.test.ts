import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { highlightTree } from '@lezer/highlight';
import { languageFor, LANGUAGE_LABEL, type CodeLanguage } from './language';
import { loadLanguage } from './languages';
import { codePointLabel, ESCAPE_MARK, highlightStyle, SPECIAL_CHARS, viewerExtensions } from './setup';

test('language: from the name first, then the media type, else plain text', () => {
  const cases: [string, string | undefined, CodeLanguage][] = [
    ['image-build-job.yaml', 'text/plain', 'yaml'],
    ['deploy/k3s/portal.YML', undefined, 'yaml'],
    ['package.json', undefined, 'json'],
    ['a.mjs', undefined, 'javascript'],
    ['App.tsx', undefined, 'tsx'],
    ['x.ts', undefined, 'typescript'],
    ['main.py', undefined, 'python'],
    ['gate.sh', undefined, 'shell'],
    ['.env.local', undefined, 'shell'],
    ['Dockerfile', undefined, 'dockerfile'],
    ['Dockerfile.web', undefined, 'dockerfile'],
    ['Cargo.toml', undefined, 'toml'],
    ['fix.patch', undefined, 'diff'],
    ['schema.sql', undefined, 'sql'],
    ['README.md', undefined, 'markdown'],
    ['index.html', undefined, 'html'],
    ['site.css', undefined, 'css'],
    ['noext', 'application/json; charset=utf-8', 'json'],
    ['noext', 'text/x-yaml', 'yaml'],
    ['notes.txt', 'text/plain', 'plain'],
    ['weird.unknownext', undefined, 'plain'],
    // Names that are properties of every object are not languages.
    ['constructor', undefined, 'plain'],
    ['x.constructor', 'toString', 'plain'],
  ];
  for (const [name, media, want] of cases) assert.equal(languageFor(name, media), want, `${name} ${media ?? ''}`);
  for (const id of Object.keys(LANGUAGE_LABEL)) assert.ok(LANGUAGE_LABEL[id as CodeLanguage].length > 0);
});

const viewerState = (doc: string) => EditorState.create({ doc, extensions: viewerExtensions() });

test('read-only: no edit from the user changes the text (a key, a paste, a drop, a cut, a drag)', () => {
  const doc = 'apiVersion: batch/v1\nkind: Job\n';
  const state = viewerState(doc);
  assert.equal(state.readOnly, true);
  assert.equal(state.facet(EditorView.editable), false);
  for (const userEvent of ['input.type', 'input.paste', 'input.drop', 'delete.backward', 'delete.cut', 'move.drop']) {
    const after = state.update({ changes: { from: 0, to: 3, insert: 'pwned' }, userEvent }).state;
    assert.equal(after.doc.toString(), doc, userEvent);
  }
});

const FIXTURES: Record<Exclude<CodeLanguage, 'plain'>, string> = {
  yaml: 'apiVersion: batch/v1\nkind: Job # a comment\nspec:\n  backoffLimit: 0\n  image: "registry/x:1"\n',
  json: '{\n  "name": "x",\n  "n": 1,\n  "ok": true,\n  "v": null\n}\n',
  javascript: 'const a = 1; // c\nexport function f(x) { return `t${x}`; }\n',
  jsx: 'const A = () => <div className="a">{1}</div>;\n',
  typescript: 'interface A { b: number }\nconst x: A = { b: 2 };\n',
  tsx: 'export const B = ({ n }: { n: number }) => <span>{n}</span>;\n',
  python: 'def f(x):\n    # c\n    return "s" + str(1)\n',
  shell: '#!/bin/sh\nset -eu\necho "$HOME" --flag # c\n',
  sql: "SELECT id, name FROM t WHERE n > 1 AND s = 'x';\n",
  markdown: '# Title\n\nSome *em* and `code`.\n',
  html: '<!doctype html>\n<p class="a">x &amp; y<script>alert(1)</script></p>\n',
  css: '.a { color: red; margin: 0 4px; }\n',
  dockerfile: 'FROM node:22\nRUN npm ci\nCMD ["node", "a.js"]\n',
  toml: '[package]\nname = "x"\nversion = 1\n',
  diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
};

test('every language loads, colours its fixture, and the coloured runs cover the text in order', async () => {
  for (const [id, text] of Object.entries(FIXTURES) as [Exclude<CodeLanguage, 'plain'>, string][]) {
    const lang = await loadLanguage(id);
    assert.ok(lang, id);
    const runs: [number, number, string][] = [];
    highlightTree(lang.parser.parse(text), highlightStyle, (from, to, cls) => runs.push([from, to, cls]));
    assert.ok(runs.length > 0, `${id}: nothing coloured`);
    // Joined, the uncoloured gaps and the coloured runs are the text: in order, inside it, never overlapping.
    let pos = 0;
    let joined = '';
    for (const [from, to] of runs) {
      assert.ok(from >= pos && to > from && to <= text.length, `${id}: run ${from}-${to} after ${pos}`);
      joined += text.slice(pos, from) + text.slice(from, to);
      pos = to;
    }
    joined += text.slice(pos);
    assert.equal(joined, text, id);
    // The document the view draws is the text, whole.
    assert.equal(viewerState(text).doc.toString(), text, id);
  }
  assert.equal(await loadLanguage('plain'), null);
});

test('redaction and escapes survive as given: a secret placeholder and an escaped bidi override stay in the text, marked', () => {
  const text = 'token: [redacted]\nname: abc⟦U+202E⟧def\n';
  assert.equal(viewerState(text).doc.toString(), text);
  assert.deepEqual([...text.matchAll(ESCAPE_MARK)].map((m) => m[0]), ['⟦U+202E⟧']);
});

test('disguising characters that reach the viewer raw are drawn as a marked placeholder; tabs and ordinary text are not', () => {
  for (const c of ['\u202E', '\u2066', '\u200B', '\uFEFF', '\u0000', '\u001B', '\u00AD', '\uFE0F']) assert.ok(SPECIAL_CHARS.test(c), codePointLabel(c.codePointAt(0)!));
  for (const c of ['\t', '\n', 'a', 'é', '😀', ' ']) assert.ok(!SPECIAL_CHARS.test(c), JSON.stringify(c));
  assert.equal(codePointLabel(0x202e), 'U+202E');
  assert.equal(codePointLabel(0xa), 'U+000A');
});
