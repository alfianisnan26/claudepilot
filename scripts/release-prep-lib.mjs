#!/usr/bin/env node
// The checks of scripts/release-prep.sh that read files (owner request 2026-10-31, harness). Plain node, no dependency; it reads git objects
// only (git show <ref>:<path>), never the working tree.
//   node scripts/release-prep-lib.mjs migrations <ref> [--base origin/main] [--other origin/integration] [--allow-block <n>]...
//   node scripts/release-prep-lib.mjs lock <ref>
// Prints one line per problem (`problem: ...`) and notes (`ok: ...`); exit 1 when there is a problem, 2 on a usage error.
//
// migrations (apps/server/src/store/migrations.ts):
//   - a version twice in <ref>;
//   - a version of <base> (released) that <ref> drops or edits;
//   - a version that <ref> and <other> both have with different text (two branches took the same number: the 884/900 conflict);
//   - a version new in <ref> (not in <base>) in a block of ten nobody has claimed: no migration of <base> or <other> in it and no range
//     in docs/coord/PLAN.md that covers it (--allow-block <n> claims the block of n by hand).
// lock (package-lock.json against the package.json files):
//   - lockfileVersion is not 2 or 3;
//   - a package.json (root or workspace) and its lock entry list different dependencies or ranges;
//   - a package whose optionalDependencies name a linux-x64 build (glibc; the images are node:22-bookworm) that the lock does not hold:
//     npm on another platform can drop them, and the image build then fails (lightningcss-linux-x64-gnu, @rollup/rollup-linux-x64-gnu ...).
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const MIGRATIONS_FILE = 'apps/server/src/store/migrations.ts';

