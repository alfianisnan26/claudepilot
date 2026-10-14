#!/usr/bin/env node
// The factory engine v0 (T-293, design v2 layer 3: docs/dev-sessions/overhaul/token-economy-design.md sections 3 and 4): orchestration as
// code, judgment as agents. A sibling of supervisor.mjs. It calls no model itself. Without --start it starts no session; with --start (OFF by
// default, slice 4, D-49) it starts each slice it dispatched as a NON-Bypass worker session in mode dontAsk (startSlice below; never Bypass).
//   node docs/dev-sessions/factory.mjs (--tickets <file.json|-> | --portal [--apply [--start --workspace <id> --repo-id <id> [--report-to <session>]]])
//        [--wip 5] [--budget <requests>] [--role implementer] [--session <id>] [--worktrees <dir>] [--repo <dir>] [--base origin/integration]
//        [--stale-min 360] [--lock <file>] [--json] [--briefs]
// --apply takes the host's engine lock (--lock, default <tmp>/claudepilot-factory.lock; a live holder: exit 3). Without --start, --apply
// makes the worktree with local git in --repo (a run inside the pod); with --start, in the workspace through the portal (--repo-id).
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
//   startSlice(d, deps)         --start: the dispatched slice as a worker session through the admin Portal MCP tools (session_start, then
//                               session_configure mode dontAsk + the role's model, then session_send with the brief): fail closed, once per
//                               dispatch (FACTORY START marker), only for a dispatch of this engine version (v=) whose worktree the portal
//                               reports, never when stale. A session is adopted only when the engine's own token started it (FACTORY STARTING
//                               by=) under the exact title, and the model session_configure answers must be the role's.
//   portalWorktrees(o)          --start: the worktree made IN THE WORKSPACE through the portal (worktree_create, repos_list; T-337), the folder
//                               taken from the portal's answer and checked to lie in <repository>.worktrees/. No local git with --start.
//   watchBudget(t, deps)        the started slice's COST: session_get's cost_usd (the portal's count for the session, in US dollars) against
//                               SIZE_COST_USD. At 150 percent it is interrupted, told to commit WIP and report, and the dispatch ends
//                               (FACTORY END ... stopped: budget). The request budget (SIZE_BUDGET) is NOT measured by the engine: it plans a
//                               run (--budget) and is the agent's own count in its brief.
//   engineLock(path), leaseLabel(), onStop(cleanup): one engine run per host (a lock file with the pid; a dead pid's lock is stale), an admin
//                               token label per run (a run never revokes another run's token), SIGINT/SIGTERM revoke the token and exit.
// One round for a supervisor hook: docs/dev-sessions/factory-round.mjs (prints NEXT and EXCEPTION lines; NOT wired into supervisor.mjs: an
// independent reviewer reads the engine before it runs unattended; the admin credential path for workers is T-339, an owner decision).
//
// State lives in the portal's tickets only, as comments whose first line is a marker the engine writes and reads back. A marker (and an
// ACTUAL) counts ONLY when the engine's own actor wrote it: actor `ui` (the signed-in REST path the engine uses: the owner's) and not flagged
// fromAgent. A comment an agent or a token wrote (contracts TicketEvent.fromAgent), or one without an actor, is never read as a marker. The
// role, model, branch and budget of a dispatch are re-derived (ROLES, the role files, branchOf, SIZE_BUDGET), never taken from comment text.
//   FACTORY DISPATCH <dispatchId> v=<engine version> role=<role> model=<model> size=<S|M|L> budget=<n> branch=<branch>
//   FACTORY STARTING <dispatchId> by=portal-mcp:<token id>                          (--start: written right before session_start)
//   FACTORY START <dispatchId> session=<sessionId> mode=dontAsk model=<model>      (--start: the session that runs the slice)
//   FACTORY END <dispatchId> <outcome>
//   FACTORY RESUME <dispatchId> run=<runId> state=<state> next=<review|fix>
//   FACTORY REVIEW <dispatchId> verdict=<pass|changes>   FACTORY VERIFY <dispatchId> verdict=<pass|sendback>
//   FACTORY INTEGRATE <dispatchId> result=<merged|conflict> [commit=<sha>]
// An ACTUAL comment ends every dispatch before it. A ticket with a DISPATCH and no END or ACTUAL has an open dispatch: it counts as in flight and is never dispatched again (the double-dispatch guard).
// Dispatch ids are `<ticket>-F<n>` (n = the ticket's earlier dispatches + 1), so a restart computes the same ids from the same tickets.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenLease } from '../../tools/coordinator/tokenLease.mjs';

/** Requests per slice by size: what a run plans with (--budget) and the agent's own count in its brief. The engine does not measure it. */
export const SIZE_BUDGET = Object.freeze({ S: 25, M: 60, L: 120 });
/**
 * The cost budget per slice by size, in US dollars of the slice's session (session_get cost_usd): what the engine MEASURES and stops at
 * (STOP_FACTOR of it). PROVISIONAL: there is no measured source yet (no slice has run through --start); the numbers are a guess of the order
 * of an S, M and L slice. Replace them with the median cost_usd of the first ten factory slices per size and name that source here.
 */
