// T-736: the rtk measurement scripts (tools/qa/rtk-history.sh, rtk-classes.sh, rtk-measure.sh) rewrite the checkout they run in, so they
// share one guard (tools/qa/rtk-guard.sh): refuse outside a job-run Job (JR_REPO_URL) and unless `git status` succeeds and is clean.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDirectory } from '../store/testTmp.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCRIPTS = ['rtk-history.sh', 'rtk-classes.sh', 'rtk-measure.sh'] as const;
const FILES = [...SCRIPTS, 'rtk-guard.sh'];
const EDITED = 'export const a = 2; // uncommitted\n';

/** The argument list each script needs (the out folder is inside the scratch repo's parent, so a clean tree stays clean). */
const outOf = (dir: string) => join(dir, '..', `${dir.split('/').pop()}-out`);
function args(script: string, dir: string): string[] {
  return script === 'rtk-measure.sh' ? ['light', outOf(dir), dir, 'scratch'] : [outOf(dir)];
}

/** A scratch repo holding copies of the scripts and one committed .ts file (clean). */
function scratchRepo() {
  const dir = tempDirectory('rtk-guard-');
  const git = (...a: string[]) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q');
  mkdirSync(join(dir, 'tools/qa'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const f of FILES) copyFileSync(join(ROOT, 'tools/qa', f), join(dir, 'tools/qa', f));
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, git };
}

/** A stub rtk: records that it ran, then ends the calling script (its parent), so a run past the guard is short. */
function stubRtk(dir: string) {
  const bin = join(dir, '..', `${dir.split('/').pop()}-stub-rtk`);
  const sentinel = `${bin}.ran`;
  writeFileSync(bin, `#!/bin/sh\ntouch '${sentinel}'\nkill -TERM $PPID 2>/dev/null\nexit 0\n`, { mode: 0o755 });
  return { bin, sentinel };
}

/** A second, independent repo with a committed file under apps/server/src/chat (what rtk-measure.sh light claudepilot rewrites). */
function otherRepo() {
  const dir = tempDirectory('rtk-guard-other-');
  const git = (...a: string[]) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q');
  mkdirSync(join(dir, 'apps/server/src/chat'), { recursive: true });
  writeFileSync(join(dir, 'apps/server/src/chat/a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, git, file: join(dir, 'apps/server/src/chat/a.ts') };
}

function run(dir: string, script: string, opts: { marker: boolean; rtk?: string; cwd?: string; args?: string[] }) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: dir,
    RTK_BIN: opts.rtk ?? '/nonexistent/rtk',
    GIT_CEILING_DIRECTORIES: dirname(dir), // never find a repository above the scratch folder
  };
  if (opts.marker) env.JR_REPO_URL = 'https://example.invalid/repo.git';
  return spawnSync('bash', [join(dir, 'tools/qa', script), ...(opts.args ?? args(script, dir))], { cwd: opts.cwd ?? dir, env, encoding: 'utf8', timeout: 60_000 });
}

