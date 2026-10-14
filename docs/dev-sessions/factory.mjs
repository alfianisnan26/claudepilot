#!/usr/bin/env node
// The factory engine v0 (T-293, design v2 layer 3: docs/dev-sessions/overhaul/token-economy-design.md sections 3 and 4): orchestration as
// code, judgment as agents. A sibling of supervisor.mjs. It STARTS NO SESSION and calls no model (the Bypass lease is the owner's open decision).
//   node docs/dev-sessions/factory.mjs (--tickets <file.json|-> | --portal [--apply]) [--wip 5] [--budget <requests>] [--role implementer]
//        [--session <id>] [--worktrees <dir>] [--workspace <id>] [--repo <dir>] [--base origin/integration] [--stale-min 360] [--json] [--briefs]
// Without --apply it prints what it WOULD dispatch and writes nothing. --portal reads the open and in-progress tickets from the portal (the
// ranked open ones whole) with the supervisor's auth path: PORTAL_URL and PORTAL_SERVER_CODE, a sign-in cookie in memory, never printed.
// --apply (needs --portal) per planned dispatch reads the ticket again, refuses a branch or folder that exists, writes the FACTORY DISPATCH
// comment and creates the worktree and branch `ticket/T-n-slug` from --base; an open dispatch past --stale-min is an EXCEPTION line for the
// coordinator, never dispatched again. The tickets are portal data: an array of TicketItem, a TicketList ({ items }), or TicketDetail
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
//   resumeDecision(t, ev, o)    what a CI event means for the ticket's latest dispatch: resume (passed -> review, failed -> fix, with the
//                               FACTORY RESUME marker that makes the same event a no-op next time), exception (stale, cancelled) or ignore.
//   pendingResumes(detail, o)   the same for a TicketDetail's CI checks: what a restarted engine still has to do.
//   applyPlan(plan, deps)       the --apply step with the portal and git injected (portalClient, gitOps).
//   nextStep(t, opts)           what comes next for the open dispatch from its markers alone: wait, fix, review (sonnet on the diff; opus for
//                               sensitive or unknown paths, reviewModel), verify, integrate, learn (with learnText: the ACTUAL comment and one
//                               LESSON line), or an exception (out of order, conflict, rework limit, budget stop). stepMarker writes the markers.
// One round for a supervisor hook: docs/dev-sessions/factory-round.mjs (prints NEXT and EXCEPTION lines; not wired into supervisor.mjs yet).
//
// State lives in the portal's tickets only, as comments whose first line is a marker the engine writes and reads back:
//   FACTORY DISPATCH <dispatchId> role=<role> model=<model> size=<S|M|L> budget=<n> branch=<branch>
//   FACTORY END <dispatchId> <outcome>
//   FACTORY RESUME <dispatchId> run=<runId> state=<state> next=<review|fix>
//   FACTORY REVIEW <dispatchId> verdict=<pass|changes>   FACTORY VERIFY <dispatchId> verdict=<pass|sendback>
//   FACTORY INTEGRATE <dispatchId> result=<merged|conflict> [commit=<sha>]
// An ACTUAL comment ends every dispatch before it. A ticket with a DISPATCH and no END or ACTUAL has an open dispatch: it counts as in flight and is never dispatched again (the double-dispatch guard).
// Dispatch ids are `<ticket>-F<n>` (n = the ticket's earlier dispatches + 1), so a restart computes the same ids from the same tickets.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
    // An ACTUAL comment (the slice's closing record) ends every dispatch before it that is still open.
    else if (/^ACTUAL\b/.test(first)) for (const d of list) if (!ended.has(d.id)) ended.set(d.id, 'actual');
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
 * implementer), models ({ role: model }), worktrees (the folder worktrees go in), now (epoch ms; without it nothing is stale), staleMin (an open
 * dispatch older than this is an exception for the coordinator, default 360). Returns { dispatch, skipped, exceptions, inFlight, wip, budget, stopped }.
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
  const staleMin = opts.staleMin ?? DEFAULT_RESUME_MAX_AGE_MIN;
  const dispatch = [];
  const skipped = [];
  const exceptions = [];
  let planned = 0;
  let stopped = null;
  // A dispatch open past the limit is the coordinator's to look at (one line); it is never dispatched again by the engine. Its own pass: the
  // plan below stops at the WIP or budget limit, and a stale dispatch ranked after the stop must still be reported.
  for (const { t } of ranked) {
    for (const d of openDispatches(t)) {
      const age = ageMin(d.at, opts.now);
      if (age !== null && age > staleMin) exceptions.push({ ticket: t.id, dispatchId: d.id, reason: `stale dispatch ${d.id}: open ${age} min (limit ${staleMin}), no END and no ACTUAL` });
    }
  }
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
  return { dispatch, skipped, exceptions, inFlight, wip, budget: { limit: Number.isFinite(limit) ? limit : null, planned }, stopped };
}

