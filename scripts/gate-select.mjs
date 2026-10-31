#!/usr/bin/env node
// The change-scoped release gate (D-106, owner 2026-10-31: "it shouldn't need a full suite like that, it wastes resources"): what the gate
// of one commit must run, from what changed since a GREEN gated commit. Plain node, no dependency (it runs in the workspace pod before any
// npm ci; D-61: the heavy part, the gate itself, stays a Job in the cluster). It reads git objects only, never the working tree.
//
//   node scripts/gate-select.mjs --head <rev> [--base <rev> | --base-ref <ref> --records <file>] [--full] [--kinds full,scoped,reuse]
//                                [--reuse-only] [--format env|json|text]
//
// Records (<file>, from scripts/gate-record.sh list): one green gated commit per line, `<commit40> <kind> <at>` (kind full, scoped or reuse).
// The decision, in this order:
//   1. FULL when asked (--full, or FULL=1 in the environment).
//   2. REUSE: a recorded green commit whose tree differs from the head's only in documents (docs/**, *.md) that no code or test reads
//      (no string literal names them): the head is green by that result; nothing runs but the context-pack check. Every record is tried.
//   3. The base: --base, or the first commit of `git rev-list <base-ref>` (main for the deploy gate) with a green record. None: FULL.
//   4. FULL when the change touches shared core (CORE below), when the import graph can not be built, or when it reaches more than half
//      of the server's test files.
//   5. SCOPED otherwise: typecheck always; web-build and web-tests when apps/web is reached; the server test files reached from the change
//      through the import graph (a test runs when it imports, directly or through other files, a changed file) and through references
//      (a string literal in code or a test, or the text of a script or manifest, that names a changed file: a test that reads
//      .pilot/scripts/check.sh runs when check.sh changes), plus every test that walks the repository's folders (it reads files no import
//      names). The context-pack check runs whatever the steps (scripts/gate.sh).
// --reuse-only stops after 2 (MODE=none when nothing can be reused): the nightly gate's "already fully gated" test.
// Output (--format env, the default): KEY=value lines (MODE, REASON, BASE, REUSED, STEPS, FILES, CHANGED, SERVER_TESTS, SERVER_TOTAL, WEB);
// the reasons, per file, go to stderr. Exit 0 with a plan, 2 on a usage error.
import { execFileSync, spawnSync } from 'node:child_process';
import { posix } from 'node:path';

const ALL_STEPS = ['typecheck', 'web-build', 'web-tests', 'server-suite'];

/** What everything depends on, and the gate itself: a change here runs the whole gate. */
export const CORE = [
  /^apps\/server\/src\/store\//,
  /^apps\/server\/src\/authz\//,
  /^apps\/server\/src\/(app|index|config)\.ts$/,
  /^apps\/server\/scripts\//, // the generators of the embedded runner and agents (*.generated.ts)
  /^packages\/contracts\//,
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^\.npmrc$/,
  /^scripts\/gate(-job|-verdict|-select|-record)?\.(sh|mjs)$/,
  /^deploy\/k3s-build\/gate-job\.yaml$/,
  /^\.pilot\/scripts\/(gate|nightly|lib)\.sh$/,
];

