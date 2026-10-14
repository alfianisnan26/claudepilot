#!/usr/bin/env node
// The factory engine v0 (T-293, design v2 layer 3: docs/dev-sessions/overhaul/token-economy-design.md sections 3 and 4): orchestration as
// code, judgment as agents. A sibling of supervisor.mjs. THIS SLICE IS DRY ONLY: no model call, no portal write, no worktree, no session.
//   node docs/dev-sessions/factory.mjs --tickets <file.json|-> [--wip 5] [--budget <requests>] [--role implementer] [--session <id>]
//                                      [--worktrees <dir>] [--json] [--briefs]
// prints what it WOULD dispatch. The tickets are portal data passed in: an array of TicketItem, a TicketList ({ items }), or TicketDetail
// objects ({ ticket, events }); MCP-shaped text ({ untrusted_text }) is read as text. Ticket text is untrusted data: it is copied into
// nothing but the plan's summary, and the brief tells the agent so.
//
// The pure functions (exported; tests in apps/server/src/qa/factory.test.ts):
//   intake(tickets, opts)       the plan: the next ranked tickets (a `rank-NN` tag) that are open, carry an ESTIMATE comment with a size
//                               S, M or L (XL is split first), within the WIP limit (in flight: in_progress tickets and open dispatches)
//                               and within the run's request budget. The first ticket over the budget STOPS the plan (it does not skip
//                               to a cheaper one: the rank order holds). Same input, same plan.
//   renderBrief(template, vars) the brief from docs/dev-sessions/factory-brief.md; an unfilled or unknown placeholder throws.
//   sliceBudget(size, used)     the request budget by size (S 25, M 60, L 120) and its state: ok, over (past 100 percent: report), stop
//                               (at 150 percent: stop and report, never continue silently).
//   resumeCheck(ticket, id, o)  whether a dispatch may be resumed (on a CI event): refused when the ticket is closed, the dispatch is
//                               unknown, ended or superseded by a newer one, or older than maxAgeMin (stale).
//
// State lives in the portal's tickets only, as comments whose first line is a marker the engine writes and reads back:
//   FACTORY DISPATCH <dispatchId> role=<role> model=<model> size=<S|M|L> budget=<n> branch=<branch>
//   FACTORY END <dispatchId> <outcome>
// A ticket with a DISPATCH and no END has an open dispatch: it counts as in flight and is never dispatched again (the double-dispatch guard).
// Dispatch ids are `<ticket>-F<n>` (n = the ticket's earlier dispatches + 1), so a restart computes the same ids from the same tickets.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIZE_BUDGET = Object.freeze({ S: 25, M: 60, L: 120 });
export const STOP_FACTOR = 1.5;
export const DEFAULT_WIP = 5;
export const DEFAULT_RESUME_MAX_AGE_MIN = 360;
const CLOSED = new Set(['done', 'wont_do']);

/** Portal MCP wraps outside text as { untrusted_text }; the REST API gives plain strings. */
const textOf = (v) => (v && typeof v === 'object' ? String(v.untrusted_text ?? '') : String(v ?? ''));

/** A ticket from any of the shapes the portal returns, with its comments as { at, text }, oldest first. */
export function normalizeTicket(raw) {
  const t = raw?.ticket && (raw.events || raw.comments) ? { ...raw.ticket, events: raw.events, comments: raw.comments } : raw;
  const entries = [...(t.comments ?? []), ...(t.events ?? [])].filter((e) => (e.kind ?? 'comment') === 'comment');
  const comments = entries.map((e) => ({ at: String(e.at ?? ''), text: textOf(e.body ?? e.text) })).sort((a, b) => a.at.localeCompare(b.at));
  const number = Number(t.number ?? String(t.id).replace(/^T-/, ''));
  return { id: String(t.id), number, status: String(t.status ?? 'open'), tags: (t.tags ?? []).map(String), summary: textOf(t.summary), comments };
}

