#!/usr/bin/env node
// Check a CI workflow step's shell IN ITS CONTEXT before pushing it (owner request 2026-10-31, harness). A quoting bug in a nested '...'
// broke a stg deploy: the line was only tried outside the workflow. Works on GitHub, Gitea and pilot (.pilot/*.yml) workflows: jobs.<id>.steps[].run.
//
//   node scripts/ci-step-check.mjs <workflow.yml> [job] [step] [--run] [--env K=V]... [--expr 'secrets.X=value']... [--stub name[=output]]...
//                                  [--nested-cmd <regex>] [--list]
//
// job: a job id or name (default: every job). step: a step name (exact, else a case-insensitive substring) or its 1-based index (default: every
// step with a run block). For each step:
//   1. the run block with every ${{ expr }} replaced (--expr gives a value; otherwise a placeholder __expr_words__) is checked with `bash -n`
//      (`sh -n` for shell: sh; other shells are skipped);
//   2. every single-quoted string passed as a script to a helper (after -c; to bash, sh, ssh, eval, chroot, docker, kubectl, su, nsenter;
//      to any *.sh; or to a command matching --nested-cmd) is checked with `bash -n` too, recursively;
//   3. a single-quoted string glued to unquoted text inside one word ('a 'b' c') is reported: an inner ' closed the string early. Write '\''
//      for a quote inside a single-quoted string, or use a heredoc.
//   4. --run executes the block with bash -eo pipefail in an empty temp folder, PATH led by stub commands: --stub ssh makes `ssh` print its
//      argv to the log and exit 0 (=output prints that instead); --stub scripts/x.sh puts the stub at that path in the temp folder, so
//      `bash scripts/x.sh '...'` shows what x.sh would receive. --env K=V sets the environment (nothing else is inherited but PATH).
// --list prints the jobs and steps. Exit 0 when every check passes, 1 on a problem, 2 on a usage error.
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** js-yaml from the root node_modules of this checkout, else of the main checkout (a fresh worktree has none). */
function loadYaml() {
  const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const roots = [here];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: here,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    roots.push(dirname(common));
  } catch {
    /* not a git checkout */
  }
  for (const root of roots) {
    try {
      return createRequire(join(root, 'package.json'))('js-yaml');
    } catch {
      /* try the next */
    }
  }
  throw new Error('js-yaml not found (npm ci in the main checkout)');
}

const HELPERS = new Set(['bash', 'sh', 'ssh', 'eval', 'chroot', 'docker', 'kubectl', 'su', 'nsenter', 'podman']);
const PREFIX = new Set(['sudo', 'exec', 'env', 'command', 'time', 'nohup']);

/**
 * A small shell lexer: the simple commands of a script, each a list of words, and each word as its parts
 * ({ q: 'single' | 'double' | 'plain', text }). Heredoc bodies and comments are skipped. Enough to find the strings handed to helpers.
 */
export function lex(src) {
  const commands = [];
  let words = [];
  let parts = null;
  let pending = []; // heredoc delimiters waiting for the end of the line
  const endWord = () => {
    if (parts) words.push(parts);
    parts = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  const add = (q, text) => {
    parts ??= [];
    const last = parts.at(-1);
    if (last && last.q === q && q === 'plain') last.text += text;
    else parts.push({ q, text });
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      add('single', src.slice(i + 1, end));
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length && '"\\$`\n'.includes(src[j + 1])) {
          if (src[j + 1] !== '\n') text += src[j + 1];
          j += 2;
        } else text += src[j++];
      }
      add('double', text);
      i = j + 1;
    } else if (c === '\\') {
      if (src[i + 1] === '\n') i += 2;
      else {
        add('plain', src[i + 1] ?? '');
        i += 2;
      }
    } else if (c === '#' && !parts) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '\n') {
      endCommand();
      i++;
      for (const d of pending) {
        // skip the heredoc body up to its delimiter line
        while (i < src.length) {
          const nl = src.indexOf('\n', i);
          const line = src.slice(i, nl < 0 ? src.length : nl);
          i = nl < 0 ? src.length : nl + 1;
          if (line.replace(/^\t+/, '') === d) break;
        }
      }
      pending = [];
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      endWord();
      const m = /^<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/.exec(src.slice(i));
      if (m) {
        pending.push(m[2]);
        i += m[0].length;
      } else i += 2;
    } else if (';&|()'.includes(c)) {
      endCommand();
      i++;
    } else if (c === ' ' || c === '\t') {
      endWord();
      i++;
    } else {
      add('plain', c);
      i++;
    }
  }
  endCommand();
  return commands;
}