/** Whole minutes from `at` (ISO) to `now` (epoch ms); null without a clock or a time. */
function ageMin(at, now) {
  const t = Date.parse(at);
  return Number.isFinite(now) && Number.isFinite(t) ? Math.floor((now - t) / 60000) : null;
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
export function formatPlan(plan, mode = 'dry run') {
  const lines = [`factory (${mode}): ${plan.dispatch.length} to dispatch; in flight ${plan.inFlight.length} of ${plan.wip}; requests ${plan.budget.planned} of ${plan.budget.limit ?? 'no limit'}`];
  for (const d of plan.dispatch) lines.push(`  would dispatch ${d.dispatchId} ${d.rank} size ${d.size} budget ${d.budget} (stop at ${d.stopAt}) ${d.role}/${d.model} ${d.branch}`);
  for (const s of plan.skipped) lines.push(`  skip ${s.ticket}: ${s.reason}`);
  for (const x of plan.exceptions ?? []) lines.push(`  EXCEPTION ${x.ticket}: ${x.reason}`);
  if (plan.stopped) lines.push(`  stopped: ${plan.stopped}`);
  return lines.join('\n');
}

/* ---------- The portal (the supervisor's auth path: PORTAL_URL and PORTAL_SERVER_CODE, a sign-in cookie held in memory) ---------- */

/**
 * A small portal client: POST /api/login with the code, then the REST API with the session cookie. Same path as supervisor.mjs; no new
 * credential. The code and the cookie never appear in an error, a log line or the output: errors carry the method, the path and the status.
 */
export function portalClient({ url = 'https://pilot.ai.isnan.me', code, fetch: f = globalThis.fetch } = {}) {
  if (!code) throw new Error('PORTAL_SERVER_CODE is not set');
  const base = String(url).replace(/\/$/, '');
  let cookie = '';
  async function login() {
    const res = await f(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ code }) });
    if (!res.ok) throw new Error(`sign-in refused (${res.status})`);
    cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    if (!cookie) throw new Error('sign-in gave no session');
  }
  async function api(method, path, body) {
    for (let attempt = 1; ; attempt++) {
      if (!cookie) await login();
      const res = await f(`${base}${path}`, { method, headers: { 'content-type': 'application/json', origin: base, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (res.status === 401 && attempt < 2) { cookie = ''; continue; }
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { /* a proxy page */ }
      if (!res.ok || !json || json.error) throw new Error(`${method} ${path.split('?')[0]}: ${json?.error?.code ?? res.status}`);
      return json.data;
    }
  }
  const one = (id) => `/api/tickets/${encodeURIComponent(id)}`;
  return {
    list: (query) => api('GET', `/api/tickets?${query}`),
    get: (id) => api('GET', one(id)),
    comment: (id, text) => api('POST', `${one(id)}/comments`, { text }),
  };
}

/** The tickets intake needs, from the portal: open and in-progress ones; the ranked open ones read whole (their comments). */
export async function fetchTickets(portal, { workspace } = {}) {
  const q = new URLSearchParams({ status: 'open,in_progress', limit: '500' });
  if (workspace) q.set('workspace', workspace);
  const list = await portal.list(q.toString());
  const out = [];
  for (const it of list?.items ?? []) {
    const ranked = (it.tags ?? []).some((g) => /^rank-\d+[a-z]*$/.test(g));
    out.push(it.status === 'open' && ranked ? await portal.get(it.id) : it); // in progress counts against WIP; its comments are not needed
  }
  return out;
}

/* ---------- Apply: the dispatch comment and the worktree (no session is started) ---------- */

/** Git in the main folder: whether the branch or the folder is taken, and `worktree add -b` (which refuses an existing branch itself). */
export function gitOps(repo, run = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  const has = (ref) => { try { run(['show-ref', '--verify', '--quiet', ref]); return true; } catch { return false; } };
  return {
    taken(branch, worktree) {
      if (has(`refs/heads/${branch}`)) return `branch ${branch} exists`;
      if (has(`refs/remotes/origin/${branch}`)) return `branch ${branch} exists on origin`;
      if (existsSync(resolve(repo, worktree))) return `folder ${worktree} exists`;
      return null;
    },
    addWorktree(branch, worktree, base) { run(['worktree', 'add', '-b', branch, resolve(repo, worktree), base]); },
  };
}

/**
 * Carry out a plan: per planned dispatch, read the ticket again (another run may have taken it), refuse a branch or folder that exists,
 * write the FACTORY DISPATCH comment (the state, in the portal only), then create the worktree and branch from `base`. A worktree that fails
 * after the comment gets a FACTORY END ... failed comment, so the ticket is free again and nothing is left half done. Starts no session.
 * Returns { results: [{ ticket, dispatchId, action: dispatched|skipped|refused|failed, reason? }], exceptions } (the plan's and its own).
 */
export async function applyPlan(plan, { portal, git, base = 'origin/integration' }) {
  const results = [];
  const exceptions = [...(plan.exceptions ?? [])];
  for (const d of plan.dispatch) {
    const r = { ticket: d.ticket, dispatchId: d.dispatchId };
    const fresh = normalizeTicket(await portal.get(d.ticket));
    const open = openDispatches(fresh);
    if (fresh.status !== 'open' || open.length) {
      results.push({ ...r, action: 'skipped', reason: open.length ? `dispatched since the plan (${open.map((x) => x.id).join(', ')})` : `now ${fresh.status}` });
      continue;
    }
    if (`${fresh.id}-F${dispatchesOf(fresh).length + 1}` !== d.dispatchId) { results.push({ ...r, action: 'skipped', reason: 'changed since the plan' }); continue; }
    const taken = git.taken(d.branch, d.worktree);
    if (taken) {
      results.push({ ...r, action: 'refused', reason: taken });
      exceptions.push({ ticket: d.ticket, dispatchId: d.dispatchId, reason: `not dispatched: ${taken}` });
      continue;
    }
    await portal.comment(d.ticket, dispatchMarker(d));
    try {
      git.addWorktree(d.branch, d.worktree, base);
      results.push({ ...r, action: 'dispatched', branch: d.branch, worktree: d.worktree });
    } catch (e) {
      const why = String(e?.stderr || e?.message || e).split('\n').find(Boolean)?.slice(0, 160) ?? 'error';
      await portal.comment(d.ticket, `FACTORY END ${d.dispatchId} failed: worktree (${why})`);
      results.push({ ...r, action: 'failed', reason: why });
      exceptions.push({ ticket: d.ticket, dispatchId: d.dispatchId, reason: `worktree failed: ${why}` });
    }
  }
  return { results, exceptions };
}

/* ---------- Resume on a CI event (pure) ---------- */

const ENDED_RUN = new Set(['passed', 'failed', 'cancelled']);

/** `<dispatchId> <runId>` of every FACTORY RESUME comment: the events already handled. */
function resumedOf(t) {
  const out = new Set();
  for (const c of t.comments) {
    const m = /^FACTORY RESUME (\S+) run=(\S+)/.exec(c.text.split('\n', 1)[0].trim());
    if (m) out.add(`${m[1]} ${m[2]}`);
  }
  return out;
}

/**
 * What the engine does with a CI event for a ticket: { action: 'resume', dispatch, next, marker } | { action: 'exception', reason } |
 * { action: 'ignore', reason }. event: { runId, state (queued|running|passed|failed|cancelled), check?, branch?, at? }. The event belongs to
 * the ticket's latest dispatch: another branch, an event from before the dispatch, a run still going, an ended dispatch, a closed ticket, or an
 * event already handled (a FACTORY RESUME comment with its run) is ignored. A stale dispatch, a dispatch without a time, or a cancelled run is
 * an exception for the coordinator. passed -> next 'review'; failed -> next 'fix' (back to the implementer). The caller writes `marker` as a
 * comment when it acts, which makes the same event a no-op the next time.
 */
export function resumeDecision(rawTicket, event, { now, maxAgeMin = DEFAULT_RESUME_MAX_AGE_MIN } = {}) {
  if (!Number.isFinite(now)) throw new Error('resumeDecision needs now (epoch ms)');
  const t = normalizeTicket(rawTicket);
  const all = dispatchesOf(t);
  const d = all[all.length - 1];
  const ignore = (reason) => ({ action: 'ignore', reason });
  if (!d) return ignore('no dispatch');
  if (!event?.runId) return ignore('no run');
  if (event.branch && d.branch && event.branch !== d.branch) return ignore(`another branch (${event.branch})`);
  if (event.at && Date.parse(event.at) < Date.parse(d.at)) return ignore(`run ${event.runId} is from before ${d.id}`);
  if (!ENDED_RUN.has(event.state)) return ignore(`run ${event.runId} ${event.state ?? 'unknown'}: wait for its end`);
  if (resumedOf(t).has(`${d.id} ${event.runId}`)) return ignore(`run ${event.runId} already handled for ${d.id}`);
  const chk = resumeCheck(t, d.id, { now, maxAgeMin });
  if (!chk.ok) return /^stale|has no time$/.test(chk.reason) ? { action: 'exception', reason: chk.reason } : ignore(chk.reason);
  if (event.state === 'cancelled') return { action: 'exception', reason: `run ${event.runId} cancelled for ${d.id}` };
  const next = event.state === 'passed' ? 'review' : 'fix';
  return { action: 'resume', dispatch: chk.dispatch, next, marker: `FACTORY RESUME ${d.id} run=${event.runId} state=${event.state} next=${next}` };
}

/** After a restart: the decisions for a TicketDetail's CI checks (latest state per check), without the ignored ones. */
export function pendingResumes(detail, opts) {
  return (detail?.checks ?? [])
    .map((c) => ({ check: c.name, decision: resumeDecision(detail, { runId: c.runId, state: c.state, check: c.name, at: c.updatedAt }, opts) }))
    .filter((x) => x.decision.action !== 'ignore');
}

/* ---------- The steps after the implementer: REVIEW, VERIFY, INTEGRATE, LEARN (pure) ---------- */

/** Paths whose review needs opus (authz, secrets, migrations, Bypass code, the project settings): the `needsPerson` areas of D-44. */
const SENSITIVE = /(^|\/)(authz|secrets)(\/|\.|$)|(^|\/)migrations[^/]*$|bypass|(^|\/)\.claude\/settings/i;
export const MAX_RED_RUNS = 3;
export const MAX_SEND_BACKS = 2;
const VERDICTS = Object.freeze({ REVIEW: ['pass', 'changes'], VERIFY: ['pass', 'sendback'], INTEGRATE: ['merged', 'conflict'] });

/** The model a review of these changed paths gets: opus when one is sensitive OR the paths are unknown (the safe side), else the role's model. */
export function reviewModel(paths, roleModel = 'sonnet') {
  if (!Array.isArray(paths)) return 'opus';
  return paths.some((p) => SENSITIVE.test(String(p))) ? 'opus' : roleModel;
}

/**
 * The marker a step writes when it ends: `FACTORY REVIEW <id> verdict=pass|changes`, `FACTORY VERIFY <id> verdict=pass|sendback`,
 * `FACTORY INTEGRATE <id> result=merged commit=<sha>|result=conflict`. An unknown kind or verdict throws (writer and reader stay in step).
 */
export function stepMarker(kind, dispatchId, verdict, extra = {}) {
  const allowed = VERDICTS[kind];
  if (!allowed) throw new Error(`unknown step ${kind}`);
  if (!allowed.includes(verdict)) throw new Error(`${kind} takes ${allowed.join(' or ')}, not ${verdict}`);
  const key = kind === 'INTEGRATE' ? 'result' : 'verdict';
  const more = Object.entries(extra).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => ` ${k}=${String(v).replace(/\s+/g, '-')}`).join('');
  return `FACTORY ${kind} ${dispatchId} ${key}=${verdict}${more}`;
}

/** The step markers (RESUME, REVIEW, VERIFY, INTEGRATE) of one dispatch, oldest first: { kind, at, fields }. */
function stepsOf(t, dispatchId) {
  const out = [];
  for (const c of t.comments) {
    const m = /^FACTORY (RESUME|REVIEW|VERIFY|INTEGRATE) (\S+)(.*)$/.exec(c.text.split('\n', 1)[0].trim());
    if (m && m[2] === dispatchId) out.push({ kind: m[1], at: c.at, fields: Object.fromEntries([...m[3].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]])) });
  }
  return out;
}

