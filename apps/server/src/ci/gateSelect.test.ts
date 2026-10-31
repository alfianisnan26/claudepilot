// The change-scoped release gate's selector (scripts/gate-select.mjs, D-106) on small repositories in a temporary folder: the import graph
// walk, a reference from a test to a script, the walkers, shared core and unknown bases running the whole gate, documents reusing a green
// result, and a broken file in a non-core place still reaching the test that imports it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SELECT = join(REPO, 'scripts/gate-select.mjs');
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', FULL: '' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** The base tree: a server with an import chain x <- y <- y.test, an unrelated z.test, a web file, a script a test reads, documents. */
const BASE: Record<string, string> = {
  'apps/server/src/a/x.ts': 'export const x = 1;\n',
  'apps/server/src/a/y.ts': "import { x } from './x.js';\nexport const y = x + 1;\n",
  'apps/server/src/a/y.test.ts': "import { test } from 'node:test';\nimport { y } from './y.js';\ntest('y', () => { if (y !== 2) throw new Error('y'); });\n",
  'apps/server/src/b/z.ts': 'export const z = 3;\n',
  'apps/server/src/b/z.test.ts': "import { z } from './z.js';\n// docs/guide.md says why: a comment names nothing\nconsole.log(z);\n",
  'apps/server/src/c/run.test.ts': "import { readFileSync } from 'node:fs';\nconst REPO = new URL('../../../../', import.meta.url);\nreadFileSync(new URL('scripts/tool.sh', REPO));\nreadFileSync(new URL('docs/read-me-by-test.md', REPO));\n",
  'apps/server/src/store/db.ts': 'export const db = 1;\n',
  'apps/web/src/App.tsx': 'export const App = () => null;\n',
  'scripts/tool.sh': '#!/usr/bin/env bash\necho tool\n',
  'docs/guide.md': '# guide\n',
  'docs/read-me-by-test.md': '# read by a test\n',
  'README.md': '# readme\n',
};

function repo(files: Record<string, string> = BASE) {
  const root = mkdtempSync(join(tmpdir(), 'gate-select-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  write(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  const commit = (changes: Record<string, string | null>) => {
    for (const [f, text] of Object.entries(changes)) {
      if (text === null) rmSync(join(root, f));
      else write(root, { [f]: text });
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'change');
    return git(root, 'rev-parse', 'HEAD');
  };
  return { root, base, commit };
}

function write(root: string, files: Record<string, string>) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
}