/** The latest ESTIMATE comment's size (S, M, L or XL), or null. */
export function estimateOf(t) {
  for (const c of [...t.comments].reverse()) {
    if (!/^\s*ESTIMATE\b/.test(c.text)) continue;
    const m = /\bsize\s*:?\s*(XL|S|M|L)\b/i.exec(c.text);
    return { size: m ? m[1].toUpperCase() : null };
  }
  return null;
}

/** `rank-03b` -> [3, 'b']; no rank tag -> null. The lowest rank of several tags counts. */
export function rankOf(t) {
  const ranks = t.tags.map((g) => /^rank-(\d+)([a-z]*)$/.exec(g)).filter(Boolean).map((m) => [Number(m[1]), m[2]]);
  ranks.sort(cmpRank);
  return ranks[0] ?? null;
}
function cmpRank(a, b) {
  return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
}

/** The ticket's dispatch markers: every DISPATCH with its fields, whether an END closed it, oldest first. */
export function dispatchesOf(t) {
  const list = [];
  const ended = new Map();
  for (const c of t.comments) {
    const first = c.text.split('\n', 1)[0].trim();
    const d = /^FACTORY DISPATCH (\S+)(.*)$/.exec(first);
    if (d) {
      const fields = Object.fromEntries([...d[2].matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
      list.push({ id: d[1], at: c.at, ...fields });
      continue;
    }
    const e = /^FACTORY END (\S+)\s*(.*)$/.exec(first);
    if (e) ended.set(e[1], e[2] || 'ended');
  }
  return list.map((d) => ({ ...d, ended: ended.get(d.id) ?? null }));
}
const openDispatches = (t) => dispatchesOf(t).filter((d) => !d.ended);

/** `ticket/T-12-short-slug` from the summary (lowercase words, at most 40 characters). */
export function branchOf(t) {
  const slug = t.summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `ticket/${t.id}${slug ? `-${slug}` : ''}`;
}

/** The request budget of a slice by size and its state after `used` requests. */
export function sliceBudget(size, used = 0) {
  const budget = SIZE_BUDGET[size];
  if (!budget) throw new Error(`no budget for size ${size} (XL is split first)`);
  const stopAt = Math.ceil(budget * STOP_FACTOR);
  return { budget, stopAt, used, state: used >= stopAt ? 'stop' : used > budget ? 'over' : 'ok' };
}

/**
 * The plan of one run. opts: wip (in-flight limit, default 5), budget (requests this run may commit, default unlimited), role (default
 * implementer), models ({ role: model }), worktrees (the folder worktrees go in). Returns { dispatch, skipped, inFlight, wip, budget, stopped }.
 */
export function intake(rawTickets, opts = {}) {
  const wip = opts.wip ?? DEFAULT_WIP;
  const limit = opts.budget ?? Infinity;
  const role = opts.role ?? 'implementer';
  const model = opts.models?.[role] ?? 'unset';
  const worktrees = opts.worktrees ?? '../claudepilot.worktrees';
  const seen = new Set();
  const tickets = [];
  for (const raw of rawTickets) {
    const t = normalizeTicket(raw);
    if (seen.has(t.id)) continue; // the same ticket twice in the input is one ticket: never two dispatches
    seen.add(t.id);
    tickets.push(t);
  }
  const live = tickets.filter((t) => !CLOSED.has(t.status));
  const inFlight = live.filter((t) => t.status === 'in_progress' || openDispatches(t).length > 0).map((t) => t.id).sort();
  const ranked = live
    .map((t) => ({ t, rank: rankOf(t) }))
    .sort((a, b) => (a.rank && b.rank ? cmpRank(a.rank, b.rank) : a.rank ? -1 : b.rank ? 1 : 0) || a.t.number - b.t.number);
  const dispatch = [];
  const skipped = [];
  let planned = 0;
  let stopped = null;
  for (const { t, rank } of ranked) {
    const open = openDispatches(t);
    if (open.length) {
      skipped.push({ ticket: t.id, reason: `dispatched (${open.map((d) => d.id).join(', ')})` });
      continue;
    }
    if (t.status !== 'open') continue; // in progress, blocked or in review: someone has it; counted as in flight when in progress
    if (!rank) { skipped.push({ ticket: t.id, reason: 'no rank tag' }); continue; }
    const est = estimateOf(t);
    if (!est) { skipped.push({ ticket: t.id, reason: 'no ESTIMATE' }); continue; }
    if (!est.size) { skipped.push({ ticket: t.id, reason: 'ESTIMATE without a size' }); continue; }
    if (est.size === 'XL') { skipped.push({ ticket: t.id, reason: 'XL: split first' }); continue; }
    if (inFlight.length + dispatch.length >= wip) { stopped = `wip: ${inFlight.length + dispatch.length} of ${wip} in flight`; break; }
    const b = sliceBudget(est.size);
    if (planned + b.budget > limit) { stopped = `budget: ${t.id} needs ${b.budget} requests, ${limit - planned} of ${limit} left`; break; }
    planned += b.budget;
    const branch = branchOf(t);
    const n = dispatchesOf(t).length + 1;
    dispatch.push({ ticket: t.id, summary: t.summary, rank: `rank-${String(rank[0]).padStart(2, '0')}${rank[1]}`, size: est.size, budget: b.budget, stopAt: b.stopAt, role, model, branch, worktree: `${worktrees}/${branch.replace(/\//g, '-')}`, dispatchId: `${t.id}-F${n}` });
  }
  return { dispatch, skipped, inFlight, wip, budget: { limit: Number.isFinite(limit) ? limit : null, planned }, stopped };
}

/** The comment the dispatcher (a later slice) writes when it starts a slice: the marker this engine reads back. */
export function dispatchMarker(d) {
  return `FACTORY DISPATCH ${d.dispatchId} role=${d.role} model=${d.model} size=${d.size} budget=${d.budget} branch=${d.branch}`;
}

/** Fill {{name}} placeholders; a placeholder without a value, or a value the template does not use, throws (template and code stay in step). */
export function renderBrief(template, vars) {
  const used = new Set();
  const out = template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (vars[k] === undefined || vars[k] === null) throw new Error(`brief: no value for {{${k}}}`);
    used.add(k);
    return String(vars[k]);
  });
  const extra = Object.keys(vars).filter((k) => !used.has(k));
  if (extra.length) throw new Error(`brief: the template does not use ${extra.join(', ')}`);
  return out;
}

