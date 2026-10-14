// scripts/plan-step.mjs (T-292 slice 3): the plan step's deterministic part. The explorer writes a file manifest; the script checks it
// against a fixture repository built here and writes the brief head with the files preloaded. Negative twins: every rule the check has
// refuses a manifest that breaks it. The E2 arms' heads and the lab spec are checked against the lab's own parsers (classify.ts).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAB_STRATUM_KEYS } from '@portal/contracts';
import { drawOf, ticketOf } from '../lab/classify.js';
import { tempDirectory } from '../store/testTmp.js';

const SCRIPT = fileURLToPath(new URL('../../../../scripts/plan-step.mjs', import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p: any = await import(SCRIPT);

function fixture() {
  const root = tempDirectory('cp-plan-');
  mkdirSync(join(root, 'src/lab'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'src/lab/a.ts'), Array.from({ length: 40 }, (_, i) => `export const a${i + 1} = ${i + 1};`).join('\n') + '\n');
  writeFileSync(join(root, 'src/lab/a.test.ts'), "import './a.js';\n");
  writeFileSync(join(root, 'docs/notes.md'), '# Notes\n\n````md\n```ts\nx\n```\n````\n');
  writeFileSync(join(root, 'src/lab/big.ts'), Array.from({ length: 900 }, (_, i) => `// ${i}`).join('\n') + '\n');
  writeFileSync(join(root, '.env'), 'NAME=value\n');
  writeFileSync(join(root, 'src/lab/bin.dat'), Buffer.from([1, 0, 2]));
  const outside = tempDirectory('cp-plan-out-');
  writeFileSync(join(outside, 'x.ts'), 'outside\n');
  symlinkSync(join(outside, 'x.ts'), join(root, 'src/lab/link.ts'));
  return root;
}

const GOOD = [
  'manifest T-9',
  'plan: change a3 and a4',
  'plan: add the test',
  'file: src/lab/a.ts:3-4 -- the two constants',
  'file: docs/notes.md -- a Markdown file with fences',
  'new: src/lab/b.ts -- the helper',
  'test: src/lab/a.test.ts -- proves it',
  'test: src/lab/b.test.ts -- new test',
  'new: src/lab/b.test.ts -- the new test file',
  'run: cd apps/server && npm test',
].join('\n');

test('a good manifest: checked, preloaded with the exact lines, and the head is the same bytes on every run', () => {
  const root = fixture();
  const m = p.parseManifest(GOOD);
  const c = p.checkManifest(m, { root, ticket: 'T-9' });
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.preload.map((f: { path: string; from: number; to: number; total: number }) => [f.path, f.from, f.to, f.total]), [['src/lab/a.ts', 3, 4, 40], ['docs/notes.md', 1, 7, 7]]);
  assert.equal(c.preload[0].text, 'export const a3 = 3;\nexport const a4 = 4;');
  const block = p.renderManifest(m, c);
  assert.ok(block.includes(p.RULE));
  assert.ok(block.includes('```ts\nexport const a3 = 3;\nexport const a4 = 4;\n```\n'));
  assert.ok(block.includes('`````md\n# Notes'), 'a fence longer than any backtick run in the file');

  const file = join(root, '..', 'good.manifest');
  writeFileSync(file, GOOD);
  const args = ['head', '--ticket', 'T-9', '--size', 'M', '--arm', 'treatment', '--draw', 'd-00112233aabb', '--manifest', file];
  const a = spawnSync(process.execPath, [SCRIPT, ...args, '--root', root], { encoding: 'utf8' });
  const b = spawnSync(process.execPath, [SCRIPT, ...args, '--root', root], { encoding: 'utf8' });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout, 'deterministic');
  assert.equal(a.stdout, p.briefHead({ ticket: 'T-9', size: 'M', arm: 'treatment', draw: 'd-00112233aabb', manifestBlock: block }));
  const ok = spawnSync(process.execPath, [SCRIPT, 'check', file, '--root', root], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /T-9 ok: 2 steps, 2 files \(9 lines, \d+ bytes preloaded\), 2 new, 2 tests/);
});

