#!/usr/bin/env node
// The CF-vs-k8s comparison of job-run runs (T-3542, CFR-8; plan §7): reads the metrics lines job-run.sh writes (cf runs always, k8s runs
// with JOB_RUN_METRICS=1) and prints one row per backend (and per program with --by-program).
//   scripts/job-run-metrics.mjs [<metrics.jsonl>] [--since <ISO date>] [--by-program] [--json]
// Default file: ${JOB_RUN_CACHE_DIR:-~/.cache/claudepilot-job-run}/metrics.jsonl. A line that is not JSON is skipped (and counted).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const file =
  args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--since') ??
  join(process.env.JOB_RUN_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'claudepilot-job-run'), 'metrics.jsonl');
const since = opt('--since');
let text = '';
try {
  text = readFileSync(file, 'utf8');
} catch {
  process.stderr.write(`job-run-metrics: no metrics file at ${file}\n`);
  process.exit(1);
}
let bad = 0;
const rows = [];
for (const l of text.split('\n')) {
  if (!l.trim()) continue;
  try {
    const r = JSON.parse(l);
    if (since && !(String(r.t) >= since)) continue;
    rows.push(r);
  } catch {
    bad++;
  }
}
const pct = (xs, p) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
};
const groups = new Map();
for (const r of rows) {
  const k = flag('--by-program') ? `${r.backend}/${r.program ?? '?'}` : String(r.backend ?? '?');
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const out = [...groups.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, rs]) => ({
    group: k,
    runs: rs.length,
    queue_p50: pct(rs.map((r) => r.queue_s), 50),
    queue_p90: pct(rs.map((r) => r.queue_s), 90),
    start_p50: pct(rs.map((r) => r.start_s), 50),
    start_p90: pct(rs.map((r) => r.start_s), 90),
    run_p50: pct(rs.map((r) => r.run_s), 50),
    run_p90: pct(rs.map((r) => r.run_s), 90),
    wall_p50: pct(rs.map((r) => r.wall_s), 50),
    wall_p90: pct(rs.map((r) => r.wall_s), 90),
    rc_nonzero: rs.filter((r) => r.rc !== 0).length,
    infra_fail_pct: Math.round((1000 * rs.filter((r) => r.infra_fail === true).length) / rs.length) / 10,
    est_usd: Math.round(1e4 * rs.reduce((s, r) => s + (typeof r.est_usd === 'number' ? r.est_usd : 0), 0)) / 1e4,
  }));
if (flag('--json')) {
  process.stdout.write(`${JSON.stringify({ file, skipped: bad, groups: out })}\n`);
} else {
  const cols = ['group', 'runs', 'queue_p50', 'queue_p90', 'start_p50', 'start_p90', 'run_p50', 'run_p90', 'wall_p50', 'wall_p90', 'rc_nonzero', 'infra_fail_pct', 'est_usd'];
  const cell = (v) => (v === null || v === undefined ? '-' : String(v));
  const w = cols.map((c) => Math.max(c.length, ...out.map((o) => cell(o[c]).length)));
  process.stdout.write(`${cols.map((c, i) => c.padEnd(w[i])).join('  ')}\n`);
  for (const o of out) process.stdout.write(`${cols.map((c, i) => cell(o[c]).padEnd(w[i])).join('  ')}\n`);
  if (bad) process.stdout.write(`(${bad} line(s) skipped: not JSON)\n`);
}
