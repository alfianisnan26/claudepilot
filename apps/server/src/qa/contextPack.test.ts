// scripts/context-pack.sh (T-292): docs/context-pack.md is small, deterministic, names only paths that exist and carries nothing secret-shaped.
// The committed pack is read from the repository (no git needed, so it runs in the gate's clean copy); the generator runs for real on a
// fixture repository built here, with commit dates in 2020 so a window taken from the wall clock would find nothing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDirectory } from '../store/testTmp.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/context-pack.sh');
const CAP = 6000 * 4; // 6k tokens at chars/4

/** Secret shapes, assembled here so no literal in this file looks like one. */
const SECRET_SHAPES = [
  ['gh', '[pousr]_[A-Za-z0-9]{20,}'],
  ['github', '_pat_[A-Za-z0-9_]{20,}'],
  ['sk', '-ant-[A-Za-z0-9_-]{10,}'],
  ['AK', 'IA[0-9A-Z]{16}'],
  ['xo', 'x[abprs]-[A-Za-z0-9-]{10,}'],
  ['-----BEGIN [A-Z ]*PRIVATE', ' KEY'],
  ['ey', 'J[A-Za-z0-9_-]{10,}\\.eyJ'],
].map(([a, b]) => new RegExp(a! + b!));

/** Every backticked token with a slash that reads as a path (not a glob, placeholder, command or URL), braces expanded. */
function namedPaths(md: string): string[] {
  const out = new Set<string>();
  for (const m of md.matchAll(/`([^` ]*\/[^` ]*)`/g)) {
    const p = m[1]!;
    if (/[*<>()]|^\/|^https?:/.test(p)) continue;
    const brace = /^(.*)\{([^}]*)\}(.*)$/.exec(p);
    for (const alt of brace ? brace[2]!.split(',').map((a) => brace[1]! + a + brace[3]!) : [p]) out.add(alt);
  }
  return [...out].sort();
}

test('the committed pack: under 6k tokens, an anchor line, every path it names exists, nothing secret-shaped', () => {
  const md = readFileSync(join(ROOT, 'docs/context-pack.md'), 'utf8');
  assert.ok(Buffer.byteLength(md) <= CAP, `${Buffer.byteLength(md)} bytes`);
  assert.match(md.split('\n')[0]!, /^<!-- context-pack anchor [0-9a-f]{40} t=\d+ /);
  for (const h of ['## Map', '## Commands', '## Conventions', '## Where things live', '## Hot files', '## Lessons']) assert.ok(md.includes(`\n${h}\n`), h);
  const paths = namedPaths(md);
  assert.ok(paths.length > 30, `only ${paths.length} paths`);
  assert.deepEqual(paths.filter((p) => !existsSync(join(ROOT, p))), []);
  for (const re of SECRET_SHAPES) assert.doesNotMatch(md, re);
});