const value = (word) => word.map((p) => p.text).join('');

/**
 * The scripts handed to helpers in single quotes, and the broken single-quoted strings, in one script.
 * Returns { nested: [{ cmd, script }], broken: [{ cmd, word }] }.
 */
export function findNested(src, extra) {
  const nested = [];
  const broken = [];
  for (const cmd of lex(src)) {
    const vals = cmd.map(value);
    let k = 0;
    while (k < vals.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(vals[k]) || PREFIX.has(vals[k]))) k++;
    const head = vals[k] ?? '';
    const name = head.split('/').pop();
    const isHelper = (idx) =>
      HELPERS.has(name) || vals.slice(k, idx).some((v) => /\.sh$/.test(v)) || (extra && extra.test(head)) || vals[idx - 1] === '-c';
    cmd.forEach((word, idx) => {
      if (idx <= k || !word.some((p) => p.q === 'single')) return;
      const line = vals.join(' ');
      // An inner ' closed the string: single-quoted text glued to plain text that is not the '\'' idiom.
      const glued = word.some((p, n) => p.q === 'plain' && p.text !== "'" && word[n - 1]?.q === 'single');
      if (glued && isHelper(idx)) broken.push({ cmd: line, word: vals[idx] });
      if (isHelper(idx) && !vals[idx].startsWith('-') && /[\s;|&$]/.test(vals[idx]))
        nested.push({ cmd: line, head: vals.slice(0, idx).join(' '), script: vals[idx] });
    });
  }
  return { nested, broken };
}

function syntax(shell, script) {
  const r = spawnSync(shell, ['-n'], { input: script, encoding: 'utf8' });
  return r.status === 0 ? null : (r.stderr || `exit ${r.status}`).trim().replace(/^(bash|sh): /gm, '');
}

export function substitute(run, exprs) {
  return run.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, e) => (e in exprs ? exprs[e] : `__${e.replace(/\W+/g, '_')}__`));
}

/** Check one script and what it hands to helpers, depth first. Returns the problems. */
export function checkScript(script, { shell = 'bash', extra, label = 'run', depth = 0 } = {}) {
  const problems = [];
  const err = syntax(shell, script);
  if (err) problems.push(`${label}: ${shell} -n: ${err}`);
  if (depth > 4) return problems;
  const { nested, broken } = findNested(script, extra);
  for (const b of broken)
    problems.push(
      `${label}: a single-quoted string is closed early by an inner ' in: ${b.cmd.slice(0, 160)} (the helper gets "${b.word.slice(0, 80)}"; write '\\'' or use a heredoc)`,
    );
  nested.forEach((n, idx) => {
    problems.push(
      ...checkScript(n.script, { shell: 'bash', extra, label: `${label} > nested ${idx + 1} (${n.head.slice(0, 60)})`, depth: depth + 1 }),
    );
  });
  return problems;
}