/** A document: never built, never executed. Reusable only when nothing reads it (see referrers). */
const isDoc = (p) => p.startsWith('docs/') || p.endsWith('.md');
const isServerTest = (p) => /^apps\/server\/src\/.+\.test\.ts$/.test(p);
const CODE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
/** Files whose text can name another file (scripts, manifests, pipelines, code). Documents and binaries are never referrers. */
const TEXT_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|sh|bash|ya?ml|json|html|css|toml|conf|env|py|Dockerfile)$|(^|\/)(Dockerfile|Makefile)[^/]*$|^\.pilot\//;
/** Tests that walk folders of the repository read files no import names: they run in every scoped gate. */
const WALKS = /\breaddirSync\b|\breaddir\(|\bglobSync\b|\bglob\(|\bopendir/;
const REPO_PATH = /import\.meta\.(url|dirname)|process\.cwd\(\)/;

function die(msg) {
  process.stderr.write(`gate-select: ${msg}\n`);
  process.exit(2);
}

function git(repo, args, opts = {}) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}
const exists = (repo, rev) => spawnSync('git', ['cat-file', '-e', `${rev}^{commit}`], { cwd: repo }).status === 0;

/** Every tracked file of a commit and, for the text ones, its content (one `git cat-file --batch`). */
export function readTree(repo, rev) {
  const rows = git(repo, ['ls-tree', '-r', '-z', '--full-tree', rev]).split('\0').filter(Boolean);
  const files = [];
  const blobs = [];
  for (const row of rows) {
    const tab = row.indexOf('\t');
    const [mode, type, oid] = row.slice(0, tab).split(' ');
    const path = row.slice(tab + 1);
    files.push(path);
    if (type === 'blob' && mode !== '120000' && TEXT_EXT.test(path) && !isDoc(path)) blobs.push({ path, oid });
  }
  const out = execFileSync('git', ['cat-file', '--batch'], { cwd: repo, input: blobs.map((b) => b.oid).join('\n') + '\n', maxBuffer: 1024 * 1024 * 1024 });
  const text = new Map();
  let at = 0;
  for (const b of blobs) {
    const nl = out.indexOf(10, at);
    const header = out.subarray(at, nl).toString('utf8').split(' ');
    const size = Number(header[2]);
    if (!Number.isFinite(size)) throw new Error(`git cat-file: no size for ${b.path}`);
    const body = out.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
    if (size <= 2 * 1024 * 1024 && !body.includes(0)) text.set(b.path, body.toString('utf8'));
  }
  return { files, text };
}

/**
 * The string literals of JS or TS code, comments left out, split into import specifiers (import/export from, import(), require(),
 * mock.module()) and the others. A regular expression literal is skipped by the usual rule (a `/` where an expression starts). `ok` is false
 * when the scan ended inside a literal (the caller then reads the raw text: wider, never narrower).
 */
export function literals(src) {
  const specs = [];
  const strs = [];
  let i = 0;
  let prev = ''; // the last significant character outside literals and comments
  let prevWord = '';
  const n = src.length;
  const exprStart = () => prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /^(return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/.test(prevWord);
  const readQuoted = (q) => {
    let s = '';
    i++;
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') {
        s += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (src[i] === '\n' && q !== '`') return null;
      s += src[i++];
    }
    if (i >= n) return null;
    i++;
    return s;
  };
  const before = (end) => src.slice(Math.max(0, end - 40), end);
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) return { specs, strs, ok: false };
      i = e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      const s = readQuoted(c);
      if (s === null) return { specs, strs, ok: false };
      if (/(\bfrom|\bimport|\brequire\s*\(|\bimport\s*\(|\.module\s*\()\s*$/.test(before(start))) specs.push(s);
      else strs.push(s);
      prev = c;
      prevWord = '';
      continue;
    }
    if (c === '`') {
      // A template: its text parts are literals; ${...} is code, scanned for its own literals (one level of nesting is enough here).
      i++;
      let s = '';
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') {
          s += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          let j = i + 2;
          while (j < n && depth) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            else if (src[j] === "'" || src[j] === '"') {
              const q = src[j++];
              let t = '';
              while (j < n && src[j] !== q && src[j] !== '\n') t += src[j++];
              strs.push(t);
            }
            j++;
          }
          strs.push(s);
          s = '';
          i = j;
          continue;
        }
        s += src[i++];
      }
      if (i >= n) return { specs, strs, ok: false };
      i++;
      strs.push(s);
      prev = '`';
      prevWord = '';
      continue;
    }
    if (c === '/' && exprStart()) {
      // A regular expression literal: to its closing slash (classes may hold one), then its flags.
      i++;
      let cls = false;
      while (i < n && (cls || src[i] !== '/')) {
        if (src[i] === '\n') break;
        if (src[i] === '\\') i++;
        else if (src[i] === '[') cls = true;
        else if (src[i] === ']') cls = false;
        i++;
      }
      i++;
      while (i < n && /[a-z]/.test(src[i])) i++;
      prev = '/';
      prevWord = '';
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let w = '';
      while (i < n && /[A-Za-z0-9_$]/.test(src[i])) w += src[i++];
      prev = 'a';
      prevWord = w;
      continue;
    }
    if (!/\s/.test(c)) {
      prev = c;
      prevWord = '';
    }
    i++;
  }
  return { specs, strs, ok: true };
}

/** The file an import specifier names, or null (a package, a builtin, a file that is not there). */
function resolveSpec(from, spec, fileSet) {
  let base;
  if (spec.startsWith('./') || spec.startsWith('../')) base = posix.normalize(posix.join(posix.dirname(from), spec));
  else if (spec === '@portal/contracts' || spec.startsWith('@portal/contracts/')) return 'packages/contracts/src/index.ts';
  else if (spec.startsWith('@/') && from.startsWith('apps/web/')) base = `apps/web/src/${spec.slice(2)}`;
  else return null;
  base = base.replace(/\?.*$/, '');
  const tries = [base];
  if (/\.(js|jsx)$/.test(base)) tries.push(base.replace(/\.jsx?$/, '.ts'), base.replace(/\.jsx?$/, '.tsx'));
  if (base.endsWith('.mjs')) tries.push(base.replace(/\.mjs$/, '.mts'));
  tries.push(`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`);
  return tries.find((t) => fileSet.has(t)) ?? null;
}

