#!/usr/bin/env node
// Reuse of a green gate verdict (T-578). The deploy pipeline's gate step skips the gate Job ONLY for a commit whose git TREE already gated green
// in the last 24 h, on the verdict record the gate Job itself produced. Everything else runs the gate: every doubt fails closed.
//   gate-reuse.mjs record --commit <sha> --tree <tree>   stdin: a gate Job's log. Prints the record to keep (JSON, one line), exit 0; else
//                                                         `no record: <why>` and exit 1. Used by scripts/gate-job.sh after a green full run.
//   gate-reuse.mjs decide --tree <tree> [--now <epoch>]  stdin: the stored record (may be empty). `reuse <job> <commit> <tree> <iso time>`
//                                                         and exit 0, or `run: <why>` and exit 1. Used by .pilot/scripts/gate.sh.
// The record is the `GATE-RESULT {json}` line the gate Job prints (deploy/k3s-build/gate-job.yaml) after its own green verdict, with the commit
// and the tree it checked out itself. Only the LAST such line counts (the Job prints it last, after the tests ran), only for the commit that was
// asked for, only for the whole gate (all three steps, no file subset), and the tree must be the one the caller computed from its own checkout.
import { pathToFileURL } from 'node:url';

export const FULL_STEPS = 'typecheck,web-build,server-suite';
export const MAX_AGE_S = 24 * 3600;
const SKEW_S = 120;
const HEX = /^[0-9a-f]{40}$/;
const JOB = /^claudepilot-gate-[0-9a-f]{7}-[0-9a-f]{4}$/;

/** The record a gate Job printed, from its log: the last `GATE-RESULT ` line, checked against the commit and tree the caller expects. */
export function parseGateResult(log, expect) {
  const lines = String(log).split('\n').filter((l) => l.startsWith('GATE-RESULT '));
  const last = lines[lines.length - 1];
  if (!last) return { ok: false, why: 'the log has no GATE-RESULT line' };
  let r;
  try { r = JSON.parse(last.slice('GATE-RESULT '.length)); } catch { return { ok: false, why: 'the GATE-RESULT line is not JSON' }; }
  const bad = checkRecord(r);
  if (bad) return { ok: false, why: bad };
  if (r.commit !== expect.commit) return { ok: false, why: 'the result is for another commit' };
  if (r.tree !== expect.tree) return { ok: false, why: 'the result is for another tree' };
  return { ok: true, record: r };
}

/** Why a record cannot be trusted, or null. Pure. */
function checkRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'the record is not an object';
  if (r.source !== 'gate-job') return 'the record did not come from a gate Job';
  if (typeof r.job !== 'string' || !JOB.test(r.job)) return 'the record names no gate Job';
  if (r.verdict !== 'green') return 'the record is not green';
  if (typeof r.commit !== 'string' || !HEX.test(r.commit)) return 'the record has no commit';
  if (typeof r.tree !== 'string' || !HEX.test(r.tree)) return 'the record has no tree';
  if (r.steps !== FULL_STEPS) return 'the record is not of the whole gate';
  if (r.files !== '') return 'the record is of a file subset';
  if (!Number.isInteger(r.finished) || r.finished <= 0) return 'the record has no finish time';
  return null;
}

/** Reuse or run. `recordText`: the stored record (a string, may be empty or garbage). Pure: the clock is `now` (epoch seconds). */
export function decideGateReuse(recordText, { tree, now }) {
  if (typeof tree !== 'string' || !HEX.test(tree)) return { reuse: false, why: 'no tree for the commit' };
  if (!Number.isFinite(now)) return { reuse: false, why: 'no clock' };
  const text = String(recordText ?? '').trim();
  if (!text) return { reuse: false, why: 'no verdict stored for this tree' };
  let r;
  try { r = JSON.parse(text); } catch { return { reuse: false, why: 'the stored verdict is unreadable' }; }
  const bad = checkRecord(r);
  if (bad) return { reuse: false, why: bad };
  if (r.tree !== tree) return { reuse: false, why: 'the stored verdict is of another tree' };
  if (r.finished > now + SKEW_S) return { reuse: false, why: 'the stored verdict is dated in the future' };
  if (now - r.finished > MAX_AGE_S) return { reuse: false, why: 'the stored verdict is older than 24 h' };
  return { reuse: true, record: r };
}

async function stdin() { let s = ''; for await (const c of process.stdin) s += c; return s; }
function arg(name) { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; }

async function main() {
  const [cmd] = process.argv.slice(2);
  if (cmd === 'record') {
    const res = parseGateResult(await stdin(), { commit: arg('commit') ?? '', tree: arg('tree') ?? '' });
    if (!res.ok) { console.log(`no record: ${res.why}`); return 1; }
    console.log(JSON.stringify(res.record)); return 0;
  }
  if (cmd === 'decide') {
    const now = arg('now') !== undefined ? Number(arg('now')) : Math.floor(Date.now() / 1000);
    const d = decideGateReuse(await stdin(), { tree: arg('tree') ?? '', now });
    if (!d.reuse) { console.log(`run: ${d.why}`); return 1; }
    const r = d.record;
    console.log(`reuse ${r.job} ${r.commit} ${r.tree} ${new Date(r.finished * 1000).toISOString()}`); return 0;
  }
  console.error('usage: gate-reuse.mjs record|decide ...'); return 2;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
