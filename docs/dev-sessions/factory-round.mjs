#!/usr/bin/env node
// One round of the factory engine (T-293 slice 3), the entry a supervisor hook runs (every few minutes or on a CI event) and the coordinator
// reads. A SEPARATE script on purpose: supervisor.mjs does not call it (an independent reviewer reads the engine before it runs unattended).
// It calls no model; it starts sessions ONLY with --apply --start (off by default: factory.mjs startSlice, non-Bypass, mode dontAsk) and then
// also watches their budget (watchBudget). It reads the portal, plans, and prints one line per thing to do:
//   node docs/dev-sessions/factory-round.mjs [--apply [--start --workspace W --repo-id ID [--report-to SESSION] [--session ID]]] [--wip 5]
//        [--budget N] [--workspace W] [--repo DIR] [--base REF] [--stale-min 360] [--worktrees DIR] [--lock FILE]
//   --apply takes the host's engine lock (factory.mjs engineLock; a live holder: one EXCEPTION line, exit 3). --start makes worktrees in the
//   workspace through the portal (worktree_create on --repo-id), never with local git, and leases a token under this round's own label.
//   PORTAL_URL (default https://pilot.ai.isnan.me) and PORTAL_SERVER_CODE: the supervisor's auth path; the cookie stays in memory, never printed.
// Output (stdout), one line each:
//   factory-round: <summary>
//   DISPATCH <id> ...                  intake's plan (dry: "would"; --apply: the result of applyPlan)
//   RESUME <id> run=<r> next=<step>    a finished CI run of a dispatch (--apply writes the FACTORY RESUME marker; dry says "would")
//   START <id> <started|adopted|skipped|refused|failed> [session <sid>][: why]   --start: the slice's worker session
//   BUDGET <id> over: <measure> ...    --start: a measure of the slice's session past 100 percent of its size's budget (factory.mjs
//                                      watchBudget: wall minutes and transcript events move mid-turn, cost_usd only at a turn's end; at 150
//                                      percent of any one it is interrupted and stopped: an EXCEPTION line)
//   NEXT <ticket> <id> <step> <role>/<model>: <why>   the step a role runs now (review, verify, fix) or the coordinator (integrate)
//   LEARN <id>: wrote | would comment  followed by the ACTUAL text, indented: --apply writes it (it ends the dispatch), dry prints it
//   EXCEPTION <ticket> <id>: <why>     the coordinator's: stale, cancelled, out of order, conflict, rework limit, budget stop, held after a
//                                      stop or failure (a signed-in ui writer writes FACTORY RETRY <id>), refused, a session gone
//                                      (END failed: session gone) and errors (one ticket's error is its own line; the round goes on)
// Exit: 0 after a round (exceptions are lines, not a failure), 1 when the portal could not be read (an EXCEPTION line says so), 2 usage.
// Ticket text is untrusted data and is not printed: lines carry ids, states and the engine's own words.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenLease } from '../../tools/coordinator/tokenLease.mjs';
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

/** The first line of an error, cut (portalClient and mcpClient errors carry a method, a path, a status or a tool code; never a secret). */
const oneLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160);

/**
 * One round: intake (and with apply, applyPlan), then for every ticket with an open dispatch its pending CI resumes and its next step.
 * deps: { portal, git (gitOps, needed with apply), changed (branch -> paths | null), models, now (epoch ms), apply, wip, budget, workspace,
 * base, staleMin }. Returns { lines, exceptions } and writes nothing but the DISPATCH comments (applyPlan), RESUME markers and the ACTUAL of
 * a merged dispatch when apply (and with start/watch their START and END markers).
 */