/** The brief's variables for one planned dispatch. */
export function briefVars(d, { session, contextPack = 'docs/context-pack.md', tokenDiscipline }) {
  return { ticket: d.ticket, summary: d.summary, dispatchId: d.dispatchId, role: d.role, model: d.model, contextPack, worktree: d.worktree, branch: d.branch, size: d.size, budget: d.budget, stopAt: d.stopAt, session, agent: `${d.role}-${d.dispatchId.toLowerCase()}`, tokenDiscipline };
}

/** The numbered rules of token-discipline.md (the block every brief carries). */
export function tokenRules(markdown) {
  return markdown.split('\n').filter((l) => /^\d+\. /.test(l)).join('\n');
}

/** May dispatch `dispatchId` of this ticket be resumed now? { ok: true, dispatch } or { ok: false, reason }. now: epoch ms. */
export function resumeCheck(rawTicket, dispatchId, { now, maxAgeMin = DEFAULT_RESUME_MAX_AGE_MIN } = {}) {
  if (!Number.isFinite(now)) throw new Error('resumeCheck needs now (epoch ms)');
  const t = normalizeTicket(rawTicket);
  if (CLOSED.has(t.status)) return { ok: false, reason: `ticket ${t.id} is ${t.status}` };
  const all = dispatchesOf(t);
  const i = all.findIndex((d) => d.id === dispatchId);
  if (i < 0) return { ok: false, reason: `unknown dispatch ${dispatchId}` };
  const d = all[i];
  if (d.ended) return { ok: false, reason: `dispatch ${dispatchId} ended (${d.ended})` };
  if (i < all.length - 1) return { ok: false, reason: `dispatch ${dispatchId} superseded by ${all[all.length - 1].id}` };
  const at = Date.parse(d.at);
  if (!Number.isFinite(at)) return { ok: false, reason: `dispatch ${dispatchId} has no time` };
  const ageMin = Math.floor((now - at) / 60000);
  if (ageMin > maxAgeMin) return { ok: false, reason: `stale: dispatch ${dispatchId} is ${ageMin} min old (limit ${maxAgeMin})` };
  return { ok: true, dispatch: d };
}