export const SIZE_COST_USD = Object.freeze({ S: 4, M: 10, L: 20 });
export const STOP_FACTOR = 1.5;
export const DEFAULT_WIP = 5;
export const DEFAULT_RESUME_MAX_AGE_MIN = 360;
/** The version a DISPATCH marker carries (v=): --start starts only a dispatch this engine version wrote. */
export const ENGINE_VERSION = 2;
/** The actor the engine writes its comments as: the signed-in REST path (PORTAL_SERVER_CODE) is the portal's `ui` actor. */
export const ENGINE_ACTOR = 'ui';
/** The role table: the roles the engine dispatches and starts (a DISPATCH naming another role is refused). Models come from their role files. */
export const ROLES = Object.freeze(['implementer']);
const DEFAULT_WORKTREES = '../claudepilot.worktrees';
const CLOSED = new Set(['done', 'wont_do']);

/** Portal MCP wraps outside text as { untrusted_text }; the REST API gives plain strings. */
const textOf = (v) => (v && typeof v === 'object' ? String(v.untrusted_text ?? '') : String(v ?? ''));

/** A comment the engine wrote (and so may read back as a marker): the engine's actor, not flagged as an agent's, plain text (not MCP-wrapped). */
export function isEngineComment(e) {
  const body = e.body ?? e.text;
  return e.actor === ENGINE_ACTOR && e.fromAgent === false && typeof body === 'string';
}

