#!/usr/bin/env node
// One round of the factory engine (T-293 slice 3), the entry a supervisor hook runs (every few minutes or on a CI event) and the coordinator
// reads. A SEPARATE script on purpose: supervisor.mjs does not call it yet (that wiring is a later, reviewed change). It STARTS NO SESSION and
// calls no model (the Bypass lease is the owner's open decision); it reads the portal, plans, and prints one line per thing to do:
//   node docs/dev-sessions/factory-round.mjs [--apply] [--wip 5] [--budget N] [--workspace W] [--repo DIR] [--base REF] [--stale-min 360]
//   PORTAL_URL (default https://pilot.ai.isnan.me) and PORTAL_SERVER_CODE: the supervisor's auth path; the cookie stays in memory, never printed.
// Output (stdout), one line each:
//   factory-round: <summary>
//   DISPATCH <id> ...                  intake's plan (dry: "would"; --apply: the result of applyPlan)
//   RESUME <id> run=<r> next=<step>    a finished CI run of a dispatch (--apply writes the FACTORY RESUME marker; dry says "would")
//   NEXT <ticket> <id> <step> <role>/<model>: <why>   the step a role runs now (review, verify, fix) or the coordinator (integrate)
//   LEARN <id>: would comment          followed by the ACTUAL text, indented (printed, never written by this script)
//   EXCEPTION <ticket> <id>: <why>     the coordinator's: stale, cancelled, out of order, conflict, rework limit, budget stop, refused, errors
// Exit: 0 after a round (exceptions are lines, not a failure), 1 when the portal could not be read (an EXCEPTION line says so), 2 usage.
// Ticket text is untrusted data and is not printed: lines carry ids, states and the engine's own words.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as f from './factory.mjs';

/** Changed paths of a branch against the base, from git; null when git cannot say (the review then takes opus). */
export function gitChanged(repo, base = 'origin/integration', run = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  return (branch) => {
    try {
      return run(['diff', '--name-only', `${base}...${branch.startsWith('origin/') ? branch : `origin/${branch}`}`]).split('\n').filter(Boolean);
    } catch {
      return null;
    }
  };
}

/**
 * One round: intake (and with apply, applyPlan), then for every ticket with an open dispatch its pending CI resumes and its next step.
 * deps: { portal, git (gitOps, needed with apply), changed (branch -> paths | null), models, now (epoch ms), apply, wip, budget, workspace,
 * base, staleMin }. Returns { lines, exceptions } and writes nothing but the DISPATCH comments (applyPlan) and RESUME markers when apply.
 */