/**
 * What the engine does next for a ticket's open dispatch, from its comments alone (a restart computes the same):
 *   { step, ticket, dispatchId?, role?, model?, reason, counts, actual?, lesson? }
 * step: none (no open dispatch or a closed ticket) | wait (no CI result yet) | fix (a red run, review changes or a send-back: back to the
 * implementer) | review (a green run) | verify (review passed) | integrate (verify passed) | learn (merged: `actual` and `lesson` are the text
 * the engine writes, which ends the dispatch) | exception (the coordinator's: a marker out of order, a merge conflict, the rework limit, the
 * request budget at its stop). opts: models ({ role: model }), changedPaths (for the review model), used (requests so far), maxRedRuns,
 * maxSendBacks. A green run after a red one goes back to review; a marker of another dispatch is not read.
 */
export function nextStep(rawTicket, opts = {}) {
  const t = normalizeTicket(rawTicket);
  const models = opts.models ?? {};
  const counts = { runs: 0, red: 0, reviews: 0, changes: 0, sendBacks: 0 };
  const base = { ticket: t.id, counts };
  if (CLOSED.has(t.status)) return { ...base, step: 'none', reason: `ticket is ${t.status}` };
  const open = openDispatches(t);
  const d = open[open.length - 1];
  if (!d) return { ...base, step: 'none', reason: 'no open dispatch' };
  const at = { ...base, dispatchId: d.id };
  const exception = (reason) => ({ ...at, step: 'exception', reason });
  let stage = 'ci';
  let merged = null;
  for (const s of stepsOf(t, d.id)) {
    if (s.kind === 'RESUME') {
      if (s.fields.state === 'failed') { counts.runs++; counts.red++; stage = 'fix'; }
      else if (s.fields.state === 'passed') { counts.runs++; if (stage === 'ci' || stage === 'fix') stage = 'review'; }
      continue;
    }
    const want = { REVIEW: 'review', VERIFY: 'verify', INTEGRATE: 'integrate' }[s.kind];
    const verdict = s.kind === 'INTEGRATE' ? s.fields.result : s.fields.verdict;
    if (stage !== want) return exception(`out of order: ${s.kind} ${verdict ?? '?'} while the dispatch is at ${stage}`);
    if (!VERDICTS[s.kind].includes(verdict)) return exception(`${s.kind} with an unknown verdict ${verdict ?? '(none)'}`);
    if (s.kind === 'REVIEW') { counts.reviews++; if (verdict === 'pass') stage = 'verify'; else { counts.changes++; stage = 'fix'; } }
    else if (s.kind === 'VERIFY') { if (verdict === 'pass') stage = 'integrate'; else { counts.sendBacks++; stage = 'fix'; } }
    else if (verdict === 'merged') { stage = 'learn'; merged = { at: s.at, commit: s.fields.commit ?? null }; }
    else return exception(`merge conflict on ${d.branch ?? d.id}: the coordinator resolves it`);
  }
  if (stage === 'learn') return { ...at, step: 'learn', role: 'engine', reason: `merged${merged.commit ? ` ${merged.commit}` : ''}`, ...learnText(t, d, counts, { mergedAt: merged.at, commit: merged.commit, used: opts.used }) };
  if (Number.isFinite(opts.used) && d.size in SIZE_BUDGET && sliceBudget(d.size, opts.used).state === 'stop') {
    return exception(`request budget: ${opts.used} of ${d.budget} (stop at ${sliceBudget(d.size).stopAt}): stopped, not continued`);
  }
  const maxRed = opts.maxRedRuns ?? MAX_RED_RUNS;
  const maxBack = opts.maxSendBacks ?? MAX_SEND_BACKS;
  if (stage === 'fix' && counts.red > maxRed) return exception(`rework limit: ${counts.red} red CI runs (limit ${maxRed})`);
  if (stage === 'fix' && counts.changes + counts.sendBacks > maxBack) return exception(`rework limit: ${counts.changes + counts.sendBacks} send-backs from review and verify (limit ${maxBack})`);
  if (stage === 'ci') return { ...at, step: 'wait', reason: `no CI result yet on ${d.branch ?? d.id}` };
  if (stage === 'fix') return { ...at, step: 'fix', role: d.role ?? 'implementer', model: d.model ?? models.implementer ?? 'unset', reason: counts.sendBacks || counts.changes ? `sent back (${counts.changes} review, ${counts.sendBacks} verify)` : `red CI run (${counts.red})` };
  if (stage === 'review') return { ...at, step: 'review', role: 'reviewer', model: reviewModel(opts.changedPaths, models.reviewer ?? 'sonnet'), reason: `green CI run; diff only${Array.isArray(opts.changedPaths) ? '' : ' (changed paths unknown: opus)'}` };
  if (stage === 'verify') return { ...at, step: 'verify', role: 'qa-verifier', model: models['qa-verifier'] ?? 'sonnet', reason: 'review passed; evidence as files' };
  return { ...at, step: 'integrate', role: 'orchestrator', reason: 'verified: merge, quick gate, push integration, batch the deploy' };
}