interface Plan {
  mode: string;
  reason: string;
  base: string;
  reused: string;
  steps: string[];
  files: string[];
  web: boolean;
  changed: string[];
}
function select(root: string, args: string[], records = ''): Plan {
  const rec = join(root, '..', `${root.split('/').pop()}.records`);
  writeFileSync(rec, records);
  const r = spawnSync('node', [SELECT, '--repo', root, '--format', 'json', '--records', rec, ...args], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as Plan;
}
const at = () => new Date().toISOString();

test('the import graph: a change runs the tests that import it, directly or through other files, and not the others', () => {
  const r = repo();
  const head = r.commit({ 'apps/server/src/a/x.ts': 'export const x = 2;\n' });
  const p = select(r.root, ['--head', head, '--base', r.base]);
  assert.equal(p.mode, 'scoped', p.reason);
  assert.deepEqual(p.files, ['src/a/y.test.ts'], 'x <- y <- y.test; z.test and run.test do not reach x');
  assert.deepEqual(p.steps, ['typecheck', 'server-suite'], 'typecheck always; no web');
  assert.equal(p.web, false);
});

test('a broken file in a non-core place is still caught: the test that imports it is selected (and the change of the test itself too)', () => {
  const r = repo();
  const head = r.commit({ 'apps/server/src/b/z.ts': 'export const z: number = undefined as unknown as number; throw new Error("broken");\n' });
  assert.deepEqual(select(r.root, ['--head', head, '--base', r.base]).files, ['src/b/z.test.ts']);
  const head2 = r.commit({ 'apps/server/src/b/z.test.ts': "import { z } from './z.js';\nconsole.log(z + 1);\n" });
  assert.deepEqual(select(r.root, ['--head', head2, '--base', head]).files, ['src/b/z.test.ts'], 'a changed test runs');
});

test('references: a test that reads a script runs when the script changes; a web change runs the web build and tests', () => {
  const r = repo();
  const head = r.commit({ 'scripts/tool.sh': '#!/usr/bin/env bash\necho changed\n', 'apps/web/src/App.tsx': 'export const App = () => 1;\n' });
  const p = select(r.root, ['--head', head, '--base', r.base]);
  assert.equal(p.mode, 'scoped', p.reason);
  assert.deepEqual(p.files, ['src/c/run.test.ts']);
  assert.deepEqual(p.steps, ['typecheck', 'web-build', 'web-tests', 'server-suite']);
});

test('a test that walks the repository runs in every scoped gate', () => {
  const r = repo({ ...BASE, 'apps/server/src/qa/walk.test.ts': "import { readdirSync } from 'node:fs';\nreaddirSync(new URL('../../../../', import.meta.url));\n" });
  const head = r.commit({ 'apps/server/src/a/x.ts': 'export const x = 5;\n' });
  assert.deepEqual(select(r.root, ['--head', head, '--base', r.base]).files, ['src/a/y.test.ts', 'src/qa/walk.test.ts']);
});

test('shared core runs the whole gate: store, contracts, package files, tsconfig, the gate scripts', () => {
  for (const [file, text] of [
    ['apps/server/src/store/db.ts', 'export const db = 2;\n'],
    ['packages/contracts/src/index.ts', 'export {};\n'],
    ['package-lock.json', '{}\n'],
    ['apps/web/tsconfig.json', '{}\n'],
    ['scripts/gate.sh', '#!/usr/bin/env bash\n'],
    ['apps/server/src/app.ts', 'export {};\n'],
  ] as const) {
    const r = repo();
    const head = r.commit({ [file]: text });
    const p = select(r.root, ['--head', head, '--base', r.base]);
    assert.equal(p.mode, 'full', file);
    assert.match(p.reason, /shared core changed/, file);
    assert.deepEqual(p.steps, ['typecheck', 'web-build', 'web-tests', 'server-suite']);
  }
});

test('documents that nothing reads reuse a green result; a document a test reads, or any code, does not', () => {
  const r = repo();
  const docs = r.commit({ 'docs/guide.md': '# guide, longer\n', 'README.md': '# readme 2\n', 'docs/new.md': 'new\n' });
  const green = `${r.base} full ${at()}\n`;
  const p = select(r.root, ['--head', docs, '--base-ref', 'main'], green);
  assert.equal(p.mode, 'reuse', p.reason);
  assert.equal(p.reused, r.base);
  assert.deepEqual(p.steps, []);
  assert.deepEqual([...p.changed].sort(), ['README.md', 'docs/guide.md', 'docs/new.md'], 'the diff that justified it');

  const read = r.commit({ 'docs/read-me-by-test.md': '# changed\n' });
  const q = select(r.root, ['--head', read, '--base-ref', 'main'], green);
  assert.equal(q.mode, 'scoped', 'a test reads that document from the repository');
  assert.deepEqual(q.files, ['src/c/run.test.ts']);

  const code = r.commit({ 'apps/server/src/b/z.ts': 'export const z = 4;\n' });
  assert.notEqual(select(r.root, ['--head', code, '--base-ref', 'main'], `${docs} full ${at()}\n`).mode, 'reuse', 'code is never reused');
});

test('the base is the newest green record on the base ref; none known, an unknown base, or asked for: the whole gate', () => {
  const r = repo();
  const mid = r.commit({ 'apps/server/src/b/z.ts': 'export const z = 9;\n' });
  const head = r.commit({ 'apps/server/src/a/x.ts': 'export const x = 7;\n' });
  git(r.root, 'branch', '-f', 'released', mid);
  const p = select(r.root, ['--head', head, '--base-ref', 'released'], `${r.base} full ${at()}\n${mid} scoped ${at()}\n`);
  assert.equal(p.base, mid, 'the first green commit walking back from the base ref');
  assert.deepEqual(p.files, ['src/a/y.test.ts'], 'only what changed since that green commit');

  const none = select(r.root, ['--head', head, '--base-ref', 'released']);
  assert.equal(none.mode, 'full');
  assert.match(none.reason, /no green gated commit is known on released/);
  assert.equal(select(r.root, ['--head', head, '--base', 'f'.repeat(40)]).mode, 'full', 'a base that is not here');
  assert.equal(select(r.root, ['--head', head, '--base', r.base, '--full']).mode, 'full', '--full');
  const env = spawnSync('node', [SELECT, '--repo', r.root, '--head', head, '--base', r.base], { encoding: 'utf8', env: { ...GIT_ENV, FULL: '1' } });
  assert.match(env.stdout, /^MODE=full$/m, 'FULL=1');
  assert.match(env.stdout, /^REASON=asked for \(FULL\)$/m);
});

test('a change that reaches more than half of the server tests runs the whole suite; the env output is one KEY=value per line', () => {
  const r = repo();
  const head = r.commit({ 'apps/server/src/a/x.ts': 'export const x = 3;\n', 'apps/server/src/b/z.ts': 'export const z = 0;\n' });
  const p = select(r.root, ['--head', head, '--base', r.base]);
  assert.equal(p.mode, 'full', 'y.test and z.test are 2 of 3 test files');
  assert.match(p.reason, /reaches 2 of 3 server test files/);
  const env = spawnSync('node', [SELECT, '--repo', r.root, '--head', head, '--base', r.base], { encoding: 'utf8', env: GIT_ENV });
  assert.deepEqual(env.stdout.trim().split('\n').map((l) => l.split('=')[0]), ['MODE', 'REASON', 'BASE', 'REUSED', 'STEPS', 'FILES', 'CHANGED', 'SERVER_TESTS', 'SERVER_TOTAL', 'WEB']);
});

test('--reuse-only (the nightly): reuse when a full green result covers the tree, else none', () => {
  const r = repo();
  const docs = r.commit({ 'docs/guide.md': '# again\n' });
  assert.equal(select(r.root, ['--head', docs, '--reuse-only', '--kinds', 'full'], `${r.base} full ${at()}\n`).mode, 'reuse');
  assert.equal(select(r.root, ['--head', docs, '--reuse-only', '--kinds', 'full'], `${r.base} scoped ${at()}\n`).mode, 'none', 'a scoped result is not a full one');
});