function stubText(name, output) {
  return `#!/usr/bin/env bash\n{ printf 'stub %s:' ${JSON.stringify(name)}; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'; } >> "$CI_STEP_STUB_LOG"\n${output === undefined ? '' : `printf '%s\\n' ${shellQuote(output)}\n`}exit 0\n`;
}
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function runStep(script, { env = {}, stubs = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-step-'));
  try {
    const bin = join(dir, '.stubs');
    const work = join(dir, 'work');
    mkdirSync(bin);
    mkdirSync(work);
    const log = join(dir, 'stub.log');
    writeFileSync(log, '');
    for (const s of stubs) {
      const eq = s.indexOf('=');
      const name = eq < 0 ? s : s.slice(0, eq);
      const out = eq < 0 ? undefined : s.slice(eq + 1);
      const at = name.includes('/') ? join(work, name) : join(bin, name);
      if (!resolve(at).startsWith(dir)) throw new Error(`stub ${name} leaves the temp folder`);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, stubText(name, out));
      chmodSync(at, 0o755);
    }
    const file = join(dir, 'step.sh');
    writeFileSync(file, script);
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
      cwd: work,
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: work, CI_STEP_STUB_LOG: log, ...env },
      timeout: 60_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: readFileSync(log, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const o = { pos: [], env: {}, exprs: {}, stubs: [], run: false, list: false, extra: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const kv = () => {
      const v = argv[++i] ?? '';
      const eq = v.indexOf('=');
      if (eq < 1) throw new Error(`${a} K=V`);
      return [v.slice(0, eq), v.slice(eq + 1)];
    };
    if (a === '--run') o.run = true;
    else if (a === '--list') o.list = true;
    else if (a === '--env') {
      const [k, v] = kv();
      o.env[k] = v;
    } else if (a === '--expr') {
      const [k, v] = kv();
      o.exprs[k] = v;
    } else if (a === '--stub') o.stubs.push(argv[++i] ?? '');
    else if (a === '--nested-cmd') o.extra = new RegExp(argv[++i] ?? '');
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.pos.push(a);
  }
  return o;
}

function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`ci-step-check: ${e.message}\n`);
    return 2;
  }
  const [file, jobSel, stepSel] = o.pos;
  if (!file) {
    process.stderr.write(
      'usage: ci-step-check.mjs <workflow.yml> [job] [step] [--run] [--env K=V] [--expr k=v] [--stub name[=out]] [--list]\n',
    );
    return 2;
  }
  let doc;
  try {
    doc = loadYaml().load(readFileSync(file, 'utf8'));
  } catch (e) {
    process.stderr.write(`ci-step-check: ${file}: ${e.message}\n`);
    return 2;
  }
  const jobs = Object.entries(doc?.jobs ?? {}).filter(([id, j]) => !jobSel || id === jobSel || j?.name === jobSel);
  if (!jobs.length) {
    process.stderr.write(`ci-step-check: no job ${jobSel ?? ''} in ${file} (jobs: ${Object.keys(doc?.jobs ?? {}).join(', ')})\n`);
    return 2;
  }
  const picked = [];
  for (const [id, job] of jobs) {
    const steps = (job?.steps ?? []).map((s, n) => ({ ...s, n: n + 1 }));
    let sel = steps;
    if (stepSel) {
      sel = /^\d+$/.test(stepSel) ? steps.filter((s) => s.n === Number(stepSel)) : steps.filter((s) => s.name === stepSel);
      if (!sel.length && !/^\d+$/.test(stepSel))
        sel = steps.filter((s) =>
          String(s.name ?? '')
            .toLowerCase()
            .includes(stepSel.toLowerCase()),
        );
    }
    for (const s of sel) picked.push({ id, job, s });
  }
  if (o.list) {
    for (const { id, s } of picked) process.stdout.write(`${id} #${s.n} ${s.name ?? '(unnamed)'}${s.run ? '' : ' (no run)'}\n`);
    return 0;
  }
  const runs = picked.filter((p) => typeof p.s.run === 'string');
  if (!runs.length) {
    process.stderr.write(`ci-step-check: no step with a run block matches ${stepSel ?? ''}\n`);
    return 2;
  }
  let bad = 0;
  for (const { id, job, s } of runs) {
    const label = `${id} #${s.n} ${s.name ?? '(unnamed)'}`;
    const shell = String(s.shell ?? job?.defaults?.run?.shell ?? doc?.defaults?.run?.shell ?? 'bash').split(/\s/)[0];
    const script = substitute(s.run, o.exprs);
    if (!['bash', 'sh'].includes(shell)) {
      process.stdout.write(`skip ${label}: shell ${shell}\n`);
      continue;
    }
    const problems = checkScript(script, { shell, extra: o.extra, label });
    const { nested } = findNested(script, o.extra);
    if (problems.length) {
      bad++;
      for (const p of problems) process.stdout.write(`problem: ${p}\n`);
    } else process.stdout.write(`ok   ${label}: ${shell} -n clean, ${nested.length} nested script(s) clean\n`);
    if (o.run) {
      const r = runStep(script, { env: o.env, stubs: o.stubs });
      process.stdout.write(`run  ${label}: exit ${r.status}\n`);
      if (r.calls) process.stdout.write(r.calls.replace(/^/gm, '  '));
      if (r.stdout) process.stdout.write(`  stdout:\n${r.stdout.replace(/^/gm, '    ')}`);
      if (r.stderr) process.stdout.write(`  stderr:\n${r.stderr.replace(/^/gm, '    ')}`);
      if (r.status !== 0) bad++;
    }
  }
  return bad ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