for (const script of SCRIPTS) {
  test(`${script}: without the Job marker it refuses, even on a clean tree`, () => {
    const { dir, git } = scratchRepo();
    const r = run(dir, script, { marker: false });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /refusing.*JR_REPO_URL/);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: with the marker but an uncommitted edit it refuses and touches nothing`, () => {
    const { dir, git } = scratchRepo();
    writeFileSync(join(dir, 'src/a.ts'), EDITED);
    const before = git('status', '--porcelain');
    const r = run(dir, script, { marker: true });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /uncommitted/);
    assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), EDITED);
    assert.equal(git('status', '--porcelain'), before);
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: a staged-only change refuses`, () => {
    const { dir, git } = scratchRepo();
    writeFileSync(join(dir, 'src/a.ts'), EDITED);
    git('add', 'src/a.ts');
    const r = run(dir, script, { marker: true });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /uncommitted/);
    assert.equal(git('diff', '--cached', '--name-only').trim(), 'src/a.ts');
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: an untracked-only file refuses`, () => {
    const { dir } = scratchRepo();
    writeFileSync(join(dir, 'new.txt'), 'x\n');
    const r = run(dir, script, { marker: true });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /uncommitted/);
    assert.equal(readFileSync(join(dir, 'new.txt'), 'utf8'), 'x\n');
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: when git status fails (no repository) it refuses and writes nothing`, () => {
    const { dir } = scratchRepo();
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    const r = run(dir, script, { marker: true });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /git status failed/);
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: run with the cwd OUTSIDE its tree (a clean other repo), a dirty own tree still refuses`, () => {
    const { dir } = scratchRepo();
    writeFileSync(join(dir, 'src/a.ts'), EDITED);
    const clean = otherRepo(); // git status in the cwd would read clean
    const r = run(dir, script, { marker: true, cwd: clean.dir });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /uncommitted/);
    assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), EDITED);
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: a missing guard file refuses (fail closed), nothing is written`, () => {
    const { dir, git } = scratchRepo();
    rmSync(join(dir, 'tools/qa/rtk-guard.sh'));
    git('add', '-A');
    git('commit', '-q', '-m', 'no guard');
    const r = run(dir, script, { marker: true });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot load/);
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: a guard file that does not define rtk_guard refuses`, () => {
    const { dir, git } = scratchRepo();
    writeFileSync(join(dir, 'tools/qa/rtk-guard.sh'), '# empty\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'empty guard');
    const r = run(dir, script, { marker: true });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /rtk_guard is not defined/);
    assert.equal(existsSync(outOf(dir)), false);
  });

  test(`${script}: marker set and clean tree gets past the guard (the stub rtk runs)`, () => {
    const { dir } = scratchRepo();
    const { bin, sentinel } = stubRtk(dir);
    const r = run(dir, script, { marker: true, rtk: bin });
    assert.doesNotMatch(r.stderr, /refusing/, r.stderr);
    assert.equal(existsSync(sentinel), true, `the stub never ran: ${r.stdout}${r.stderr}`);
    assert.equal(existsSync(outOf(dir)), true);
  });
}

/** rtk-measure.sh light <out> <other repo> claudepilot resets the OTHER repo, so that one is guarded too. */
const lightArgs = (dir: string, other: string) => ['light', outOf(dir), other, 'claudepilot'];

test('rtk-measure.sh light claudepilot: a dirty OTHER repo refuses, its edit survives, no out folder', () => {
  const { dir } = scratchRepo(); // clean own repo
  const o = otherRepo();
  writeFileSync(o.file, EDITED);
  const { bin } = stubRtk(dir);
  const r = run(dir, 'rtk-measure.sh', { marker: true, rtk: bin, args: lightArgs(dir, o.dir) });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /uncommitted/);
  assert.equal(readFileSync(o.file, 'utf8'), EDITED);
  assert.equal(existsSync(outOf(dir)), false);
});

test('rtk-measure.sh light claudepilot: a dirty OTHER repo refuses with the cwd outside both repos', () => {
  const { dir } = scratchRepo();
  const o = otherRepo();
  const elsewhere = otherRepo(); // a clean repo as the cwd: a status in the cwd would read clean
  writeFileSync(o.file, EDITED);
  const { bin } = stubRtk(dir);
  const r = run(dir, 'rtk-measure.sh', { marker: true, rtk: bin, cwd: elsewhere.dir, args: lightArgs(dir, o.dir) });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /uncommitted/);
  assert.equal(readFileSync(o.file, 'utf8'), EDITED);
  assert.equal(existsSync(outOf(dir)), false);
});

test('rtk-measure.sh light claudepilot: a clean other repo gets past the guard (the stub rtk runs)', () => {
  const { dir } = scratchRepo();
  const o = otherRepo();
  const { bin, sentinel } = stubRtk(dir);
  const r = run(dir, 'rtk-measure.sh', { marker: true, rtk: bin, args: lightArgs(dir, o.dir) });
  assert.doesNotMatch(r.stderr, /refusing/, r.stderr);
  assert.equal(existsSync(sentinel), true, `the stub never ran: ${r.stdout}${r.stderr}`);
});

test('every curl in the three scripts has --max-time and --retry', () => {
  for (const script of SCRIPTS) {
    const curls = readFileSync(join(ROOT, 'tools/qa', script), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('#') && /\bcurl\b/.test(l));
    assert.ok(curls.length >= 1, `${script} has no curl line (the check would test nothing)`);
    for (const l of curls) {
      assert.match(l, /--max-time \d+/, `${script}: ${l}`);
      assert.match(l, /--retry \d+/, `${script}: ${l}`);
    }
  }
});

/**
 * T-736 S3f (QA BE 2 8198, QA Perf, decision 8200): an ALLOW-list, not a list of writers. Before the guard (and, in rtk-measure.sh's heavy
 * branch, before the guarded cd) a line may only be: a comment or a blank, `set -u`, an assignment of ONE shell word with no command substitution,
 * no redirect and no chaining, `:` , `m <args>` (the measuring helper; heavy branch only) and, in the preamble, the exact lines that find the
 * folder, source the guard and check that it defined rtk_guard. Everything else is refused, so perl -pi, eval, find -delete, `2>`, `&>`, `<<<`,
 * a function or a tool called through a variable, backticks, `x=1 cmd`, `x=$(cmd)` and loops all fail without being named.
 */
const DANGER = /\$\(|`|[<>;&|]/;
const HERE_FORM = 'here=$(cd "$(dirname "$0")/../.." && pwd)';
const GUARD_SRC = /^\. "\$here\/tools\/qa\/rtk-guard\.sh" \|\| \{ echo "[^"$`]*" >&2; exit 2; \}$/;
const DECLARE = /^declare -F rtk_guard >\/dev\/null \|\| \{ echo "[^"$`]*" >&2; exit 2; \}$/;
/** True when `s` is ONE shell word (whitespace only inside quotes), so `x=1 touch f` is not an assignment. */
function oneWord(s: string): boolean {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (q) { if (c === q) q = ''; else if (q === '"' && c === '\\') i++; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '"' || c === "'") q = c; else if (/\s/.test(c)) return false;
  }
  return q === '';
}
function allowed(line: string, where: 'preamble' | 'branch'): boolean {
  const t = line.trim();
  if (t === '' || t.startsWith('#')) return true;
  if (t.endsWith('\\')) return false; // a continued line: the next line would be part of this command
  if (where === 'preamble' && (t === HERE_FORM || GUARD_SRC.test(t) || DECLARE.test(t))) return true;
  if (DANGER.test(t)) return false;
  if (/^set -[eu]+$/.test(t) || /^:(\s|$)/.test(t)) return true;
  if (where === 'branch' && /^m\s/.test(t)) return true;
  const a = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(t);
  return a !== null && oneWord(a[1] ?? '');
}
const GUARD_CALL = /^rtk_guard rtk-[a-z]+\.sh "\$here"$/;

test('the three scripts source the shared guard before they write anything: every line before it is on the allow-list', () => {
  for (const script of SCRIPTS) {
    const lines = readFileSync(join(ROOT, 'tools/qa', script), 'utf8').split('\n');
    const guard = lines.findIndex((l) => GUARD_CALL.test(l));
    assert.ok(guard > 0, `${script} does not call rtk_guard at the top level`);
    const bad = lines.slice(0, guard).findIndex((l) => !allowed(l, 'preamble'));
    assert.equal(bad, -1, `${script}: line ${bad + 1} comes before the guard and is not on the allow-list: ${lines[bad]}`);
    assert.ok(lines.slice(0, guard).some((l) => GUARD_SRC.test(l.trim())), `${script}: the guard is not sourced before it is called`);
    assert.ok(lines.slice(0, guard).some((l) => DECLARE.test(l.trim())), `${script}: rtk_guard is not checked to be defined before it is called`);
  }
});

test('the allow-list (self-check): the preamble forms pass; each way to write, run a tool or hide a command before the guard is refused', () => {
  for (const ok of ['', '# note', 'set -u', 'set -eu', HERE_FORM, '. "$here/tools/qa/rtk-guard.sh" || { echo "x: refusing: cannot load" >&2; exit 2; }',
    'declare -F rtk_guard >/dev/null || { echo "x: refusing: nope" >&2; exit 2; }', 'x=1', 'y="a b $z"', ': ', ':']) {
    assert.ok(allowed(ok, 'preamble'), `allowed: ${ok}`);
  }
  assert.ok(allowed('m a b c', 'branch') && !allowed('m a b c', 'preamble'), 'm is the heavy branch helper only');
  assert.ok(!allowed(HERE_FORM, 'branch'), 'the folder line is a preamble form only');
  for (const bad of ['mkdir -p "$out"', 'perl -pi -e s/a/b/ f', 'eval "touch f"', 'find . -delete', ': 2> f', 'echo x &> f', ': > f', 'cat <<< x', '$fn a', '"$R" x',
    'x=`touch f`', 'x=$(touch f)', 'x=1 touch f', 'x=1; touch f', 'x=1 && touch f', 'x="a" | tee f', 'while true; do :; done', 'until false; do :; done', 'for i in 1; do :; done',
    'touch f', 'g reset --hard', 'git checkout -- .', 'sed -i s/a/b/ f', 'x=a\\', '. other.sh', 'declare -F rtk_guard >/dev/null || { touch f; exit 2; }',
    '. "$here/tools/qa/rtk-guard.sh" || { touch f; exit 2; }']) {
    assert.ok(!allowed(bad, 'preamble'), `refused: ${bad}`);
    assert.ok(!allowed(bad, 'branch'), `refused in the branch too: ${bad}`);
  }
});

test('each script cds into the guarded folder after the guard and before its first git call (what the rtk-guard.sh header says)', () => {
  for (const script of SCRIPTS) {
    const lines = readFileSync(join(ROOT, 'tools/qa', script), 'utf8').split('\n');
    const at = (i: number) => lines[i] ?? ''; // noUncheckedIndexedAccess: an index is string | undefined
    const code = (i: number) => !at(i).trimStart().startsWith('#');
    const guard = lines.findIndex((l, i) => code(i) && /rtk_guard rtk-/.test(l));
    // `git <cmd>` and the scripts' own helper `g <cmd>` (git with a scratch identity).
    const gitCall = /(\bgit|(^|[\s;&|(])g) (-c |ls-files|rev-|remote|fetch|status|reset|checkout|rm |mv |add |commit)/;
    const cds = lines.map((l, i) => i).filter((i) => code(i) && /\bcd "\$(here|repo)"/.test(at(i)));
    const gits = lines.map((l, i) => i).filter((i) => code(i) && gitCall.test(at(i)));
    assert.ok(guard >= 0 && cds.length > 0 && cds.every((i) => i > guard), `${script}: no cd into the guarded folder after the guard`);
    assert.ok(gits.length > 0, `${script}: no git call found (the check would test nothing)`);
    for (const g of gits) {
      assert.ok(cds.some((c) => c < g), `${script}: a git call (line ${g + 1}) comes before the cd (line ${(cds[0] ?? -1) + 1})`);
    }
    // The cd must run: a plain statement, nothing like `[ x ] && cd` or `a || cd` in front of it on its line.
    for (const c of cds) {
      const before = at(c).slice(0, at(c).search(/\bcd "\$(here|repo)"/));
      assert.doesNotMatch(before, /&&|\|\|/, `${script}: the cd on line ${c + 1} may not run (a && or || in front of it)`);
      assert.match(at(c), /\bcd "\$(here|repo)" \|\| exit\b/, `${script}: the cd on line ${c + 1} needs \`|| exit\` (SC2164): a failed cd must not run the rest elsewhere`);
    }
  }
});

/**
 * The TOP-LEVEL `else ... fi` of a script (the heavy mode of rtk-measure.sh: the else of the first `if` that is not inside anything), walked once
 * with a stack of what is open (if, loop, case, `{` group or function body, `(` subshell; keywords counted only in command position, strings and
 * `$( )` removed, heredoc bodies skipped, `<<<` is not a heredoc). It returns the else line, its fi, the first line that is NOT on the allow-list
 * (`bad`) and the first PLAIN `cd "$here" || exit` that sits at the else branch's own level: the stack there is exactly the else's `if`, so a cd in
 * a nested if / loop / case, a `( )` subshell (also over several lines), a function body or a `cond && if ...; then` block does not count (it may
 * never run, or runs elsewhere). T-736 S3e (QA BE 2 8130) and S3f (8198, decision 8200).
 */
type Open = 'if' | 'loop' | 'case' | 'brace' | 'paren';
function tokens(line: string): string[] {
  let s = line.replace(/\\./g, ' ').replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
  for (let n = 0; n < 8 && /\$\([^()]*\)/.test(s); n++) s = s.replace(/\$\([^()]*\)/g, ' '); // $( ) and $(( ))
  s = s.replace(/(^|\s)#.*$/, ' ');
  return s.match(/&&|\|\||;;|[;|&(){}]|[^\s;|&(){}]+/g) ?? [];
}
/** Walks `lines` from the top; calls `visit(i, stackBeforeTheLine, isCode)` for every line (heredoc bodies and blanks get isCode false). */
function walk(lines: string[], visit: (i: number, stack: Open[], code: boolean, elseTop: boolean) => void) {
  const stack: Open[] = [];
  let tag = '', dash = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (tag) { if ((dash ? l.replace(/^\t+/, '') : l) === tag) tag = ''; visit(i, [...stack], false, false); continue; }
    if (l.trim() === '' || l.trimStart().startsWith('#')) { visit(i, [...stack], false, false); continue; }
    const before = [...stack];
    const t = tokens(l);
    let cmd = true, elseTop = false;
    for (let k = 0; k < t.length; k++) {
      const w = t[k] ?? '';
      if ([';', '&&', '||', '|', '&', ';;'].includes(w)) { cmd = true; continue; }
      if (w === '!') continue;
      if (w === '(') {
        if (t[k + 1] === ')') { k++; cmd = true; continue; } // `name()`: a function head, its `{` follows
        stack.push('paren'); cmd = true; continue;
      }
      if (w === ')') { if (stack[stack.length - 1] === 'paren') { stack.pop(); cmd = false; } else cmd = true; continue; } // otherwise a case pattern: a command follows
      if (w === '{') { if (cmd) { stack.push('brace'); cmd = true; } continue; }
      if (w === '}') { if (cmd && stack[stack.length - 1] === 'brace') stack.pop(); cmd = false; continue; }
      if (cmd && ['if', 'while', 'until', 'for', 'select', 'case'].includes(w)) { stack.push(w === 'if' ? 'if' : w === 'case' ? 'case' : 'loop'); cmd = w === 'if' || w === 'while' || w === 'until'; continue; }
      if (cmd && ['then', 'do', 'elif'].includes(w)) { cmd = true; continue; }
      if (cmd && w === 'else') { if (stack.length === 1 && stack[0] === 'if') elseTop = true; cmd = true; continue; }
      if (cmd && ['fi', 'done', 'esac'].includes(w)) { stack.pop(); cmd = false; continue; }
      cmd = false;
    }
    const h = /(?:^|[^<])<<(-?)\s*(['"]?)(\w+)\2/.exec(l); // `<<<` (a here-string) is not a heredoc
    if (h) { tag = h[3] ?? ''; dash = h[1] === '-'; }
    visit(i, before, true, elseTop);
  }
}
function heavyBranch(src: string) {
  const lines = src.split('\n');
  let start = -1, end = -1, bad = -1, cd = -1;
  walk(lines, (i, stack, code, elseTop) => {
    if (start < 0) { if (elseTop) start = i; return; }
    if (end >= 0 || !code) return;
    if (stack.length === 1 && stack[0] === 'if' && /^\s*fi\s*$/.test(lines[i] ?? '')) { end = i; return; }
    // `|| exit`: a cd without it is not counted (SC2164). The cd line is the one line of the branch that is not "allowed" on purpose.
    const plainCd = /^\s*cd "\$here" \|\| exit\s*$/.test(lines[i] ?? '');
    if (plainCd) { if (cd < 0 && stack.length === 1 && stack[0] === 'if') cd = i; return; }
    if (bad < 0 && !allowed(lines[i] ?? '', 'branch')) bad = i;
  });
  return { start, end, bad, cd };
}

test('rtk-measure.sh heavy mode (the top-level else branch) cds into the guarded folder before any line that is not on the allow-list (a cd of the light branch, or one in a nested block, subshell or function, does not count)', () => {
  const lines = readFileSync(join(ROOT, 'tools/qa/rtk-measure.sh'), 'utf8').split('\n');
  const b = heavyBranch(lines.join('\n'));
  assert.ok(b.start >= 0 && b.end > b.start, 'rtk-measure.sh has no top-level else ... fi block (the check would test nothing)');
  assert.ok(b.bad > 0, 'every line of the else branch is allowed (the check would test nothing)');
  assert.ok(b.cd > 0, 'the else branch has no plain `cd "$here" || exit` statement at its own nesting level');
  assert.ok(b.cd < b.bad, `the else branch runs something (line ${b.bad + 1}: ${lines[b.bad]}) before its cd (line ${b.cd + 1})`);
});

test('the heavy-branch walker (self-check): anything off the allow-list before the cd is seen, a cd that may not run is not one, the walk starts at the top-level else', () => {
  const wrap = (body: string) => `if x; then\n  y\nelse\n${body.replaceAll('cd "$here"', 'cd "$here" || exit')}\nfi\n`;
  const branch = (body: string) => heavyBranch(wrap(body));
  const lastFi = (body: string) => wrap(body).split('\n').length - 2;
  assert.equal(heavyBranch('if x; then\n  y\nelse\n  cd "$here"\n  touch f\nfi\n').cd, -1, 'a cd without `|| exit` is not counted (SC2164)');
  const ok = branch('  cd "$here"\n  cat > f <<\'EOT\'\ntouch inside-heredoc\nEOT\n  m a b c d e');
  assert.ok(ok.cd > 0 && ok.cd < ok.bad, 'a clean branch passes');
  assert.equal(ok.bad, 4, 'the heredoc body is skipped: the cat line is the first line off the list');
  const early = branch('  : \n  x=1\n  m a b c d e\n  cd "$here"\n  touch f');
  assert.ok(early.cd > 0 && early.cd < early.bad, 'assignments, `:` and m may come before the cd');
  for (const w of ['touch f', 'sed -i s/a/b/ f', 'echo hi | tee f', 'mv a b', 'ln -s a b', 'node x.js', 'npx tsc', ': > f', 'echo x >> f', 'cp a b', 'git status', 'g add f', 'rm -f f', 'mkdir d',
    'perl -pi -e s/a/b/ f', 'eval "touch f"', 'find . -delete', ': 2> f', 'echo x &> f', 'echo x 2>&1', '$fn a', '"$R" x', 'x=`touch f`', 'x=$(touch f)', 'x=1 touch f',
    'while true; do :; done', 'until true; do :; done', 'for i in 1; do :; done', 'cat <<< x', 'if true; then :; fi', 'm a b > f', 'm a b; touch f']) {
    const b = branch(`  ${w}\n  cd "$here"`);
    assert.ok(b.bad === 3 && b.cd === 4, `${w}: off the list before the cd (bad ${b.bad}, cd ${b.cd})`);
  }
  for (const nested of ['if false; then\n  cd "$here"\nfi', 'for i in 1; do\n  cd "$here"\ndone', 'while read l; do\n  cd "$here"\ndone', 'until false; do\n  cd "$here"\ndone',
    'case x in\n  y) true;;\nesac\nif false; then\n  cd "$here"\nfi', 'case x in\n  y) if z; then\n  cd "$here"\nfi;;\nesac', '(\n  cd "$here"\n)', 'f() {\n  cd "$here"\n}', '{\n  cd "$here"\n}',
    '[ x ] && if y; then\n  cd "$here"\nfi', 'x || while y; do\n  cd "$here"\ndone', 'f()\n{\n  cd "$here"\n}']) {
    const b = branch(`${nested}\n  touch f`);
    assert.equal(b.cd, -1, `a cd that may not run does not count: ${nested}`);
    assert.equal(b.end, lastFi(`${nested}\n  touch f`), `the nested closer does not end the else branch: ${nested}`);
  }
  assert.ok(branch('if y; then\n  true\nfi\n  cd "$here"').cd > 0, 'after a nested block closes, a cd at the branch level counts again');
  assert.ok(branch('  cd "$here"\n  cat <<< x\n  true').end === lastFi('  cd "$here"\n  cat <<< x\n  true'), 'a here-string (<<<) is not a heredoc: it does not swallow the fi');
  assert.ok(branch('  cd "$here"\n  cat <<-EOT\n\tfi\n\tEOT\n  true').end === lastFi('  cd "$here"\n  cat <<-EOT\n\tfi\n\tEOT\n  true'), '<<- skips its body, tab-indented end tag included');
  // The walk starts at the top-level else: a bare else of a nested if (column 0) is not the heavy branch.
  const nestedElse = heavyBranch('if a; then\n  if b; then\n    x\nelse\n  cd "$here" || exit\n  fi\nelse\n  y\nfi\n');
  assert.deepEqual([nestedElse.start, nestedElse.cd, nestedElse.end], [6, -1, 8], 'start at the top-level else; the cd of the nested else is not the heavy branch\'s');
  assert.equal(heavyBranch('if a; then\n  if b; then\n    x\n  else\n    y\n  fi\nfi\n').start, -1, 'only a nested else: no heavy branch');
  assert.equal(heavyBranch('if x; then\n  y\nfi\n').start, -1, 'no else: no heavy branch');
});

test('the helper regex of the order test sees `g <cmd>` and the chained cd (self-check)', () => {
  const gitCall = /(\bgit|(^|[\s;&|(])g) (-c |ls-files|rev-|remote|fetch|status|reset|checkout|rm |mv |add |commit)/;
  assert.ok(gitCall.test('  g commit -q -m x'));
  assert.ok(gitCall.test('a && g add f'));
  assert.ok(gitCall.test('git status'));
  assert.ok(!gitCall.test('# e.g. nothing'));
});

/** rtk-guard-mutants.sh in a scratch repo, with a git stub (first on PATH) that fails one subcommand and passes the rest to the real git. */
function runMutants(failing: 'status' | 'diff', code: number) {
  const { dir, git } = scratchRepo();
  copyFileSync(join(ROOT, 'tools/qa/rtk-guard-mutants.sh'), join(dir, 'tools/qa/rtk-guard-mutants.sh'));
  git('add', '-A');
  git('commit', '-q', '-m', 'mutants');
  const stubDir = join(dir, '..', `${dir.split('/').pop()}-stub-git`);
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = ${failing} ] && exit ${code}; done\nPATH="$REAL_PATH" exec git "$@"\n`, { mode: 0o755 });
  const env = { PATH: `${stubDir}:${process.env.PATH ?? ''}`, REAL_PATH: process.env.PATH ?? '', HOME: dir, JR_REPO_URL: 'https://example.invalid/repo.git', GIT_CEILING_DIRECTORIES: dirname(dir) };
  const r = spawnSync('bash', [join(dir, 'tools/qa/rtk-guard-mutants.sh')], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
  return { r, dir, git };
}

test('rtk-guard-mutants.sh: when git status fails it refuses (exit 2), edits nothing and runs no mutant', () => {
  const { r, dir, git } = runMutants('status', 128);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /git status failed/);
  assert.doesNotMatch(r.stdout, /MUTANT/);
  assert.equal(git('status', '--porcelain'), '');
  assert.match(readFileSync(join(dir, 'tools/qa/rtk-guard.sh'), 'utf8'), /JR_REPO_URL/);
});

test('rtk-guard-mutants.sh: when git diff fails after a mutant edit it restores tools, refuses (exit 2) and runs no test', () => {
  const { r, dir, git } = runMutants('diff', 129);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /git diff failed/);
  assert.doesNotMatch(r.stdout, /CAUGHT|SURVIVED/);
  assert.equal(git('status', '--porcelain'), '');
  assert.match(readFileSync(join(dir, 'tools/qa/rtk-guard.sh'), 'utf8'), /JR_REPO_URL/);
});

test('rtk-classes.sh on a repo without docs/prd: no pathspec error on stderr', () => {
  const { dir } = scratchRepo();
  // An rtk that answers --version and declines every rewrite, so the script runs on to the end instead of stopping at the first call.
  const bin = join(dir, '..', `${dir.split('/').pop()}-plain-rtk`);
  writeFileSync(bin, '#!/bin/sh\n[ "$1" = --version ] && echo rtk-stub\nexit 1\n', { mode: 0o755 });
  const r = run(dir, 'rtk-classes.sh', { marker: true, rtk: bin });
  assert.doesNotMatch(r.stderr, /pathspec/, r.stderr);
  assert.ok(existsSync(join(outOf(dir), 'tools.tsv')), `the script did not get past its set-up: ${r.stderr}`);
});