/** The import graph (who imports whom) and indexes of what may name a file: name tokens, whole literals, resolved relative literals. */
export function buildGraph(tree) {
  const fileSet = new Set(tree.files);
  const importers = new Map(); // file -> Set of files that import it
  const tokens = new Map(); // a name token (split at characters a file name has not) -> files whose literals or text hold it
  const whole = new Map(); // a literal without ./ ../ and a trailing slash -> files (a folder named by its path)
  const rel = new Map(); // a relative literal resolved against its file -> files
  const walkers = [];
  const repoReaders = new Set(); // code that finds files of the repository (import.meta.url, process.cwd())
  const add = (m, k, v) => {
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(v);
  };
  const tokenize = (text, file) => {
    for (const t of text.split(/[^A-Za-z0-9_.@-]+/)) if (t) add(tokens, t, file);
  };
  for (const [path, text] of tree.text) {
    if (!CODE_EXT.test(path)) {
      tokenize(text, path);
      continue;
    }
    const lit = literals(text);
    for (const spec of lit.specs) {
      const to = resolveSpec(path, spec, fileSet);
      if (to) add(importers, to, path);
    }
    if (!lit.ok) tokenize(text, path);
    for (const s of lit.strs) {
      if (lit.ok) tokenize(s, path);
      const t = s.replace(/^(\.\.?\/)+|^\/+/, '').replace(/\/$/, '');
      if (t && t !== '.' && t !== '..') add(whole, t, path);
      // new URL('./fixture.json', import.meta.url), a path to spawn: names a file or a folder.
      if (s.startsWith('./') || s.startsWith('../')) add(rel, posix.normalize(posix.join(posix.dirname(path), s)).replace(/\/$/, ''), path);
    }
    if (REPO_PATH.test(text)) repoReaders.add(path);
    if (isServerTest(path) && WALKS.test(text) && REPO_PATH.test(text)) walkers.push(path);
  }
  return { fileSet, importers, tokens, whole, rel, walkers, repoReaders };
}

const isCode = (p) => CODE_EXT.test(p);

/**
 * The files whose text names `path`. A script, manifest or document by its basename, as a token of a literal (code) or of the text
 * (scripts, manifests); a document only from code that finds files of the repository (import.meta.url, process.cwd()): other code
 * can not read the repository's copy, and the scripts that read documents are tested on fixtures (the context pack's own freshness check
 * runs in every gate). Code (a .ts file) by a literal path of at least two segments ('agent/main.ts',
 * 'src/cli.js'), never by a bare basename ('index.ts' names nothing in particular). Any file: a literal that is a folder above it with a
 * slash ('apps/web/src', 'web/src') or a dot folder ('.pilot'); a relative literal that resolves to it, or to a folder above it below the top.
 */
export function referrers(path, graph) {
  const out = new Set();
  const doc = isDoc(path);
  const take = (set) => {
    for (const f of set ?? []) if (f !== path && !(doc && !(isCode(f) && graph.repoReaders.has(f)))) out.add(f);
  };
  const seg = path.split('/');
  if (isCode(path)) {
    const alt = path.replace(/\.tsx?$/, '.js');
    for (let k = 0; k < seg.length - 1; k++) {
      take(graph.whole.get(seg.slice(k).join('/')));
      if (alt !== path) take(graph.whole.get(alt.split('/').slice(k).join('/')));
    }
  } else take(graph.tokens.get(posix.basename(path)));
  for (let d = posix.dirname(path); d !== '.'; d = posix.dirname(d)) {
    const ds = d.split('/');
    if (ds.length > 1 || d.startsWith('.')) take(graph.whole.get(d));
    for (let k = 1; k < ds.length - 1; k++) take(graph.whole.get(ds.slice(k).join('/')));
    if (ds.length > 1) take(graph.rel.get(d));
  }
  take(graph.rel.get(path));
  if (/\.tsx?$/.test(path)) take(graph.rel.get(path.replace(/\.tsx?$/, '.js')));
  return [...out];
}

/** Scripts and pipelines run what they name: a script reached is followed further by the files that name it. Data (json, html) is not. */
const RUNS = /\.(sh|bash|mjs|cjs|py)$|^\.pilot\/[^/]+\.ya?ml$|(^|\/)Dockerfile[^/]*$/;