test('negative twins: each rule refuses a manifest that breaks it', () => {
  const root = fixture();
  const errs = (text: string, ticket = 'T-9') => p.checkManifest(p.parseManifest(text), { root, ticket }).errors.join('\n');
  const base = ['manifest T-9', 'plan: x', 'test: src/lab/a.test.ts -- t'];
  const w = (...extra: string[]) => [...base, ...extra].join('\n');
  assert.equal(errs(w()), '', 'the base is good');
  assert.match(errs(w('Sure! Here is the manifest:')), /line 4: not a manifest line/);
  assert.match(errs(w(), 'T-10'), /for T-9, not T-10/);
  assert.match(errs('plan: x\ntest: src/lab/a.test.ts -- t'), /no "manifest T-<n>" line/);
  assert.match(errs('manifest T-9\ntest: src/lab/a.test.ts -- t'), /no plan: line/);
  assert.match(errs('manifest T-9\nplan: x'), /no test: line/);
  assert.match(errs(w('file: src/lab/none.ts -- x')), /no such file/);
  assert.match(errs(w('file: src/lab/a.ts:30-41 -- x')), /lines 30-41 are not inside its 40 lines/);
  assert.match(errs(w('file: src/lab/a.ts:5-4 -- x')), /lines 5-4/);
  assert.match(errs(w('file: ../outside.ts -- x')), /not a path inside the repository/);
  assert.match(errs(w('file: /etc/hostname -- x')), /not a path inside the repository/);
  assert.match(errs(w('file: .env -- x')), /credential or git file/);
  assert.match(errs(w('file: .git/config -- x')), /credential or git file/);
  assert.match(errs(w('file: src/lab/link.ts -- x')), /leads out of the repository/);
  assert.match(errs(w('file: src/lab/bin.dat -- x')), /not a text file/);
  assert.match(errs(w('file: src/lab/big.ts -- x')), /900 preloaded lines, at most 800/);
  assert.match(errs(w('file: src/lab/a.ts:1-2 -- x', 'file: src/lab/a.ts:1-2 -- x')), /named twice/);
  assert.match(errs(w(...Array.from({ length: 11 }, (_, i) => `file: src/lab/a.ts:${i + 1}-${i + 1} -- x`))), /11 files, at most 10/);
  assert.match(errs(w(...Array.from({ length: 6 }, () => 'plan: y'))), /7 plan lines, at most 6/);
  assert.match(errs(w('run: a', 'run: b', 'run: c', 'run: d')), /4 run lines, at most 3/);
  assert.match(errs(w('test: src/lab/none.test.ts -- t')), /no such test file/);
  assert.match(errs(w('new: src/lab/a.ts -- x')), /exists already/);
  assert.match(errs(w('new: src/nope/x.ts -- x')), /its folder does not exist/);
  assert.match(errs(w(...Array.from({ length: 30 }, () => 'plan: y'))), /lines, at most 30/);
  assert.match(errs(w(`plan: ${'x'.repeat(301)}`)), /longer than 300 characters/);

  const bad = join(root, '..', 'bad.manifest');
  writeFileSync(bad, w('file: src/lab/none.ts -- x'));
  const r = spawnSync(process.execPath, [SCRIPT, 'check', bad, '--root', root], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'a bad manifest fails the step, it is never half used');
  assert.match(r.stderr, /plan-step: line 4 \(src\/lab\/none.ts\): no such file/);
  const h = spawnSync(process.execPath, [SCRIPT, 'head', '--ticket', 'T-9', '--size', 'M', '--arm', 'treatment', '--manifest', bad, '--root', root], { encoding: 'utf8' });
  assert.equal(h.status, 1);
  assert.equal(h.stdout, '', 'no head from a bad manifest');
});

test('the E2 arms: control is today\'s brief, treatment adds the pack and (M, L) the manifest; the lab reads the ticket and the draw', () => {
  const control = p.briefHead({ ticket: 'T-9', size: 'M', arm: 'control', draw: 'd-00112233aabb' });
  assert.equal(control, 'Ticket T-9, size M. Lab-Draw: d-00112233aabb\n');
  assert.ok(!control.includes(p.PACK));
  const small = p.briefHead({ ticket: 'T-9', size: 'S', arm: 'treatment' });
  assert.equal(small, `Ticket T-9, size S.\nRead ${p.PACK} first; read a file only when it does not answer.\n`, 'S has no plan step');
  assert.throws(() => p.briefHead({ ticket: 'T-9', size: 'L', arm: 'treatment' }), /needs --manifest/);
  assert.throws(() => p.briefHead({ ticket: 'T-9', size: 'M', arm: 'pack' }), /--arm control or treatment/);
  assert.throws(() => p.briefHead({ ticket: 'T-9', size: 'M', arm: 'control', draw: 'anything' }), /--draw/);
  assert.throws(() => p.briefHead({ ticket: 'T-9', size: 'XL', arm: 'control' }), /--size/);

  // The lab finds both in the Agent call's prompt even when a long preload follows (it reads the first 2,500 characters).
  const long = p.briefHead({ ticket: 'T-9', size: 'M', arm: 'treatment', draw: 'd-00112233aabb', manifestBlock: 'x'.repeat(50_000) });
  assert.equal(ticketOf({ prompt: long }), 'T-9');
  assert.equal(drawOf({ prompt: long }), 'd-00112233aabb');
  assert.equal(drawOf({ prompt: control }), 'd-00112233aabb');
  assert.equal(drawOf({ prompt: 'Ticket T-9. Lab-Draw: d-0011' }), null, 'only a whole draw key');
  assert.equal(drawOf({ prompt: `${'x'.repeat(2600)} Lab-Draw: d-00112233aabb` }), null, 'past the first 2,500 characters');

  assert.deepEqual([...p.E2.arms], [...p.ARMS]);
  assert.ok(p.E2.strata.every((k: string) => (LAB_STRATUM_KEYS as readonly string[]).includes(k)));
  assert.deepEqual([p.E2.design, p.E2.min_n, p.E2.primary_metric], ['randomized', 30, 'median cost per accepted slice']);
  const e2 = spawnSync(process.execPath, [SCRIPT, 'e2'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(e2.stdout), JSON.parse(JSON.stringify(p.E2)));
});

test('the explorer brief: none for S, for M and L the pack, the ticket and the manifest form', () => {
  assert.equal(p.explorerBrief({ ticket: 'T-9', size: 'S' }), null);
  const b = p.explorerBrief({ ticket: 'T-9', size: 'L', slice: 'item 3' });
  assert.ok(b.startsWith(`Plan step for T-9 (size L). Read ${p.PACK} first`));
  for (const k of ['manifest T-9', 'plan:', 'file:', 'new:', 'test:', 'run:', 'The slice: item 3']) assert.ok(b.includes(k), k);
  assert.throws(() => p.explorerBrief({ ticket: '9', size: 'M' }), /--ticket/);
  const s = spawnSync(process.execPath, [SCRIPT, 'explorer', '--ticket', 'T-9', '--size', 'S'], { encoding: 'utf8' });
  assert.equal(s.stdout, 'skip: a size S slice has no plan step\n');
  assert.equal(spawnSync(process.execPath, [SCRIPT, 'nothing'], { encoding: 'utf8' }).status, 2);
});