/**
 * The LEARN text: the ACTUAL comment (first line ACTUAL, so it ends the dispatch) with ONE lesson line, built from the engine's own counts only
 * (no ticket text is copied). Elapsed is dispatch to merge (no clock). used: requests, when known; otherwise the comment says unknown.
 */
export function learnText(t, d, counts, { mergedAt, commit, used } = {}) {
  const ms = Date.parse(mergedAt) - Date.parse(d.at);
  const elapsed = Number.isFinite(ms) ? `${(ms / 3600000).toFixed(1)} h` : 'unknown';
  const firstPass = counts.red === 0 && counts.changes === 0 && counts.sendBacks === 0;
  const req = Number.isFinite(used) ? `${used} of ${d.budget} requests` : `requests unknown (budget ${d.budget})`;
  let lesson;
  if (counts.sendBacks) lesson = `${counts.sendBacks} send-back(s) at verify on a size ${d.size} slice: the brief's done criteria must name the evidence the verifier reads`;
  else if (counts.changes) lesson = `review asked for changes ${counts.changes} time(s): the implementer runs its own diff review before the push`;
  else if (counts.red) lesson = `${counts.red} red CI run(s) before green: scripts/slice-check.sh before the push`;
  else if (Number.isFinite(used) && used > d.budget) lesson = `first pass but over the size ${d.size} budget (${used} of ${d.budget}): the estimate was low`;
  else lesson = `first pass within the size ${d.size} budget: the estimate held`;
  lesson = `LESSON ${t.id}: ${lesson}`;
  const actual = [
    `ACTUAL (${d.id}, factory engine): size ${d.size}, ${req}; ${elapsed} from dispatch to merge${commit ? ` (${commit})` : ''}.`,
    `CI runs ${counts.runs} (${counts.red} red); review rounds ${counts.reviews} (${counts.changes} with changes); send-backs ${counts.sendBacks}; first pass ${firstPass ? 'yes' : 'no'}.`,
    lesson,
  ].join('\n');
  return { actual, lesson };
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
    else if (a === '--portal') o.portal = true;
    else if (a === '--apply') o.apply = true;
    else if (a === '--workspace') o.workspace = val();
    else if (a === '--repo') o.repo = val();
    else if (a === '--base') o.base = val();
    else if (a === '--stale-min') o.staleMin = num(val(), a);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.tickets === !o.portal) throw new Error('name one source: --tickets <file.json|-> or --portal');
  if (o.apply && !o.portal) throw new Error('--apply needs --portal (the state is read from the portal right before it is written)');
  return o;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`factory: ${e.message}\nusage: factory.mjs (--tickets <file.json|-> | --portal [--apply]) [--wip N] [--budget N] [--role R] [--session ID] [--worktrees DIR] [--workspace W] [--repo DIR] [--base REF] [--stale-min N] [--json] [--briefs]\n`);
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = join(here, '../..');
  let portal = null;
  let tickets;
  if (o.portal) {
    try {
      portal = portalClient({ url: process.env.PORTAL_URL, code: process.env.PORTAL_SERVER_CODE });
    } catch (e) {
      process.stderr.write(`factory: ${e.message}\n`);
      process.exit(2);
    }
    tickets = await fetchTickets(portal, { workspace: o.workspace });
  } else {
    const data = JSON.parse(o.tickets === '-' ? readFileSync(0, 'utf8') : readFileSync(o.tickets, 'utf8'));
    tickets = Array.isArray(data) ? data : (data.items ?? data.data?.items ?? []);
  }
  const role = o.role ?? 'implementer';
  const models = modelsFrom((r) => readFileSync(join(repo, '.claude/agents', `${r}.md`), 'utf8'), [role]);
  const plan = intake(tickets, { wip: o.wip, budget: o.budget, role, models, worktrees: o.worktrees, now: Date.now(), staleMin: o.staleMin });
  const template = readFileSync(join(here, 'factory-brief.md'), 'utf8');
  const tokenDiscipline = tokenRules(readFileSync(join(here, 'token-discipline.md'), 'utf8'));
  const session = o.session ?? process.env.PILOT_SESSION ?? 'unset';
  const briefs = o.briefs ? plan.dispatch.map((d) => ({ dispatchId: d.dispatchId, marker: dispatchMarker(d), brief: renderBrief(template, briefVars(d, { session, tokenDiscipline })) })) : [];
  const applied = o.apply ? await applyPlan(plan, { portal, git: gitOps(o.repo ?? repo), base: o.base }) : null;
  if (o.json) process.stdout.write(`${JSON.stringify({ ...plan, briefs, ...(applied ? { applied } : {}) }, null, 2)}\n`);
  else if (applied) {
    process.stdout.write(`${formatPlan({ ...plan, exceptions: applied.exceptions }, 'apply')}\n`);
    for (const r of applied.results) process.stdout.write(`  ${r.action} ${r.dispatchId}${r.reason ? `: ${r.reason}` : ` ${r.branch} ${r.worktree}`}\n`);
    for (const b of briefs) if (applied.results.some((r) => r.dispatchId === b.dispatchId && r.action === 'dispatched')) process.stdout.write(`\n--- ${b.dispatchId}: brief\n${b.brief}`);
  } else {
    process.stdout.write(`${formatPlan(plan)}\n`);
    for (const b of briefs) process.stdout.write(`\n--- ${b.dispatchId}: would comment "${b.marker}" and send:\n${b.brief}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