/**
 * Every file reached from the changed files, to a fixed point: a changed file is followed by its importers and by the files that name it;
 * a reached code file (not a test: tests are leaves) by its importers; a script that names a changed file by the files that name it (one
 * hop: a pipeline that runs it, a test that reads it), not further. A code file that only imports a changed one has the same text, so
 * whatever reads its text is not affected. `why` keeps one reason per reached file.
 */
export function reach(changed, graph) {
  const seen = new Map();
  const queue = [];
  const visit = (f, why, hop) => {
    if (!seen.has(f)) {
      seen.set(f, why);
      queue.push([f, hop]);
    }
  };
  for (const p of changed) visit(p, 'changed', 0);
  while (queue.length) {
    const [p, hop] = queue.shift();
    if (isServerTest(p) && hop > 0) continue;
    for (const imp of graph.importers.get(p) ?? []) visit(imp, `imports ${p}`, hop + 1);
    if (hop === 0 || (hop === 1 && RUNS.test(p) && seen.get(p).startsWith('names '))) for (const ref of referrers(p, graph)) visit(ref, `names ${p}`, hop + 1);
  }
  return seen;
}

/** The changed paths between two commits (renames as a delete and an add). */
const diffNames = (repo, a, b) => git(repo, ['diff', '--name-only', '--no-renames', a, b]).split('\n').filter(Boolean);

/** Documents that nothing reads: what a reuse may differ by. Returns the first file that blocks it, or null. */
function reuseBlocker(changed, graph) {
  for (const p of changed) {
    if (!isDoc(p)) return `${p} is not a document`;
    const r = referrers(p, graph);
    if (r.length) return `${p} is read by ${r[0]}`;
  }
  return null;
}

export function plan(opts) {
  const { repo, head } = opts;
  const out = { mode: 'full', reason: '', base: '', reused: '', steps: [...ALL_STEPS], files: [], changed: [], serverTests: 0, serverTotal: 0, web: true, why: [] };
  const records = opts.records ?? [];
  if (opts.full && !opts.reuseOnly) return { ...out, reason: 'asked for (FULL)' };
  let tree;
  let graph;
  const ensureGraph = () => {
    if (!graph) {
      tree = readTree(repo, head);
      graph = buildGraph(tree);
    }
    return graph;
  };
  // 2. Reuse.
  for (const rec of records) {
    if (!exists(repo, rec.commit)) continue;
    const changed = diffNames(repo, rec.commit, head);
    let blocker;
    try {
      blocker = changed.every(isDoc) ? reuseBlocker(changed, ensureGraph()) : 'code changed';
    } catch (e) {
      blocker = `the graph could not be built (${e.message})`;
    }
    if (!blocker) {
      return { ...out, mode: 'reuse', reused: rec.commit, steps: [], web: false, changed, reason: `the green ${rec.kind} gate of ${rec.commit.slice(0, 8)} (${rec.at || 'time unknown'}); the trees differ only in ${changed.length ? `${changed.length} document(s) nothing reads` : 'nothing'}` };
    }
  }
  if (opts.reuseOnly) return { ...out, mode: 'none', reason: 'no recorded green gate to reuse' };
  // 3. The base.
  let base = opts.base ?? '';
  if (base && !exists(repo, base)) return { ...out, reason: `the base ${base} is not here` };
  if (!base) {
    if (!opts.baseRef) return { ...out, reason: 'no base: no --base and no --base-ref' };
    if (!exists(repo, opts.baseRef)) return { ...out, reason: `${opts.baseRef} is not here` };
    const green = new Set(records.map((r) => r.commit));
    const walk = git(repo, ['rev-list', '--max-count=1000', opts.baseRef]).split('\n').filter(Boolean);
    base = walk.find((c) => green.has(c)) ?? '';
    if (!base) return { ...out, reason: `no green gated commit is known on ${opts.baseRef} (the last 1000 commits)` };
  }
  out.base = base;
  const changed = diffNames(repo, base, head);
  out.changed = changed;
  // 4. Full: core, graph, too wide.
  const core = changed.filter((p) => CORE.some((r) => r.test(p)));
  if (core.length) return { ...out, reason: `shared core changed: ${core.slice(0, 5).join(', ')}${core.length > 5 ? ` and ${core.length - 5} more` : ''}` };
  try {
    ensureGraph();
  } catch (e) {
    return { ...out, reason: `the import graph could not be built: ${e.message}` };
  }
  const allTests = tree.files.filter(isServerTest);
  out.serverTotal = allTests.length;
  if (!changed.length) return { ...out, mode: 'scoped', steps: ['typecheck'], web: false, reason: `the tree is the green base's (${base.slice(0, 8)})` };
  const reached = reach(changed, graph);
  const tests = new Set([...reached.keys()].filter((p) => isServerTest(p) && graph.fileSet.has(p)));
  for (const w of graph.walkers) if (!tests.has(w)) reached.set(w, reached.get(w) ?? 'walks the repository'), tests.add(w);
  const web = [...reached.keys()].some((p) => p.startsWith('apps/web/'));
  out.why = [...reached].filter(([p]) => tests.has(p) || p.startsWith('apps/web/') || changed.includes(p)).map(([p, w]) => `${p}: ${w}`);
  if (tests.size > allTests.length / 2) return { ...out, serverTests: tests.size, reason: `the change reaches ${tests.size} of ${allTests.length} server test files` };
  const steps = ['typecheck'];
  if (web) steps.push('web-build', 'web-tests');
  if (tests.size) steps.push('server-suite');
  const files = [...tests].sort().map((p) => p.slice('apps/server/'.length));
  return { ...out, mode: 'scoped', steps, files, web, serverTests: files.length, reason: `${changed.length} file(s) changed since ${base.slice(0, 8)}: ${files.length} of ${allTests.length} server test files${web ? ', the web build and tests' : ''}` };
}

