import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../delivery/compile.js';
import { renderEnvSh, shellQuote, type ShellVariable } from './render.js';

/** A small seeded PRNG (mulberry32), so a failure can be replayed from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Characters that break naive quoting, plus some that aren't ASCII. */
const NASTY = [..."'\"`$\\!*?[]{}()<>|&;#~%^=+,:@ \t", 'é', 'ß', '中', '文', '🔑', '‏', ' ', ' '];
const PAYLOADS = ["'; touch $MARK; '", '$(touch $MARK)', '`touch $MARK`', "'\"$(touch $MARK)\"'", '${MARK:?boom}', "\\'; touch $MARK #", "it's", "''", "'"];

function value(rand: () => number, max = 60): string {
  if (rand() < 0.15) return PAYLOADS[Math.floor(rand() * PAYLOADS.length)]!;
  let s = '';
  const n = Math.floor(rand() * max);
  for (let i = 0; i < n; i++) {
    const r = rand();
    s += r < 0.4 ? NASTY[Math.floor(rand() * NASTY.length)]! : String.fromCharCode(33 + Math.floor(rand() * 94));
  }
  return s;
}

const shells = ['bash', 'dash'].filter((sh) => {
  try {
    execFileSync(sh, ['-c', 'true']);
    return true;
  } catch {
    return false;
  }
});

test('fuzz: env.sh gives every shell back exactly the values, and never runs any of them', { skip: shells.length === 0 && 'no bash or dash here' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-envsh-'));
  try {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      const vars: ShellVariable[] = Array.from({ length: 25 }, (_, i) => ({ name: `V${seed}_${i}`, value: value(rand) }));
      const file = join(dir, `env-${seed}.sh`);
      writeFileSync(file, renderEnvSh(vars));
      const mark = join(dir, `ran-${seed}`);
      for (const sh of shells) {
        const out = execFileSync(sh, ['-c', `. ${shellQuote(file)}; printf '%s\\0' ${vars.map((v) => `"$${v.name}"`).join(' ')}`], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', MARK: mark } });
        const got = out.toString('utf8').split('\0').slice(0, -1);
        assert.deepEqual(got, vars.map((v) => ('value' in v ? v.value : '')), `${sh}, seed ${seed}`);
        assert.equal(existsSync(mark), false, `${sh} ran a value (seed ${seed})`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fuzz: an exposed secret is read from its file at shell start, never evaluated', { skip: shells.length === 0 && 'no bash or dash here' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-envsh-'));
  try {
    for (let seed = 100; seed < 130; seed++) {
      const rand = rng(seed);
      const secret = `${value(rand, 200)}\n${value(rand, 50)}`;
      const path = join(dir, `it's ${seed}`);
      writeFileSync(path, secret);
      const file = join(dir, `env-${seed}.sh`);
      writeFileSync(file, renderEnvSh([{ name: 'S', file: path }]));
      const mark = join(dir, `ran-${seed}`);
      for (const sh of shells) {
        const out = execFileSync(sh, ['-c', `. ${shellQuote(file)}; printf '%s' "$S"`], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', MARK: mark } });
        // Command substitution drops trailing newlines, as it does for any `$(cat …)`.
        assert.equal(out.toString('utf8'), secret.replace(/\n+$/, ''), `${sh}, seed ${seed}`);
        assert.equal(existsSync(mark), false);
      }
    }
    // A missing or unreadable file gives an empty variable and no noise.
    const file = join(dir, 'missing.sh');
    writeFileSync(file, renderEnvSh([{ name: 'S', file: join(dir, 'nope') }]));
    for (const sh of shells) assert.equal(execFileSync(sh, ['-c', `. ${shellQuote(file)}; printf '[%s]' "$S"`], { stdio: ['ignore', 'pipe', 'pipe'] }).toString(), '[]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fuzz: the drop-in carries every value exactly, and stays valid JSON', () => {
  for (let seed = 200; seed < 260; seed++) {
    const rand = rng(seed);
    const env = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`V${i}`, value(rand, 120)]));
    const bundle = compile({ portalId: 'p', generation: 1, claudeVersion: null, fragments: [{ owner: 'secrets', settings: { env } }] });
    const dropIn = bundle.files.find((f) => f.path.endsWith('20-claudepilot-env.json'))!;
    assert.deepEqual(JSON.parse(dropIn.content), { env }, `seed ${seed}`);
  }
});