// The fixture repository.
const DAY = 86400;
const BASE = Date.UTC(2020, 0, 1) / 1000;
function fixture() {
  const dir = tempDirectory('cp-pack-');
  const home = join(dir, '.home');
  const repo = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const git = (args: string[], at?: number) => {
    const date = at === undefined ? {} : { GIT_AUTHOR_DATE: `@${at} +0000`, GIT_COMMITTER_DATE: `@${at} +0000` };
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...env, ...date } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const commit = (at: number, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) write(p, t);
    git(['add', '-A']);
    git(['commit', '-q', '--allow-empty', '-m', `at ${at}`], at);
  };
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync('bash', [SCRIPT, '--repo', repo, ...args], { cwd: repo, encoding: 'utf8', env: { ...env, ...extraEnv } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  git(['init', '-q', '-b', 'main']);
  const map = (rows: string[]) => `# X\n\n## Map\n\n| Where | What |\n| --- | --- |\n${rows.join('\n')}\n\n## Commands\n`;
  // Five commits 45 days before the anchor (outside the window), then the window: hot.ts three times, a.ts and b.ts twice each (a tie).
  for (let i = 0; i < 5; i++) commit(BASE + i, { 'src/old.ts': `// old ${i}\n` });
  commit(BASE + 20 * DAY, {
    'CLAUDE.md': map(['| `apps/server/src/chat` | sessions: the `chat` process |']),
    'scripts/a.sh': '#!/usr/bin/env bash\n# A does the a thing.\n',
    'tools/qa/x.mjs': '// x\n',
    'docs/dev-sessions/status/orchestrator.md': '# S\n\nLESSONS of this session: check the markers; never pkill your own pattern.\n',
  });
  for (let i = 0; i < 3; i++) commit(BASE + (30 + i) * DAY, { 'src/hot.ts': `// The hot one, round ${i}.\n` });
  for (let i = 0; i < 2; i++) commit(BASE + (40 + i) * DAY, { 'src/b.ts': `export const b${i} = 1;\n`, 'src/a.ts': `export function a${i}() {}\n` });
  commit(BASE + 45 * DAY, { 'README.md': '# R\n' });
  return { repo, git, write, commit, run, map };
}

test('the generator: deterministic, the window ends at the anchor commit (not the clock), ties by path, lessons split', () => {
  const f = fixture();
  const one = f.run(['--stdout', '--no-path-check']);
  const two = f.run(['--stdout', '--no-path-check'], { TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8' });
  assert.equal(one.code, 0, one.err);
  assert.equal(two.out, one.out);
  const hot = one.out.split('\n').filter((l) => l.startsWith('- `src/') || l.startsWith('- `README'));
  assert.deepEqual(hot, ['- `src/hot.ts` (3): The hot one, round 2.', '- `src/a.ts` (2): exports a1', '- `src/b.ts` (2): exports b1', '- `README.md` (1): R']);
  assert.ok(!one.out.includes('src/old.ts'), 'commits 45 days before the anchor are outside the window');
  assert.match(one.out, /\n- check the markers\n- never pkill your own pattern\n/);
  assert.match(one.out, /- `apps\/server\/src\/chat`: sessions: the chat process\. Test: `\(cd apps\/server && node --import tsx --test 'src\/chat\/\*\*\/\*\.test\.ts'\)`/);
  assert.match(one.out, /- `scripts\/a\.sh`: A does the a thing\./);
});

test('--check: fresh after a commit of the pack; stale when an input changes or the anchor is over 7 days old', () => {
  const f = fixture();
  assert.equal(f.run(['--no-path-check']).code, 0);
  f.commit(BASE + 45 * DAY + 3600, {});
  const fresh = f.run(['--check', '--no-path-check']);
  assert.equal(fresh.code, 0, fresh.err);
  assert.match(fresh.out, /^context-pack: fresh at /);
  // The gate Job's clone has depth 1: the anchor's history is not there, the history sections are taken as committed.
  const shallow = join(dirname(f.repo), 'shallow');
  assert.equal(spawnSync('git', ['clone', '-q', '--depth', '1', `file://${f.repo}`, shallow], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dirname(f.repo), GIT_CONFIG_NOSYSTEM: '1' } }).status, 0);
  const sh = spawnSync('bash', [SCRIPT, '--repo', shallow, '--check', '--no-path-check'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  assert.equal(sh.status, 0, sh.stderr);
  assert.match(sh.stdout, /history not checked: shallow/);

  f.commit(BASE + 46 * DAY, { 'CLAUDE.md': f.map(['| `apps/server/src/tickets` | tickets |']) });
  const stale = f.run(['--check', '--no-path-check']);
  assert.equal(stale.code, 1);
  assert.match(stale.err, /stale: docs\/context-pack\.md differs/);

  assert.equal(f.run(['--no-path-check']).code, 0);
  f.commit(BASE + 46 * DAY + 60, {});
  assert.equal(f.run(['--check', '--no-path-check']).code, 0);
  f.commit(BASE + 54 * DAY, { 'notes.txt': 'later\n' });
  const old = f.run(['--check', '--no-path-check']);
  assert.equal(old.code, 1);
  assert.match(old.err, /more than 7 days older/);
});

test('refuses: a path that does not exist, a pack over the cap, secret-shaped text in a source', () => {
  const f = fixture();
  const missing = f.run(['--stdout']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /paths named in the pack do not exist: .*apps\/server\/src\/chat/);

  const rows = Array.from({ length: 150 }, (_, i) => `| \`src/area${i}\` | ${'word '.repeat(45)} |`);
  f.commit(BASE + 46 * DAY, { 'CLAUDE.md': f.map(rows) });
  const big = f.run(['--stdout', '--no-path-check']);
  assert.equal(big.code, 1);
  assert.match(big.err, /over the cap of 24000/);

  const fake = 'gh' + 'p_' + 'Q7'.repeat(18);
  f.commit(BASE + 47 * DAY, { 'CLAUDE.md': f.map([]), 'docs/dev-sessions/status/orchestrator.md': `LESSONS: keep ${fake} out\n` });
  const secret = f.run(['--stdout', '--no-path-check']);
  assert.equal(secret.code, 1);
  assert.equal(secret.out, '');
  assert.match(secret.err, /secret-shaped text/);
  assert.ok(!secret.err.includes(fake));
});