function main(argv) {
  const opt = { repo: process.cwd(), head: 'HEAD', format: 'env', full: process.env.FULL === '1', reuseOnly: false };
  let recordsFile = '';
  let kinds = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i] ?? die(`${a} needs a value`);
    if (a === '--head') opt.head = val();
    else if (a === '--base') opt.base = val();
    else if (a === '--base-ref') opt.baseRef = val();
    else if (a === '--records') recordsFile = val();
    else if (a === '--repo') opt.repo = val();
    else if (a === '--format') opt.format = val();
    else if (a === '--kinds') kinds = val().split(',');
    else if (a === '--full') opt.full = true;
    else if (a === '--reuse-only') opt.reuseOnly = true;
    else die(`unknown argument ${a}`);
  }
  if (!['env', 'json', 'text'].includes(opt.format)) die('--format env, json or text');
  try {
    opt.head = git(opt.repo, ['rev-parse', '--verify', `${opt.head}^{commit}`]).trim();
  } catch {
    die(`unknown head ${opt.head}`);
  }
  opt.records = [];
  if (recordsFile) {
    let text = '';
    try {
      text = execFileSync('cat', [recordsFile], { encoding: 'utf8' });
    } catch {
      text = '';
    }
    for (const line of text.split('\n')) {
      const m = /^([0-9a-f]{40}) (full|scoped|reuse)(?: (\S+))?/.exec(line.trim());
      if (m && (!kinds || kinds.includes(m[2]))) opt.records.push({ commit: m[1], kind: m[2], at: m[3] ?? '' });
    }
    opt.records.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }
  let p;
  try {
    p = plan(opt);
  } catch (e) {
    p = { mode: 'full', reason: `the selection failed: ${String(e.message).split('\n')[0]}`, base: opt.base ?? '', reused: '', steps: [...ALL_STEPS], files: [], changed: [], serverTests: 0, serverTotal: 0, web: true, why: [] };
  }
  if (opt.format === 'json') {
    process.stdout.write(`${JSON.stringify(p, null, 1)}\n`);
    return;
  }
  for (const w of p.why.slice(0, 200)) process.stderr.write(`gate-select: ${w}\n`);
  if (opt.format === 'text') {
    process.stdout.write(`${p.mode}: ${p.reason}\n  steps: ${p.steps.join(',') || '(none)'}\n  server test files: ${p.mode === 'full' ? 'all' : p.files.length}\n`);
    return;
  }
  const one = (s) => String(s).replace(/[\r\n]+/g, ' ');
  process.stdout.write(
    [
      `MODE=${p.mode}`,
      `REASON=${one(p.reason)}`,
      `BASE=${p.base}`,
      `REUSED=${p.reused}`,
      `STEPS=${p.steps.join(',')}`,
      `FILES=${p.files.join(' ')}`,
      `CHANGED=${p.changed.join(' ')}`,
      `SERVER_TESTS=${p.mode === 'full' ? 'all' : p.serverTests}`,
      `SERVER_TOTAL=${p.serverTotal}`,
      `WEB=${p.web}`,
    ].join('\n') + '\n',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