export async function runRound(deps) {
  const { portal, now, apply = false } = deps;
  if (!Number.isFinite(now)) throw new Error('runRound needs now (epoch ms)');
  const lines = [];
  const exceptions = [];
  const except = (ticket, id, reason) => exceptions.push({ ticket, dispatchId: id ?? null, reason });
  // The in-progress tickets are read whole too: their dispatches, step markers and CI checks are the state of the slices in flight.
  const listed = await f.fetchTickets(portal, { workspace: deps.workspace });
  const tickets = [];
  for (const t of listed) tickets.push(t.status === 'in_progress' && !(t.comments || t.events) ? await portal.get(t.id) : t);
  const plan = f.intake(tickets, { wip: deps.wip, budget: deps.budget, models: deps.models, worktrees: deps.worktrees, now, staleMin: deps.staleMin });
  for (const x of plan.exceptions) except(x.ticket, x.dispatchId, x.reason);
  if (apply) {
    const applied = await f.applyPlan({ ...plan, exceptions: [] }, { portal, git: deps.git, base: deps.base });
    for (const r of applied.results) lines.push(`DISPATCH ${r.dispatchId} ${r.action}${r.reason ? `: ${r.reason}` : ` ${r.branch}`}`);
    for (const x of applied.exceptions) except(x.ticket, x.dispatchId, x.reason);
  } else {
    for (const d of plan.dispatch) lines.push(`DISPATCH ${d.dispatchId} would: ${d.size} ${d.role}/${d.model} ${d.branch}`);
  }
  let next = 0;
  for (const raw of tickets) {
    const t = f.normalizeTicket(raw);
    if (!f.dispatchesOf(t).some((d) => !d.ended)) continue;
    // CI first: a finished run becomes a RESUME marker (red ones last, so a red run wins over a green one in the same round).
    const pending = f.pendingResumes(raw, { now, maxAgeMin: deps.staleMin ?? f.DEFAULT_RESUME_MAX_AGE_MIN });
    pending.sort((a, b) => Number(a.decision.next === 'fix') - Number(b.decision.next === 'fix'));
    const markers = [];
    for (const p of pending) {
      // A stale dispatch is already one EXCEPTION line from intake: not a second one per check.
      if (p.decision.action === 'exception') { if (!(/^stale/.test(p.decision.reason) && exceptions.some((x) => x.ticket === t.id))) except(t.id, null, p.decision.reason); continue; }
      const { marker, dispatch, next: step } = p.decision;
      const run = /run=(\S+)/.exec(marker)?.[1];
      if (apply) await portal.comment(t.id, marker);
      lines.push(`RESUME ${dispatch.id} run=${run} next=${step}${apply ? '' : ' (would write)'}`);
      markers.push({ kind: 'comment', at: new Date(now).toISOString(), text: marker });
    }
    const withMarkers = { ...t, comments: [...t.comments, ...markers] };
    const open = f.dispatchesOf(t).filter((d) => !d.ended);
    const branch = open[open.length - 1]?.branch;
    const s = f.nextStep(withMarkers, { models: deps.models, changedPaths: branch && deps.changed ? deps.changed(branch) : undefined });
    if (s.step === 'exception') except(t.id, s.dispatchId, s.reason);
    else if (s.step === 'learn') lines.push(`LEARN ${s.dispatchId}: would comment`, ...s.actual.split('\n').map((l) => `  ${l}`));
    else if (s.step !== 'none' && s.step !== 'wait') { next++; lines.push(`NEXT ${t.id} ${s.dispatchId} ${s.step} ${s.role}${s.model ? `/${s.model}` : ''}: ${s.reason}`); }
  }
  const summary = `factory-round: ${plan.dispatch.length} to dispatch${apply ? '' : ' (dry)'}; in flight ${plan.inFlight.length} of ${plan.wip}; ${next} next step(s); ${exceptions.length} exception(s)${plan.stopped ? `; stopped: ${plan.stopped}` : ''}`;
  for (const x of exceptions) lines.push(`EXCEPTION ${x.ticket}${x.dispatchId ? ` ${x.dispatchId}` : ''}: ${x.reason}`);
  return { lines: [summary, ...lines], exceptions };
}

function parseArgs(argv) {
  const o = { apply: false };
  const num = (v, a) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`${a} needs a number`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--apply') o.apply = true;
    else if (a === '--wip') o.wip = num(val(), a);
    else if (a === '--budget') o.budget = num(val(), a);
    else if (a === '--stale-min') o.staleMin = num(val(), a);
    else if (a === '--workspace') o.workspace = val();
    else if (a === '--repo') o.repo = val();
    else if (a === '--base') o.base = val();
    else if (a === '--worktrees') o.worktrees = val();
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

async function main() {
  let o;
  let portal;
  try {
    o = parseArgs(process.argv.slice(2));
    portal = f.portalClient({ url: process.env.PORTAL_URL, code: process.env.PORTAL_SERVER_CODE });
  } catch (e) {
    process.stderr.write(`factory-round: ${e.message}\nusage: factory-round.mjs [--apply] [--wip N] [--budget N] [--stale-min N] [--workspace W] [--repo DIR] [--base REF] [--worktrees DIR]\n`);
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = o.repo ?? join(here, '../..');
  const base = o.base ?? 'origin/integration';
  const models = f.modelsFrom((r) => readFileSync(join(here, '../../.claude/agents', `${r}.md`), 'utf8'), ['implementer', 'reviewer', 'qa-verifier']);
  try {
    const { lines } = await runRound({ portal, git: f.gitOps(repo), changed: gitChanged(repo, base), models, now: Date.now(), apply: o.apply, wip: o.wip, budget: o.budget, workspace: o.workspace, base, staleMin: o.staleMin, worktrees: o.worktrees });
    process.stdout.write(`${lines.join('\n')}\n`);
  } catch (e) {
    // The message carries a method, a path and a status (portalClient never puts the code or the cookie in one).
    process.stdout.write(`EXCEPTION factory: round failed: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