/** A ticket from any of the shapes the portal returns, with its comments as { at, text, actor, fromAgent, engine }, oldest first. */
export function normalizeTicket(raw) {
  const t = raw?.ticket && (raw.events || raw.comments) ? { ...raw.ticket, events: raw.events, comments: raw.comments } : raw;
  const entries = [...(t.comments ?? []), ...(t.events ?? [])].filter((e) => (e.kind ?? 'comment') === 'comment');
  const comments = entries
    .map((e) => ({ at: String(e.at ?? ''), text: textOf(e.body ?? e.text), actor: e.actor ?? null, fromAgent: e.fromAgent ?? null, engine: isEngineComment(e) }))
    .sort((a, b) => a.at.localeCompare(b.at));
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

/** The first line of each comment the ENGINE wrote, with its time (every marker reader goes through this: B1, T-338). */
const engineLines = (t) => t.comments.filter((c) => c.engine).map((c) => ({ at: c.at, first: c.text.split('\n', 1)[0].trim() }));

/** The ticket's dispatch markers (the engine's own only): every DISPATCH with its fields, whether an END closed it, oldest first. */
export function dispatchesOf(t) {
  const list = [];
  const ended = new Map();
  for (const c of engineLines(t)) {
    const first = c.first;
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

/** `ticket/T-12-short-slug` from the summary (lowercase words, at most 40 characters). A ticket id that is not `T-<n>` throws. */
export function branchOf(t) {
  if (!/^T-\d+$/.test(t.id)) throw new Error(`not a ticket id: ${String(t.id).slice(0, 20)}`);
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

/** The cost budget of a slice by size (US dollars, SIZE_COST_USD) and its state after `usd` spent: what watchBudget measures. */
export function costBudget(size, usd = 0) {
  const budget = SIZE_COST_USD[size];
  if (!budget) throw new Error(`no cost budget for size ${size} (XL is split first)`);
  const stopAt = Math.round(budget * STOP_FACTOR * 100) / 100;
  return { budget, stopAt, used: usd, state: usd >= stopAt ? 'stop' : usd > budget ? 'over' : 'ok' };
}

/**
 * Whether `path` lies strictly inside `folder` once both are resolved (`..` cannot climb out). POSIX paths (the workspace is Linux); two
 * relative paths are compared from the same base, an absolute path against a relative folder is never inside.
 */
export function insideFolder(path, folder) {
  const p = posix.resolve('/base', String(path));
  const f = posix.resolve('/base', String(folder));
  return p !== f && p.startsWith(f === '/' ? '/' : `${f}/`);
}

/** The worktree of a branch under `worktrees` (`ticket/T-1-x` -> `<worktrees>/ticket-T-1-x`); throws when it would not lie inside it. */
export function worktreeOf(worktrees, branch) {
  const path = `${worktrees}/${String(branch).replace(/\//g, '-')}`;
  if (!insideFolder(path, worktrees)) throw new Error(`worktree ${path.slice(0, 160)} is outside ${worktrees}`);
  return path;
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
  if (!ROLES.includes(role)) throw new Error(`role ${role} is not in the role table (${ROLES.join(', ')})`);
  const model = opts.models?.[role] ?? 'unset';
  const worktrees = opts.worktrees ?? DEFAULT_WORKTREES;
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
    dispatch.push({ ticket: t.id, summary: t.summary, rank: `rank-${String(rank[0]).padStart(2, '0')}${rank[1]}`, size: est.size, budget: b.budget, stopAt: b.stopAt, role, model, branch, worktree: worktreeOf(worktrees, branch), dispatchId: `${t.id}-F${n}` });
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
  return `FACTORY DISPATCH ${d.dispatchId} v=${ENGINE_VERSION} role=${d.role} model=${d.model} size=${d.size} budget=${d.budget} branch=${d.branch}`;
}

/** The longest ticket summary a brief carries. */
export const SUMMARY_MAX = 120;
/**
 * The ticket summary as the brief shows it (M3, T-338): one line, control and format characters (line breaks, bidi overrides, zero-width)
 * removed, double quotes made single (the brief quotes it), at most SUMMARY_MAX characters. It is ticket text: the brief labels it so.
 */
export function briefSummary(s) {
  const one = String(s ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > SUMMARY_MAX ? `${one.slice(0, SUMMARY_MAX - 1)}…` : one;
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
  const cost = costBudget(d.size);
  return { ticket: d.ticket, summary: briefSummary(d.summary), dispatchId: d.dispatchId, role: d.role, model: d.model, contextPack, worktree: d.worktree, branch: d.branch, size: d.size, budget: d.budget, stopAt: d.stopAt, costBudget: cost.budget, costStop: cost.stopAt, session, agent: `${d.role}-${d.dispatchId.toLowerCase()}`, tokenDiscipline };
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
  /** One call: { status, ok, data, error, json }; signs in again once on a 401. */
  async function request(method, path, body) {
    for (let attempt = 1; ; attempt++) {
      if (!cookie) await login();
      const res = await f(`${base}${path}`, { method, headers: { 'content-type': 'application/json', origin: base, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (res.status === 401 && attempt < 2) { cookie = ''; continue; }
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { /* a proxy page */ }
      return { status: res.status, ok: res.ok, data: json?.data, error: json?.error, json };
    }
  }
  async function api(method, path, body) {
    const r = await request(method, path, body);
    if (!r.ok || !r.json || r.json.error) throw new Error(`${method} ${path.split('?')[0]}: ${r.json?.error?.code ?? r.status}`);
    return r.data;
  }
  const one = (id) => `/api/tickets/${encodeURIComponent(id)}`;
  return {
    url: base,
    list: (query) => api('GET', `/api/tickets?${query}`),
    get: (id) => api('GET', one(id)),
    comment: (id, text) => api('POST', `${one(id)}/comments`, { text }),
    /** `{ status, data, error }` without throwing: the shape tools/coordinator/tokenLease.mjs reads (the MCP admin token for --start). */
    raw: async (method, path, body) => { const r = await request(method, path, body); return { status: r.status, data: r.data, error: r.error }; },
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

/* ---------- Apply: the dispatch comment and the worktree (a session only with --start) ---------- */

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
 * The worktree IN THE WORKSPACE, through the portal (T-337; --start uses only this, never local git): the same shape as gitOps, over the
 * admin Portal MCP tools. repos_list (the portal's last scan of the workspace) says whether a worktree already has the branch and where
 * repository `repoId` lives; worktree_create makes the worktree there (in `<repository>.worktrees/`, git hardened by the portal) and its
 * answer is the folder. A folder outside `<repository>.worktrees/`, or another branch than asked, throws. find(branch): the folder of the
 * worktree on that branch, or null (m1: a dispatch is started only when the portal reports its worktree). A branch that exists without a
 * worktree is not visible here: worktree_create checks it out (the earlier dispatch's work), it is not made twice.
 */
export function portalWorktrees({ mcp, workspace, repoId }) {
  if (!repoId) throw new Error('portalWorktrees needs the repository id (repos_list)');
  async function scan() {
    const nodes = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const r = await mcp.call('repos_list', { workspace_id: workspace, limit: 100, ...(cursor ? { cursor } : {}) });
      nodes.push(...(r?.repos ?? []));
      cursor = r?.next_cursor ?? null;
      if (!cursor) break;
    }
    const main = nodes.find((n) => n.id === repoId);
    if (!main) throw new Error(`repository ${repoId} not found in ${workspace}`);
    const path = textOf(main.path).replace(/\/+$/, '');
    if (!posix.isAbsolute(path)) throw new Error(`repository ${repoId} has no absolute path`);
    return { root: `${path}.worktrees`, nodes };
  }
  const on = (nodes, branch) => nodes.filter((n) => n.branch !== null && n.branch !== undefined && textOf(n.branch) === branch);
  return {
    viaPortal: true,
    async taken(branch) {
      const { nodes } = await scan();
      return on(nodes, branch).length ? `branch ${branch} is checked out in ${workspace}` : null;
    },
    async addWorktree(branch, _worktree, base) {
      const { root } = await scan();
      const r = await mcp.call('worktree_create', { repo_id: repoId, branch, ...(base ? { base } : {}) });
      const made = textOf(r?.worktree?.branch);
      if (made !== branch) throw new Error(`worktree_create made branch ${made.slice(0, 100)}, not ${branch}`);
      const folder = posix.resolve('/', textOf(r?.worktree?.path));
      if (!posix.isAbsolute(textOf(r?.worktree?.path)) || !insideFolder(folder, root)) throw new Error(`worktree ${folder.slice(0, 160)} is outside ${root.slice(0, 160)}`);
      return folder;
    },
    async find(branch) {
      const { root, nodes } = await scan();
      const n = on(nodes, branch).find((x) => posix.isAbsolute(textOf(x.path)) && insideFolder(textOf(x.path), root));
      return n ? posix.resolve('/', textOf(n.path)) : null;
    },
  };
}

/**
 * Carry out a plan: per planned dispatch, read the ticket again (another run may have taken it), refuse a branch or folder that exists,
 * write the FACTORY DISPATCH comment (the state, in the portal only), then create the worktree and branch from `base`. A worktree that fails
 * after the comment gets a FACTORY END ... failed comment, so the ticket is free again and nothing is left half done. Starts a session
 * only when `start` is given (--start: startSlice for each dispatch whose worktree was made; its outcome is the result's `start`).
 * Returns { results: [{ ticket, dispatchId, action: dispatched|skipped|refused|failed, reason? }], exceptions } (the plan's and its own).
 */
export async function applyPlan(plan, { portal, git, base = 'origin/integration', start = null }) {
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
    // --start: the worktree is made in the workspace through the portal (T-337), never with git on the engine's host.
    if (start && !git.viaPortal) throw new Error('--start makes worktrees through the portal (portalWorktrees), never with local git');
    const taken = await git.taken(d.branch, d.worktree);
    if (taken) {
      results.push({ ...r, action: 'refused', reason: taken });
      exceptions.push({ ticket: d.ticket, dispatchId: d.dispatchId, reason: `not dispatched: ${taken}` });
      continue;
    }
    await portal.comment(d.ticket, dispatchMarker(d));
    let folder = null;
    try {
      folder = (await git.addWorktree(d.branch, d.worktree, base)) ?? null;
    } catch (e) {
      const why = String(e?.stderr || e?.message || e).split('\n').find(Boolean)?.slice(0, 160) ?? 'error';
      await portal.comment(d.ticket, `FACTORY END ${d.dispatchId} failed: worktree (${why})`);
      results.push({ ...r, action: 'failed', reason: why });
      exceptions.push({ ticket: d.ticket, dispatchId: d.dispatchId, reason: `worktree failed: ${why}` });
      continue;
    }
    const done = { ...r, action: 'dispatched', branch: d.branch, worktree: folder ?? d.worktree };
    if (start) {
      // --start: the slice as a worker session, right after its worktree, in the folder the portal answered (startSlice reads the ticket
      // again and writes its own markers).
      const s = await start({ ...d, worktree: folder, folder });
      done.start = { action: s.action, ...(s.sessionId ? { sessionId: s.sessionId } : {}), ...(s.reason ? { reason: s.reason } : {}) };
      exceptions.push(...(s.exceptions ?? []));
    }
    results.push(done);
  }
  return { results, exceptions };
}

/* ---------- Start: the dispatched slice as a worker session (--start; off by default) ---------- */

/** The mode every factory session runs in (D-49): only what the folder's allow list allows, the rest refused without waiting. Never Bypass. */
export const START_MODE = 'dontAsk';
/** session_send takes at most this many characters. */
const SEND_MAX = 8000;

/** The audit line of a start, next to its DISPATCH: which session runs the slice, in which mode and on which model. */
export function startMarker(d, sessionId) {
  return `FACTORY START ${d.dispatchId} session=${sessionId} mode=${START_MODE} model=${d.model}`;
}

/** dispatchId -> session id of every FACTORY START comment the engine wrote. */
export function startsOf(t) {
  const out = new Map();
  for (const c of engineLines(t)) {
    const m = /^FACTORY START (\S+) session=(\S+)/.exec(c.first);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

/** dispatchId -> the token actors (`portal-mcp:<id>`) the engine wrote a FACTORY STARTING for: the only sessions it may adopt (m2). */
export function startingOf(t) {
  const out = new Map();
  for (const c of engineLines(t)) {
    const m = /^FACTORY STARTING (\S+) by=(portal-mcp:\S+)$/.exec(c.first);
    if (m) out.set(m[1], new Set([...(out.get(m[1]) ?? []), m[2]]));
  }
  return out;
}

/**
 * A planned dispatch rebuilt from its DISPATCH marker (to start or watch one a restarted engine finds open). Only the id, the size and the
 * time are read from the marker; the role must be in ROLES, the branch must be the one branchOf derives, the model is the role file's
 * (models), the budgets come from the size, the worktree lies inside `worktrees`. Anything else throws (the caller reports an exception).
 */
export function dispatchFrom(t, d, { worktrees = DEFAULT_WORKTREES, models = {} } = {}) {
  if (!ROLES.includes(d.role)) throw new Error(`dispatch ${d.id}: role ${String(d.role).slice(0, 40)} is not in the role table`);
  if (!(d.size in SIZE_BUDGET)) throw new Error(`dispatch ${d.id}: no size budget for ${String(d.size).slice(0, 10)}`);
  const branch = branchOf(t);
  if (d.branch !== branch) throw new Error(`dispatch ${d.id}: its branch is not ${branch}`);
  const b = sliceBudget(d.size);
  return { ticket: t.id, summary: t.summary, size: d.size, budget: b.budget, stopAt: b.stopAt, role: d.role, model: models?.[d.role] ?? 'unset', branch, worktree: worktreeOf(worktrees, branch), dispatchId: d.id, version: Number(d.v) || null };
}

/**
 * Portal MCP over HTTP, the admin tools a person's automation uses (the supervisor's path, T-258): `token()` gives the leased admin token
 * (tools/coordinator/tokenLease.mjs). call(name, args) returns the tool's structuredContent, or throws `<name>: <code> <message>`; the token
 * never appears in an error. actor(): `portal-mcp:<token id>` of the token held now (an id is not a secret), the actor the portal records.
 */
export function mcpClient({ url, token, tokenId = () => null, fetch: f = globalThis.fetch, label = 'factory-engine' }) {
  const base = String(url).replace(/\/$/, '');
  return {
    actor: () => (tokenId() ? `portal-mcp:${tokenId()}` : null),
    async call(name, args) {
      const headers = { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      const init = await f(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: label, version: '1' } } }) });
      const sid = init.headers.get('mcp-session-id');
      await init.text();
      const res = await f(`${base}/mcp`, { method: 'POST', headers: { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) });
      const raw = await res.text();
      let out;
      try {
        const line = raw.split('\n').find((l) => l.startsWith('data: '));
        out = JSON.parse(line ? line.slice(6) : raw);
      } catch {
        throw new Error(`${name}: no answer (${res.status})`);
      }
      if (out.error || out.result?.isError) {
        const sc = out.result?.structuredContent;
        const code = sc?.error?.code ?? out.error?.code ?? 'refused';
        const msg = String(sc?.error?.message ?? out.error?.message ?? out.result?.content?.[0]?.text ?? '').split('\n')[0].slice(0, 160);
        const e = new Error(`${name}: ${code}${msg ? ` ${msg}` : ''}`);
        e.code = code;
        throw e;
      }
      return out.result?.structuredContent ?? {};
    },
  };
}

const usd = (n) => `${Number(n).toFixed(2)} USD`;
/** What the worker is told when the engine stops it at 150 percent of its size's cost budget. */
export const stopText = (d, used) => {
  const b = costBudget(d.size, used);
  return `FACTORY STOP ${d.dispatchId}: the cost budget is spent (${usd(used)} of ${usd(b.budget)}, stop at ${usd(b.stopAt)}). Stop now: commit and push what is done as WIP, then report in at most 25 lines what is done and what is left. Start nothing new.`;
};

/**
 * Start a dispatched slice as a non-Bypass worker session, through the admin Portal MCP tools a person's automation already uses
 * (session_start, session_configure, session_send: the same controller calls as session_spawn's create, mode and first instruction; no new
 * authz or approval path). In order, fail closed:
 *   1. read the ticket again: the dispatch must be the ticket's latest, open, not started (no FACTORY START), written by this engine
 *      version (v=ENGINE_VERSION), and not stale (a dispatch past staleMin is the coordinator's: never started late).
 *   2. the folder: `folder` (worktree_create's answer) or locate(branch) (repos_list); no worktree in the workspace, no start (m1).
 *   3. session_list: a live session titled exactly `<dispatchId> <role>` on the ticket that THE ENGINE's token started (started_by is a
 *      `by=` of a FACTORY STARTING marker: a crash between the start and its marker) is adopted, not started twice. Such a title from anyone
 *      else is refused (an exception), never adopted.
 *   4. FACTORY STARTING <id> by=<the engine's token actor>, then session_start: the folder, agent = the role, ticket = the ticket, NO first
 *      prompt (the mode comes first).
 *   5. session_configure: mode dontAsk and the role's explicit model; a mode or a model the answer does not confirm ends it (fail closed).
 *   6. the FACTORY START comment (the audit trail: the session id next to the DISPATCH), then session_send with the rendered brief.
 *   7. one line to the orchestrator session (reportTo), when one is given.
 * A start that fails ends its session and writes FACTORY END <id> failed: start (...), so the dispatch is not left half done.
 * deps: { portal, mcp (with actor()), workspace, folder? (absolute, the portal's answer) | locate? (branch -> folder | null), brief (text, or
 * folder -> text), reportTo?, now?, staleMin? }. Returns { action: started|adopted|skipped|refused|failed, sessionId?, reason?, exceptions }.
 */
export async function startSlice(d, { portal, mcp, workspace, folder = null, locate = null, brief, reportTo = null, now, staleMin = DEFAULT_RESUME_MAX_AGE_MIN }) {
  const exceptions = [];
  const except = (reason) => exceptions.push({ ticket: d.ticket, dispatchId: d.dispatchId, reason });
  const refuse = (reason, line) => { except(line ?? reason); return { action: 'refused', reason, exceptions }; };
  const fresh = normalizeTicket(await portal.get(d.ticket));
  const all = dispatchesOf(fresh);
  const last = all[all.length - 1];
  if (CLOSED.has(fresh.status)) return { action: 'skipped', reason: `ticket is ${fresh.status}`, exceptions };
  if (!last || last.id !== d.dispatchId) return { action: 'skipped', reason: last ? `not the latest dispatch (${last.id})` : 'no dispatch', exceptions };
  if (last.ended) return { action: 'skipped', reason: `dispatch ended (${last.ended})`, exceptions };
  const started = startsOf(fresh).get(d.dispatchId);
  if (started) return { action: 'skipped', reason: `started already (session ${started})`, sessionId: started, exceptions };
  if (Number(last.v) !== ENGINE_VERSION) return refuse(`not dispatched by engine version ${ENGINE_VERSION}`, `dispatch ${d.dispatchId} is not from engine version ${ENGINE_VERSION}: not started`);
  const age = ageMin(last.at, now);
  if (age !== null && age > staleMin) return refuse('stale', `stale dispatch ${d.dispatchId}: ${age} min old (limit ${staleMin}), not started`);
  let where = folder;
  if (!where && locate) {
    try {
      where = await locate(d.branch);
    } catch (e) {
      return refuse(`worktree unknown: ${String(e.message).slice(0, 160)}`);
    }
  }
  if (!where) return refuse('no worktree', `no worktree on ${d.branch} in ${workspace ?? 'the workspace'}: not started`);
  const fail = async (sessionId, why) => {
    if (sessionId) await mcp.call('session_end', { id: sessionId }).catch(() => undefined);
    await portal.comment(d.ticket, `FACTORY END ${d.dispatchId} failed: start (${why})`);
    except(`start failed: ${why}`);
    return { action: 'failed', reason: why, ...(sessionId ? { sessionId } : {}), exceptions };
  };
  if (!workspace) return fail(null, 'no workspace');
  if (!ROLES.includes(d.role)) return fail(null, `role ${String(d.role).slice(0, 40)} is not in the role table`);
  if (!d.model || d.model === 'unset') return fail(null, `no model for role ${d.role}`);
  const text = typeof brief === 'function' ? brief(where) : brief;
  if (String(text).length > SEND_MAX) return fail(null, `brief over ${SEND_MAX} characters`);
  const title = `${d.dispatchId} ${d.role}`;
  // A start whose marker was never written (the engine stopped between the two): the portal's own list says so.
  let list = null;
  try {
    list = await mcp.call('session_list', { workspace_id: workspace, ticket_id: d.ticket });
  } catch (e) {
    return fail(null, String(e.message));
  }
  const ours = startingOf(fresh).get(d.dispatchId) ?? new Set();
  const titled = (list?.sessions ?? []).filter((s) => textOf(s.title) === title && s.state !== 'ended' && (s.ticket_id ?? d.ticket) === d.ticket);
  const prior = titled.find((s) => typeof s.started_by === 'string' && ours.has(s.started_by));
  if (prior) {
    await portal.comment(d.ticket, startMarker(d, prior.id));
    except(`adopted session ${prior.id}: started by this engine before its marker; check it got its brief`);
    return { action: 'adopted', sessionId: prior.id, exceptions };
  }
  if (titled.length) return refuse(`a session titled ${title} exists that this engine did not start`, `session ${String(titled[0].id).slice(0, 80)} is titled ${title} but this engine did not start it: not adopted, not started`);
  const actor = typeof mcp.actor === 'function' ? mcp.actor() : null;
  if (!actor) return fail(null, 'no token actor to record the start');
  await portal.comment(d.ticket, `FACTORY STARTING ${d.dispatchId} by=${actor}`);
  let sessionId = null;
  try {
    const s = await mcp.call('session_start', { workspace_id: workspace, folder: where, title, agent: d.role, ticket_id: d.ticket });
    sessionId = s?.session?.id ?? null;
    if (!sessionId) return fail(null, 'session_start gave no session');
    const c = await mcp.call('session_configure', { id: sessionId, mode: START_MODE, model: d.model });
    if (c?.session?.mode !== START_MODE) return fail(sessionId, `mode ${START_MODE} not confirmed (${c?.session?.mode ?? 'no answer'})`);
    if (c?.session?.model !== d.model) return fail(sessionId, `model ${d.model} not confirmed (${String(c?.session?.model ?? 'no answer').slice(0, 60)})`);
  } catch (e) {
    return fail(sessionId, String(e.message));
  }
  await portal.comment(d.ticket, startMarker(d, sessionId));
  try {
    await mcp.call('session_send', { id: sessionId, text });
  } catch (e) {
    return fail(sessionId, `brief not sent: ${e.message}`);
  }
  if (reportTo) {
    const line = `FACTORY: started ${d.dispatchId} (${d.ticket}) as session ${sessionId}: ${d.role}/${d.model}, mode ${START_MODE}, branch ${d.branch}, budget ${d.budget} requests (stop at ${d.stopAt}).`;
    await mcp.call('session_send', { id: reportTo, text: line, priority: 'later' }).catch((e) => except(`report to ${reportTo} failed: ${e.message}`));
  }
  return { action: 'started', sessionId, exceptions };
}

/**
 * The budget watch of a started slice (each round). What it measures: the session's cost_usd from session_get (the portal's own sum of the
 * session's cost, US dollars), against SIZE_COST_USD of the dispatch's size (provisional numbers, see there). Under 150 percent nothing is
 * done ('ok', or 'over' past 100 percent: a line); AT 150 percent the engine stops it and reports: session_interrupt, the FACTORY STOP
 * message (commit WIP, report), FACTORY END <id> stopped: budget, and one line to reportTo. Never continues silently. No cost in the answer
 * is 'none' (unknown is a state, not a guess). Returns { action: none|ok|over|stopped|ended, used? (USD), budget?, exceptions }.
 */
export async function watchBudget(rawTicket, { portal, mcp, reportTo = null, worktrees, models }) {
  const t = normalizeTicket(rawTicket);
  const exceptions = [];
  if (CLOSED.has(t.status)) return { action: 'none', exceptions };
  const open = openDispatches(t);
  const last = open[open.length - 1];
  const sid = last ? startsOf(t).get(last.id) : null;
  if (!sid) return { action: 'none', exceptions };
  let d;
  try {
    d = dispatchFrom(t, last, { worktrees, models });
  } catch (e) {
    exceptions.push({ ticket: t.id, dispatchId: last.id, reason: `budget not watched: ${e.message}` });
    return { action: 'none', exceptions };
  }
  const got = await mcp.call('session_get', { id: sid });
  if (got?.session?.state === 'ended') return { action: 'ended', exceptions };
  const raw = got?.session?.cost_usd;
  const used = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(used)) return { action: 'none', exceptions };
  const b = costBudget(d.size, used);
  if (b.state !== 'stop') return { action: b.state, used, budget: b.budget, exceptions };
  await mcp.call('session_interrupt', { id: sid }).catch(() => undefined);
  await mcp.call('session_send', { id: sid, text: stopText(d, used), priority: 'next' }).catch(() => undefined);
  await portal.comment(t.id, `FACTORY END ${d.dispatchId} stopped: budget ${usd(used)} of ${usd(b.budget)} (stop at ${usd(b.stopAt)})`);
  const reason = `budget stop: ${d.dispatchId} at ${usd(used)} of ${usd(b.budget)} (stop at ${usd(b.stopAt)}); session ${sid} told to commit WIP and report`;
  exceptions.push({ ticket: t.id, dispatchId: d.dispatchId, reason });
  if (reportTo) await mcp.call('session_send', { id: reportTo, text: `FACTORY: ${reason}.`, priority: 'later' }).catch(() => undefined);
  return { action: 'stopped', used, exceptions };
}

/* ---------- Resume on a CI event (pure) ---------- */

const ENDED_RUN = new Set(['passed', 'failed', 'cancelled']);

/** `<dispatchId> <runId>` of every FACTORY RESUME comment: the events already handled. */
function resumedOf(t) {
  const out = new Set();
  for (const c of engineLines(t)) {
    const m = /^FACTORY RESUME (\S+) run=(\S+)/.exec(c.first);
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

/** The step markers (RESUME, REVIEW, VERIFY, INTEGRATE) of one dispatch that the engine wrote, oldest first: { kind, at, fields }. */
function stepsOf(t, dispatchId) {
  const out = [];
  for (const c of engineLines(t)) {
    const m = /^FACTORY (RESUME|REVIEW|VERIFY|INTEGRATE) (\S+)(.*)$/.exec(c.first);
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

/* ---------- One run per host, a token per run, a clean stop (M1, m3; T-338) ---------- */

/** Whether a process with this pid lives on this host (EPERM: it lives, under another user). */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

export const DEFAULT_LOCK = join(tmpdir(), 'claudepilot-factory.lock');
/** A lock file younger than this without a readable pid is being written by another run: held, not stale. */
const LOCK_FRESH_MS = 10_000;

/**
 * One engine run that writes (--apply) per host: a lock file holding the pid, created exclusively (O_EXCL). A lock whose pid no longer
 * lives is stale and taken over; a live one throws `another factory run holds <path> (pid <n>)`. release() removes it only while it is still
 * this run's. Two hosts are not covered (the dispatch id and the ticket re-read before every write are the guard there).
 */
export function engineLock(path = DEFAULT_LOCK, { pid = process.pid, alive = pidAlive, now = () => Date.now() } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, `${pid}\n`, { flag: 'wx', mode: 0o600 });
      return {
        path,
        release() {
          try {
            if (readFileSync(path, 'utf8').trim() === String(pid)) unlinkSync(path);
          } catch {
            // gone already
          }
        },
      };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }
    let other = NaN;
    let age = Infinity;
    try {
      other = Number(readFileSync(path, 'utf8').trim());
      age = now() - statSync(path).mtimeMs;
    } catch {
      continue; // removed between the two calls: try again
    }
    if (Number.isInteger(other) && other > 0 ? alive(other) : age < LOCK_FRESH_MS) throw new Error(`another factory run holds ${path} (pid ${Number.isInteger(other) ? other : 'unknown'})`);
    try {
      unlinkSync(path); // stale: its process is gone
    } catch {
      // another run took it over first: the next attempt sees its lock
    }
  }
  throw new Error(`could not take ${path}`);
}

/** The admin token label of ONE run (M1): `factory-engine <pid>-<start time>`, so replace:true only ever replaces this run's own token. */
export function leaseLabel({ pid = process.pid, now = Date.now() } = {}) {
  return `factory-engine ${pid}-${now.toString(36)}`;
}

/** On SIGINT or SIGTERM: run cleanup (revoke the token, drop the lock) once, then exit 130 or 143. Returns a function that unhooks it. */
export function onStop(cleanup, proc = process) {
  let done = false;
  const handler = (sig) => {
    if (done) return;
    done = true;
    Promise.resolve()
      .then(cleanup)
      .catch(() => undefined)
      .finally(() => proc.exit(sig === 'SIGINT' ? 130 : 143));
  };
  proc.once('SIGINT', handler);
  proc.once('SIGTERM', handler);
  return () => {
    proc.off('SIGINT', handler);
    proc.off('SIGTERM', handler);
  };
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
    else if (a === '--start') o.start = true;
    else if (a === '--report-to') o.reportTo = val();
    else if (a === '--repo-id') o.repoId = val();
    else if (a === '--lock') o.lock = val();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.tickets === !o.portal) throw new Error('name one source: --tickets <file.json|-> or --portal');
  if (o.apply && !o.portal) throw new Error('--apply needs --portal (the state is read from the portal right before it is written)');
  if (o.role && !ROLES.includes(o.role)) throw new Error(`--role takes ${ROLES.join(', ')}`);
  if (o.start && !o.apply) throw new Error('--start needs --apply (a session is started only for a dispatch written in the same run)');
  if (o.start && !o.workspace) throw new Error('--start needs --workspace (the workspace the worker session runs in)');
  if (o.start && !o.repoId) throw new Error('--start needs --repo-id (the repository in the workspace its worktrees are made from: repos_list)');
  return o;
}

/**
 * The start step for applyPlan / a round: the folder is the portal's (worktree_create's answer, or `locate` = portalWorktrees.find), the
 * brief is rendered for that folder, the MCP client given.
 */
export function starter({ portal, mcp, workspace, locate, template, tokenDiscipline, session, reportTo = null, now, staleMin }) {
  return (d) =>
    startSlice(d, {
      portal,
      mcp,
      workspace,
      folder: d.folder ?? null,
      locate,
      brief: (folder) => renderBrief(template, briefVars({ ...d, worktree: folder }, { session, tokenDiscipline })),
      reportTo,
      now,
      staleMin,
    });
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`factory: ${e.message}\nusage: factory.mjs (--tickets <file.json|-> | --portal [--apply [--start --workspace W --repo-id ID [--report-to SESSION]]]) [--wip N] [--budget N] [--role R] [--session ID] [--worktrees DIR] [--workspace W] [--repo DIR] [--base REF] [--stale-min N] [--lock FILE] [--json] [--briefs]\n`);
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
  // --apply: one writing run per host (M1). --start: an admin Portal MCP token leased for this run only, under this run's own label (1 hour,
  // revoked at the end and on SIGINT/SIGTERM), held in memory and never printed; worktrees are made in the workspace through the portal.
  let lock = null;
  if (o.apply) {
    try {
      lock = engineLock(o.lock ?? DEFAULT_LOCK);
    } catch (e) {
      process.stderr.write(`factory: ${e.message}\n`);
      process.exit(3);
    }
  }
  const lease = o.start ? tokenLease({ api: portal.raw, label: leaseLabel() }) : null;
  const unhook = onStop(async () => { await lease?.revoke(); lock?.release(); });
  const mcp = lease ? mcpClient({ url: portal.url, token: lease.get, tokenId: () => lease.id }) : null;
  const wt = mcp ? portalWorktrees({ mcp, workspace: o.workspace, repoId: o.repoId }) : null;
  const start = mcp
    ? starter({ portal, mcp, workspace: o.workspace, locate: wt.find, template, tokenDiscipline, session, reportTo: o.reportTo ?? null, now: Date.now(), staleMin: o.staleMin })
    : null;
  let applied = null;
  try {
    applied = o.apply ? await applyPlan(plan, { portal, git: wt ?? gitOps(o.repo ?? repo), base: o.base, start }) : null;
  } finally {
    await lease?.revoke();
    lock?.release();
    unhook();
  }
  if (o.json) process.stdout.write(`${JSON.stringify({ ...plan, briefs, ...(applied ? { applied } : {}) }, null, 2)}\n`);
  else if (applied) {
    process.stdout.write(`${formatPlan({ ...plan, exceptions: applied.exceptions }, o.start ? 'apply, start' : 'apply')}\n`);
    for (const r of applied.results) {
      process.stdout.write(`  ${r.action} ${r.dispatchId}${r.reason ? `: ${r.reason}` : ` ${r.branch} ${r.worktree}`}\n`);
      if (r.start) process.stdout.write(`    start ${r.start.action}${r.start.sessionId ? ` session ${r.start.sessionId}` : ''}${r.start.reason ? `: ${r.start.reason}` : ''}\n`);
    }
    for (const b of briefs) if (applied.results.some((r) => r.dispatchId === b.dispatchId && r.action === 'dispatched')) process.stdout.write(`\n--- ${b.dispatchId}: brief\n${b.brief}`);
  } else {
    process.stdout.write(`${formatPlan(plan)}\n`);
    for (const b of briefs) process.stdout.write(`\n--- ${b.dispatchId}: would comment "${b.marker}" and send:\n${b.brief}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