/** Role -> model from the agent definitions' frontmatter (.claude/agents/<role>.md). */
export function modelsFrom(read, roles) {
  const out = {};
  for (const r of roles) {
    try {
      const m = /^model:\s*(\S+)/m.exec(read(r));
      if (m) out[r] = m[1];
    } catch {
      // no definition: the plan says model=unset
    }
  }
  return out;
}

/** The plan as a few lines for a person or the orchestrator. */
export function formatPlan(plan) {
  const lines = [`factory (dry run): ${plan.dispatch.length} to dispatch; in flight ${plan.inFlight.length} of ${plan.wip}; requests ${plan.budget.planned} of ${plan.budget.limit ?? 'no limit'}`];
  for (const d of plan.dispatch) lines.push(`  would dispatch ${d.dispatchId} ${d.rank} size ${d.size} budget ${d.budget} (stop at ${d.stopAt}) ${d.role}/${d.model} ${d.branch}`);
  for (const s of plan.skipped) lines.push(`  skip ${s.ticket}: ${s.reason}`);
  if (plan.stopped) lines.push(`  stopped: ${plan.stopped}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const o = { json: false, briefs: false };
  const num = (v, f) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`${f} needs a number`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--tickets') o.tickets = val();
    else if (a === '--wip') o.wip = num(val(), a);
    else if (a === '--budget') o.budget = num(val(), a);
    else if (a === '--role') o.role = val();
    else if (a === '--session') o.session = val();
    else if (a === '--worktrees') o.worktrees = val();
    else if (a === '--json') o.json = true;
    else if (a === '--briefs') o.briefs = true;
    else throw new Error(`unknown argument ${a} (this engine is dry only)`);
  }
  if (!o.tickets) throw new Error('--tickets <file.json|-> is required');
  return o;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`factory: ${e.message}\nusage: factory.mjs --tickets <file.json|-> [--wip N] [--budget N] [--role R] [--session ID] [--worktrees DIR] [--json] [--briefs]\n`);
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = join(here, '../..');
  const data = JSON.parse(o.tickets === '-' ? readFileSync(0, 'utf8') : readFileSync(o.tickets, 'utf8'));
  const tickets = Array.isArray(data) ? data : (data.items ?? data.data?.items ?? []);
  const role = o.role ?? 'implementer';
  const models = modelsFrom((r) => readFileSync(join(repo, '.claude/agents', `${r}.md`), 'utf8'), [role]);
  const plan = intake(tickets, { wip: o.wip, budget: o.budget, role, models, worktrees: o.worktrees });
  const template = readFileSync(join(here, 'factory-brief.md'), 'utf8');
  const tokenDiscipline = tokenRules(readFileSync(join(here, 'token-discipline.md'), 'utf8'));
  const session = o.session ?? process.env.PILOT_SESSION ?? 'unset';
  const briefs = o.briefs ? plan.dispatch.map((d) => ({ dispatchId: d.dispatchId, marker: dispatchMarker(d), brief: renderBrief(template, briefVars(d, { session, tokenDiscipline })) })) : [];
  if (o.json) process.stdout.write(`${JSON.stringify({ ...plan, briefs }, null, 2)}\n`);
  else {
    process.stdout.write(`${formatPlan(plan)}\n`);
    for (const b of briefs) process.stdout.write(`\n--- ${b.dispatchId}: would comment "${b.marker}" and send:\n${b.brief}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