/** The file at a revision, or null when it is not there. */
export function show(repo, rev, path) {
  try {
    return execFileSync('git', ['show', `${rev}:${path}`], {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** The migrations of a migrations.ts text: [{version, name, text}], in file order. `text` is the entry with its whitespace normalised. */
export function parseMigrations(src) {
  const out = [];
  const re = /^\s*version:\s*(\d+),/gm;
  const starts = [];
  let m;
  while ((m = re.exec(src))) starts.push({ at: m.index, version: Number(m[1]) });
  for (let i = 0; i < starts.length; i++) {
    const text = src.slice(starts[i].at, i + 1 < starts.length ? starts[i + 1].at : src.length);
    const name = /name:\s*(['"`])((?:\\.|(?!\1).)*)\1/s.exec(text)?.[2] ?? '';
    // The tail of the last entry runs into what follows the array; cut it at the array's end for the comparison.
    const body = i + 1 < starts.length ? text : text.split(/\n\];/)[0];
    out.push({
      version: starts[i].version,
      name,
      text: body
        .replace(/[\s{},]*$/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    });
  }
  return out;
}

/** Ranges claimed in a plan text: `a-b` and `a+` (a..a+99) on lines that speak of migrations or blocks; 1-15 is the core. */
export function claimedRanges(plan) {
  const ranges = [[1, 15]];
  for (const line of (plan ?? '').split('\n')) {
    if (!/migration|block|overflow/i.test(line) && !/^\|\s*A\d/.test(line)) continue;
    // The roster table: only its last cell (Migrations) holds ranges; other cells hold ports.
    const scope = /^\|/.test(line)
      ? (line
          .split('|')
          .filter((c) => c.trim())
          .at(-1) ?? '')
      : line;
    for (const r of scope.matchAll(/\b(\d{1,4})\s*-\s*(\d{1,4})\b/g)) ranges.push([Number(r[1]), Number(r[2])]);
    for (const r of scope.matchAll(/\b(\d{1,4})\+/g)) ranges.push([Number(r[1]), Number(r[1]) + 99]);
  }
  return ranges.filter(([a, b]) => a <= b && b - a < 1000);
}

export function checkMigrations({ ref, base, other, plan, allowBlocks = [] }) {
  const problems = [];
  const notes = [];
  if (!ref) return { problems: [`${MIGRATIONS_FILE} is missing at the ref`], notes };
  const mine = parseMigrations(ref);
  const seen = new Map();
  for (const m of mine) {
    if (seen.has(m.version)) problems.push(`migration ${m.version} appears twice ("${seen.get(m.version).name}" and "${m.name}")`);
    else seen.set(m.version, m);
  }
  const baseList = base ? parseMigrations(base) : [];
  const otherList = other ? parseMigrations(other) : [];
  const baseBy = new Map(baseList.map((m) => [m.version, m]));
  const otherBy = new Map(otherList.map((m) => [m.version, m]));
  for (const b of baseList) {
    const r = seen.get(b.version);
    if (!r) problems.push(`released migration ${b.version} ("${b.name}") is gone (migrations are append only)`);
    else if (r.text !== b.text) problems.push(`released migration ${b.version} ("${b.name}") was edited (migrations are append only)`);
  }
  for (const r of seen.values()) {
    const o = otherBy.get(r.version);
    if (o && !baseBy.has(r.version) && o.text !== r.text)
      problems.push(
        `migration ${r.version} differs from the other branch ("${r.name}" here, "${o.name}" there): two branches took the same number`,
      );
  }
  const ranges = claimedRanges(plan);
  const known = new Set([...baseList, ...otherList].map((m) => Math.floor(m.version / 10)));
  for (const n of allowBlocks) known.add(Math.floor(n / 10));
  const fresh = [...seen.values()].filter((m) => !baseBy.has(m.version));
  for (const m of fresh) {
    const block = Math.floor(m.version / 10);
    const claimed = known.has(block) || ranges.some(([a, b]) => m.version >= a && m.version <= b);
    if (!claimed)
      problems.push(
        `migration ${m.version} ("${m.name}") opens the unclaimed block ${block * 10}-${block * 10 + 9}: claim it in docs/coord/PLAN.md`,
      );
  }
  notes.push(
    `${mine.length} migrations, ${fresh.length} new since the base${fresh.length ? ` (${fresh.map((m) => m.version).join(', ')})` : ''}`,
  );
  return { problems, notes };
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const LINUX_X64 = /(^|[-/])linux-x64(-gnu)?$/;

/** Where node would find `dep` from the lock entry at `from` (node_modules lookup, walking up). */
function resolveIn(packages, from, dep) {
  let dir = from;
  for (;;) {
    const at = `${dir ? `${dir}/` : ''}node_modules/${dep}`;
    if (packages[at]) return at;
    if (!dir) return null;
    const i = dir.lastIndexOf('/node_modules/');
    dir = i >= 0 ? dir.slice(0, i) : '';
  }
}

/** lockText: package-lock.json; manifests: { '<dir>': package.json text } for '' (root) and each workspace folder. */
export function checkLock({ lockText, manifests }) {
  const problems = [];
  const notes = [];
  let lock;
  try {
    lock = JSON.parse(lockText ?? '');
  } catch {
    return { problems: ['package-lock.json is missing or not JSON'], notes };
  }
  if (![2, 3].includes(lock.lockfileVersion)) problems.push(`package-lock.json lockfileVersion ${lock.lockfileVersion} (expected 2 or 3)`);
  const packages = lock.packages ?? {};
  for (const [dir, text] of Object.entries(manifests)) {
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      problems.push(`${dir || '.'}/package.json is not JSON`);
      continue;
    }
    const entry = packages[dir];
    if (!entry) {
      problems.push(`${dir || '.'}/package.json has no entry in package-lock.json (run npm install)`);
      continue;
    }
    for (const field of DEP_FIELDS) {
      const want = pkg[field] ?? {};
      const have = entry[field] ?? {};
      for (const name of new Set([...Object.keys(want), ...Object.keys(have)])) {
        if (want[name] === have[name]) continue;
        const where = `${dir || '.'}/package.json ${field} ${name}`;
        if (!(name in have)) problems.push(`${where} ${want[name]} is not in package-lock.json (run npm install)`);
        else if (!(name in want)) problems.push(`${where}: package-lock.json still lists ${have[name]} (run npm install)`);
        else problems.push(`${where}: ${want[name]} in package.json, ${have[name]} in package-lock.json`);
      }
    }
  }
  let natives = 0;
  for (const [at, entry] of Object.entries(packages)) {
    for (const dep of Object.keys(entry.optionalDependencies ?? {})) {
      if (!LINUX_X64.test(dep)) continue;
      // A workspace entry's dependencies install at the root.
      const from = at && !at.includes('node_modules/') ? '' : at;
      if (resolveIn(packages, from, dep)) natives++;
      else
        problems.push(
          `${at || '.'} needs ${dep} (linux-x64) and package-lock.json does not hold it: the image build will fail; regenerate the lock with every platform (npm install --os=linux --cpu=x64, or delete it and npm install)`,
        );
    }
  }
  notes.push(`${natives} linux-x64 native builds in the lock, ${Object.keys(manifests).length} package.json files against it`);
  return { problems, notes };
}

/** The package.json files the lock covers at a revision: the root and its workspace folders. */
export function manifestsAt(repo, rev) {
  const root = show(repo, rev, 'package.json');
  const out = { '': root ?? '' };
  let globs = [];
  try {
    const w = JSON.parse(root ?? '{}').workspaces;
    globs = Array.isArray(w) ? w : (w?.packages ?? []);
  } catch {
    return out;
  }
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', rev], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }).split('\n');
  for (const g of globs) {
    const re = new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')}/package\\.json$`);
    for (const f of files) if (re.test(f)) out[f.slice(0, -'/package.json'.length)] = show(repo, rev, f);
  }
  return out;
}

function main(argv) {
  const [cmd, ref, ...rest] = argv;
  const repo = process.env.RELEASE_PREP_REPO || process.cwd();
  if (!cmd || !ref) {
    process.stderr.write('usage: release-prep-lib.mjs migrations|lock <ref> [--base r] [--other r] [--allow-block n]\n');
    return 2;
  }
  let result;
  if (cmd === 'migrations') {
    let base = 'origin/main';
    let other = 'origin/integration';
    const allowBlocks = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--base') base = rest[++i];
      else if (rest[i] === '--other') other = rest[++i];
      else if (rest[i] === '--allow-block') allowBlocks.push(Number(rest[++i]));
      else {
        process.stderr.write(`release-prep-lib: unknown option ${rest[i]}\n`);
        return 2;
      }
    }
    result = checkMigrations({
      ref: show(repo, ref, MIGRATIONS_FILE),
      base: base ? show(repo, base, MIGRATIONS_FILE) : null,
      other: other ? show(repo, other, MIGRATIONS_FILE) : null,
      plan: show(repo, ref, 'docs/coord/PLAN.md'),
      allowBlocks,
    });
  } else if (cmd === 'lock') {
    result = checkLock({ lockText: show(repo, ref, 'package-lock.json'), manifests: manifestsAt(repo, ref) });
  } else {
    process.stderr.write(`release-prep-lib: unknown check ${cmd}\n`);
    return 2;
  }
  for (const n of result.notes) process.stdout.write(`ok: ${n}\n`);
  for (const p of result.problems) process.stdout.write(`problem: ${p}\n`);
  return result.problems.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