export async function runRound(deps) {
  const { portal, now, apply = false } = deps;
  if (!Number.isFinite(now)) throw new Error('runRound needs now (epoch ms)');
  const lines = [];
  const exceptions = [];
  const except = (ticket, id, reason) => exceptions.push({ ticket, dispatchId: id ?? null, reason });
  // The busy tickets (in progress, in review, blocked: f.BUSY) are read whole too: their dispatches, step markers and CI checks are the state
  // of the slices in flight, and their started sessions stay in the budget watch.
  const listed = await f.fetchTickets(portal, { workspace: deps.workspace });
  const tickets = [];
  for (const t of listed) tickets.push(f.BUSY.has(t.status) && !(t.comments || t.events) ? await portal.get(t.id) : t);
  const plan = f.intake(tickets, { wip: deps.wip, budget: deps.budget, models: deps.models, worktrees: deps.worktrees, now, staleMin: deps.staleMin });
  for (const x of plan.exceptions) except(x.ticket, x.dispatchId, x.reason);
  // --start (deps.start and deps.watch, only with apply): sessions for the slices; without them nothing is started.
  const start = apply ? (deps.start ?? null) : null;
  const watch = apply ? (deps.watch ?? null) : null;
  const startLine = (id, s) => `START ${id} ${s.action}${s.sessionId ? ` session ${s.sessionId}` : ''}${s.reason ? `: ${s.reason}` : ''}`;
  if (apply) {
    const applied = await f.applyPlan({ ...plan, exceptions: [] }, { portal, git: deps.git, base: deps.base, start });
    for (const r of applied.results) {
      lines.push(`DISPATCH ${r.dispatchId} ${r.action}${r.reason ? `: ${r.reason}` : ` ${r.branch}`}`);
      if (r.start) lines.push(startLine(r.dispatchId, r.start));
    }
    for (const x of applied.exceptions) except(x.ticket, x.dispatchId, x.reason);
  } else {
    for (const d of plan.dispatch) lines.push(`DISPATCH ${d.dispatchId} would: ${d.size} ${d.role}/${d.model} ${d.branch}`);
  }
  let next = 0;
  for (const raw of tickets) {
    const t = f.normalizeTicket(raw);
    if (!f.dispatchesOf(t).some((d) => !d.ended)) continue;
    if (start || watch) {
      const open = f.dispatchesOf(t).filter((d) => !d.ended);
      const last = open[open.length - 1];
      if (!f.startsOf(t).has(last.id)) {
        // An open dispatch without a session (the engine stopped after the worktree): started now, unless intake already called it stale.
        if (start && !exceptions.some((x) => x.dispatchId === last.id)) {
          // Role, model, branch and budget re-derived (dispatchFrom), never read from the marker; one that does not derive is an exception.
          let d = null;
          try {
            d = f.dispatchFrom(t, last, { worktrees: deps.worktrees, models: deps.models });
          } catch (e) {
            except(t.id, last.id, `not started: ${e.message}`);
          }
          if (d) {
            // One ticket's error is that ticket's EXCEPTION line, never the round's end (N1): the tickets after it are still started/watched.
            let s = null;
            try {
              s = await start(d);
            } catch (e) {
              except(t.id, last.id, `not started: ${oneLine(e)}`);
            }
            if (s) {
              lines.push(startLine(last.id, s));
              for (const x of s.exceptions ?? []) except(x.ticket, x.dispatchId, x.reason);
            }
          }
        }
      } else if (watch) {
        let w;
        try {
          w = await watch(raw);
        } catch (e) {
          except(t.id, last.id, `budget not watched this round: ${oneLine(e)}`);
          continue; // unknown state: no next step this round either
        }
        for (const x of w.exceptions ?? []) except(x.ticket, x.dispatchId, x.reason);
        if (w.action === 'over') lines.push(`BUDGET ${last.id} over: ${w.over.join('; ')}`);
        if (w.action === 'stopped' || w.action === 'gone') continue; // the dispatch has ended: no next step
        if (w.action === 'error') continue; // not watched this round: no next step either
      }
    }
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
      markers.push({ kind: 'comment', at: new Date(now).toISOString(), text: marker, actor: f.ENGINE_ACTOR, fromAgent: false }); // the engine's own, as written
    }
    const withMarkers = { ...t, comments: [...t.comments, ...markers] };
    const open = f.dispatchesOf(t).filter((d) => !d.ended);
    const branch = open[open.length - 1]?.branch;
    const s = f.nextStep(withMarkers, { models: deps.models, changedPaths: branch && deps.changed ? deps.changed(branch) : undefined });
    if (s.step === 'exception') except(t.id, s.dispatchId, s.reason);
    else if (s.step === 'learn') {
      // LEARN (T-342): --apply writes the ACTUAL comment (the engine's own counts, no ticket text); it ends the dispatch, so the next round
      // finds nothing to learn and writes it never twice. Dry prints it.
      if (apply) await portal.comment(t.id, s.actual);
      lines.push(`LEARN ${s.dispatchId}: ${apply ? 'wrote' : 'would comment'}`, ...s.actual.split('\n').map((l) => `  ${l}`));
    }
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
    else if (a === '--start') o.start = true;
    else if (a === '--report-to') o.reportTo = val();
    else if (a === '--session') o.session = val();
    else if (a === '--repo-id') o.repoId = val();
    else if (a === '--lock') o.lock = val();
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.start && !o.apply) throw new Error('--start needs --apply');
  if (o.start && !o.workspace) throw new Error('--start needs --workspace (the workspace the worker sessions run in)');
  if (o.start && !o.repoId) throw new Error('--start needs --repo-id (the repository in the workspace its worktrees are made from: repos_list)');
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
  const now = Date.now();
  // --apply: one writing run per host (M1: the same lock as factory.mjs). --start: an admin Portal MCP token leased for this round under its
  // own label (15 minutes, renewed while the round lasts, revoked at the end and on SIGINT/SIGTERM; a round killed hard leaves it alive at
  // most 15 minutes), held in memory and never printed; worktrees made through the portal.
  let lock = null;
  if (o.apply) {
    try {
      lock = f.engineLock(o.lock ?? f.DEFAULT_LOCK);
    } catch (e) {
      process.stdout.write(`EXCEPTION factory: round not run: ${e.message}\n`);
      process.exit(3);
    }
  }
  const lease = o.start ? tokenLease({ api: portal.raw, label: f.leaseLabel(), lifetime: f.SHORT_LEASE_LIFETIME }) : null;
  const unhook = f.onStop(async () => { await lease?.revoke(); lock?.release(); });
  let sessions = {};
  let git = f.gitOps(repo);
  if (lease) {
    const mcp = f.mcpClient({ url: portal.url, token: lease.get, tokenId: () => lease.id });
    const wt = f.portalWorktrees({ mcp, workspace: o.workspace, repoId: o.repoId });
    git = wt;
    const template = readFileSync(join(here, 'factory-brief.md'), 'utf8');
    const tokenDiscipline = f.tokenRules(readFileSync(join(here, 'token-discipline.md'), 'utf8'));
    const reportTo = o.reportTo ?? null;
    sessions = {
      start: f.starter({ portal, mcp, workspace: o.workspace, locate: wt.find, template, tokenDiscipline, session: o.session ?? process.env.PILOT_SESSION ?? 'unset', reportTo, now, staleMin: o.staleMin }),
      watch: (raw) => f.watchBudget(raw, { portal, mcp, reportTo, worktrees: o.worktrees, models, now }),
    };
  }
  let rc = 0;
  try {
    const { lines } = await runRound({ portal, git, changed: gitChanged(repo, base), models, now, apply: o.apply, wip: o.wip, budget: o.budget, workspace: o.workspace, base, staleMin: o.staleMin, worktrees: o.worktrees, ...sessions });
    process.stdout.write(`${lines.join('\n')}\n`);
  } catch (e) {
    // The message carries a method, a path and a status (portalClient and mcpClient never put the code, the cookie or the token in one).
    process.stdout.write(`EXCEPTION factory: round failed: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}\n`);
    rc = 1;
  } finally {
    await lease?.revoke();
    lock?.release();
    unhook();
  }
  process.exit(rc);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
