#!/usr/bin/env node
// The supervisor of the autonomous development session (docs/dev-sessions/README.md): ONE orchestrator session that works with sub-agents.
// It runs OUTSIDE the pod (D-14: the owner's sign-in code is never where agents can read it; tools/coordinator/up.sh starts it) as a plain background process, so it goes on when the coordinator's own session is closed:
//   PORTAL_SERVER_CODE=<the 8-character sign-in code> [DEPLOY_RUN=<run id>] nohup node docs/dev-sessions/supervisor.mjs >> ~/.claudepilot/dev-sessions/supervisor.log 2>&1 &
// What it does, as the owner's delegate (it signs in with the owner's code, which the owner asked for: "run it autonomously, in Bypass mode, without
// asking a human again"):
//   1. With DEPLOY_RUN: waits until that run's release job waits for its approval, approves it (once, that run only), and waits for the run to
//      pass. A run that fails or is cancelled stops everything.
//   2. Brings the main folder's `integration` up to date (git pull --ff-only).
//   3. Starts the orchestrator (a Bypass session in the main folder, on the Claude with the most room) unless one already lives.
//   4. Keeps watching, every ROUND_S seconds: a session idle for a few minutes gets a nudge to carry on (nobody else will); an interrupted one (its
//      process is gone) is woken by a message; one that ended for integrity is first recovered IN PLACE (T-136: POST .../recover as an agent; the
//      portal caps and pauses it); one that ended otherwise, or whose recover was refused, is started again as a NEW session that continues it,
//      told to continue from its status file (at most MAX_STARTS new sessions per 24 h, 3 after integrity endings, RESTART_GAP_MIN apart). A status file that starts with TRACK COMPLETE, or a session a person closed, is left alone.
//   5. Keeps each track chat in Bypass (T-256): one found out of it (a wake or a Resume starts on the start mode) gets the server code again and
//      the acknowledgement, at most every BYPASS_GAP_MIN minutes, and a tool approval it asked meanwhile is denied with "run it again".
//   6. T-257: a track left down for any reason (the start cap, a refusal, a missing Claude, the portal unreachable) opens ONE ticket (tag
//      watchdog) through the API and logs it; starts after an integrity ending the portal classifies as harmless (T-136 `endedFor`; a
//      legacy row: only a second control response) count apart from the cap (MAX_HARMLESS_STARTS of their own). Tested by
//      apps/server/src/keepgoing/supervisor.test.ts. The portal's own watchdog (Keep going, T-259) replaces this script.
//   7. T-259 slice 2: a track whose newest chat has Keep going ON is the portal's (it nudges, wakes, recovers and starts it again itself,
//      inside the cluster): this script leaves that track alone, so the two never both start a chat. It still keeps Bypass on such a chat
//      (the portal does not: the lease is the owner's open decision on T-256) and still answers for the tracks without Keep going.
//   8. T-400 (three duplicate leads during the T-365 outage): a round whose /healthz or session list fails decides nothing, and after one no
//      lead is taken for gone until STEADY_ROUNDS good rounds and HEALTH_QUIET_MIN minutes; a live, recent chat of the track is its lead
//      (adopted before a newer ended one, never started beside); the MOVED text follows only a move this process saw itself.
// Stop it: touch ~/.claudepilot/dev-sessions/STOP (checked every round), or kill the process by PID. State: ~/.claudepilot/dev-sessions/state.json.
// Never logs the code, a cookie or a token.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tokenLease } from '../../tools/coordinator/tokenLease.mjs';

const PORTAL = (process.env.PORTAL_URL ?? 'https://pilot.ai.isnan.me').replace(/\/$/, '');
const CODE = process.env.PORTAL_SERVER_CODE ?? '';
const DEPLOY_RUN = process.env.DEPLOY_RUN ?? '';
const WORKSPACE = process.env.DEV_WORKSPACE ?? 'kubernetes/kohi-event';
const MAIN = process.env.MAIN_FOLDER ?? join(homedir(), 'work/claudepilot');
const STATE_DIR = process.env.STATE_DIR ?? join(homedir(), '.claudepilot/dev-sessions');
const MAX_STARTS = Number(process.env.MAX_STARTS ?? 6);
const RESTART_GAP_MIN = Number(process.env.RESTART_GAP_MIN ?? 5);
const ROUND_S = Number(process.env.ROUND_S ?? 120);
const LIFETIME_H = Number(process.env.LIFETIME_H ?? 24);
const STAGGER_S = Number(process.env.STAGGER_S ?? 90);
/** The orchestrator chat's own model and effort (D-46): a create takes none and falls to the portal's default (sonnet on 2026-10-14), which put an orchestrator on sonnet unannounced. */
const ORCH_MODEL = process.env.ORCH_MODEL ?? 'opus';
const ORCH_EFFORT = process.env.ORCH_EFFORT ?? 'medium';
/** DRY_RUN=1: reads the portal and says what it would do; changes nothing. */
const DRY = process.env.DRY_RUN === '1';

/** What is kept alive: one orchestrator in the main folder (no worktree of its own: its sub-agents make theirs). The Claudes are tried by name, best room first. */
const KONFERSI = process.env.KONFERSI_FOLDER ?? join(homedir(), 'work/konfersi-universe');
const TRADINGBOT = process.env.TRADINGBOT_FOLDER ?? join(homedir(), 'work/tradingbot');
/**
 * D-70 (owner, 2026-10-15): each program's crew is long-lived LANES: a Backend and a Frontend build lane and at most two QA lanes (UI; performance
 * and security), spawned once and fed ticket after ticket, plus one free slot. Shared by the kickoffs and nudges below.
 */
const BUILD_LANES = {
  // D-71: a second backend lane, by area, so the backlog runs in parallel and the quota is used.
  ClaudePilot: `'ClaudePilot Backend' (role lane-backend: chat and sessions, Portal MCP, tickets, knowledge, glance and the lab: APIs, data, performance, security, logic), 'ClaudePilot BE Infra' (role lane-backend: CI and runners, job-run and the cluster Jobs, k3s and deploy, secrets delivery, usage, spend and quota placement), 'ClaudePilot Frontend' (role lane-frontend: UI, UX, Lighthouse)`,
  // The owner's split for Konfersi (2026-10-15): four build lanes by area.
  Konfersi: `'Konfersi FE Business' (role lane-frontend: landing page, courses, console, accounts), 'Konfersi FE Lab' (role lane-frontend: the VS Code web lab at lab.konfersi.com and the standalone app, and all UI/UX responsiveness and UI performance work), 'Konfersi BE Business' (role lane-backend: the generic API, projects, everything in konfersi-backend that is not heavy), 'Konfersi BE Lab & AI' (role lane-backend: metocean compute, the AI reporting rewrites and the rest of lab and AI)`,
};
const LANES = (prog) =>
  `Your crew is LANES (D-70): long-lived worker sessions you spawn once each (session_spawn, claude auto, mode dontAsk, report idle, model sonnet) and keep: the build lanes ${BUILD_LANES[prog]}, and at most two QA lanes: '${prog} QA UI' (role lane-qa-ui: UI/UX, refinement, Lighthouse, responsiveness, journeys end to end) and '${prog} QA Perf' (role lane-qa-perf: performance, security, load tests, API behaviour). Every build lane and one QA lane are always live; give each lane its area in its first brief. Give a lane its next ticket with session_message; never end a lane for lack of work and never start a second session of a live lane. Every delivery goes to the QA lane of its side before you merge (UI to QA UI, the rest to QA Perf; with one QA lane, to it); QA never authors. The free slot is for a blind reviewer (a new sonnet session each time) or an explorer. A lane goes to opus for one ticket only with a why on the ticket (session_configure), then back. The supervisor compacts an idle lane past 120k.`;
const TRACKS = [
  { key: 'orchestrator', title: 'Orchestrator: ClaudePilot dev', claudes: ['hasyim', 'fadlilah', 'alfian.isnan'] },
  // The Konfersi program as a crew (D-52): its own folder, tickets tagged konfersi-migration. Not named Orchestrator: the title prefix finds the track's chats.
  {
    key: 'konfersi',
    title: 'Konfersi: migration',
    folder: KONFERSI,
    claudes: ['alfian.isnan', 'hasyim', 'satria', 'one.claude', 'two.claude', 'sekar'],
    kickoff: (again, reason) =>
      `You are the Konfersi lead, running in ClaudePilot${again ? ` (the earlier chat ended: ${reason}; its live function sessions are now yours: session_family)` : ''}, and the lead of its crew (D-52). You plan, route, merge and deploy to stg; you never implement or verify yourself. Nobody answers questions: decide by the written defaults, write it on the ticket, go on; the owner's ONLY standing action is Konfersi production (D-62): never assign a ticket to the owner or ask him anything else; permissions, secrets within the systems you already use, rule files and gate changes (propose text on a ticket assigned to yourself; a tightening is landed by the coordinator, a loosening after a blind reviewer's PASS, D-60) and stg merges (gated by konfersi-qa's PASS) are the harness's; a ticket assigned to the owner for any of these is a defect. Production questions go as one line on T-93. Read first: ~/work/claudepilot/docs/dev-sessions/CHARTER.md and DECISIONS.md (D-47, D-49, D-51, D-52, D-60, D-61, D-62 bind you), ~/work/claudepilot/docs/kit/skills/orchestration/SKILL.md (the crew rules), your pilot tickets (ticket_list, tag konfersi-migration; status ticket T-84), docs/agentic/OPERATING-MODEL.md and RULES.md in ~/work/agentic-worktrees/orch-charter, git worktree list in ~/work/agentic-worktrees. ${LANES('Konfersi')} Route by area: owner label 39 to FE Business, lab UI to FE Lab, d2 to BE Business, fb and metocean to BE Lab & AI, qp to QA Perf, b9 to QA UI. Live cap 14 in the workspace, at most 7 live workers for you (six lanes and the free slot; D-61, D-68, D-70); QA and review on sonnet (D-63). First, in order: (1) give ~/work/konfersi-universe a .claude/settings.json allow list in D-49's shape (Edit and Write under ~/work/konfersi-universe/**, ~/work/konfersi-universe.worktrees/** and ~/work/agentic-worktrees/**; git status, diff, log, add, commit, fetch, grep, worktree, push of work branches; the modules' test and build commands; deny pushes to stg and main, force pushes and anything production or uat), commit it to a work branch through the normal flow, and check that the portal trusts the folder; (2) prove the job once: one konfersi-qa worker reads a ticket, runs one module's tests and comments its verdict; fix what it could not do before you dispatch more; (3) refresh docs/agentic/OPERATING-MODEL.md so its roles name these sessions; (4) then dispatch by owner label. Heavy jobs only as cluster Jobs through ~/work/claudepilot/scripts/job-run.sh, never in the pod (D-61); stg only; secrets by name only, never printed; commits with Ticket, Pilot-Session and Pilot-Agent trailers; status on T-84 every ~2 h.`,
    nudge: 'Nobody is here to answer. Continue now: look at your pilot tickets (ticket_list, tag konfersi-migration) and your crew (session_family): give each lane its next ticket (session_message), send every delivery to the QA lane of its side before you merge, keep the lanes alive (D-70) and end other workers with no work. If you asked a question, answer it yourself with the default written on the ticket and go on. Do not stop to summarise or wait.',
    wake: (why) => `This chat was interrupted (${why}). Continue where you left off: your pilot tickets (tag konfersi-migration), your crew (session_family), git worktree list in ~/work/agentic-worktrees, and carry on. Nobody is here to answer questions.`,
  },
  // The Event program left pilot on 2026-10-15 (owner, D-67): no track; its work goes on outside pilot.
  // Tradingbot (owner, 2026-10-15, D-74): a paper-trading lab, one lead and two lanes, no human in the loop.
  {
    key: 'tradingbot',
    title: 'Tradingbot: program',
    folder: TRADINGBOT,
    claudes: ['satria', 'sekar', 'two.claude', 'hasyim', 'fadlilah', 'one.claude'],
    kickoff: (again, reason) =>
      `You are the Tradingbot lead, running in ClaudePilot${again ? ` (the earlier chat ended: ${reason}; its live lanes are now yours: session_family)` : ''}: the orchestrator of a paper-trading lab (D-74). You plan, decide, route and merge; you never implement or analyse yourself. No human is in the loop: nobody answers questions, so decide by the rules, write the decision on the ticket and go on; never assign a ticket to the owner or ask him anything (D-62). Read first: ~/work/tradingbot/README.md (the goals) and CLAUDE.md (the rules: PAPER ONLY, never a real order or a key that can trade or withdraw, public data within rate limits, never scrape TradingView's data, the pod limits for installs, tests and long-running processes), and ~/work/claudepilot/docs/dev-sessions/CHARTER.md. Your crew is two long-lived lanes you spawn once each (session_spawn, claude auto, mode dontAsk, report idle, model sonnet, folder ~/work/tradingbot) and keep, giving each its next ticket with session_message: 'Tradingbot Fullstack' (role lane-fullstack: the collectors' code, the paper-trading engine with fees, slippage and latency, the store, the API, the dashboard with TradingView Lightweight Charts, tests, and pilot-browser screenshots at 390 and 1280 px) and 'Tradingbot Analyst' (role lane-analyst: data on intervals from public exchange REST and WebSocket APIs and public sentiment, history, the live market, strategies, backtests out of sample, paper sessions, tooling, and knowledge notes in the vault folder Tradingbot/). At most 2 live workers; never end a lane for lack of work. Tickets: tag tradingbot; your status every ~2 h on T-641. First, in order: (1) write the plan as tickets (collector, paper engine, strategy framework and the first strategies, backtest harness, dashboard v1, sentiment, self-healing run scripts); (2) spawn both lanes with their first tickets at once; (3) reach a working vertical slice soon: live prices into a paper session into a dashboard chart, with screenshots; then (4) improve by measured results only (return, Sharpe or Sortino, drawdown, win rate, fees, exposure, out of sample), and keep the dashboard simple. Self-healing: a dead process is restarted by its script and its cause ticketed. Merge to main only with the evidence of a check by the other lane or you (tests, screenshots, numbers). Commits with Ticket, Pilot-Session and Pilot-Agent trailers.`,
    nudge: 'Nobody is here to answer. Continue now: look at your tradingbot tickets and your two lanes (session_family): give each lane its next ticket, merge what is checked, restart what died, and post your status on T-641 when it is due. If you asked a question, answer it yourself by the rules in ~/work/tradingbot/CLAUDE.md and go on.',
    wake: (why) => `This chat was interrupted (${why}). Continue where you left off: your tradingbot tickets, your lanes (session_family), git status in ~/work/tradingbot, and the run scripts (scripts/*.sh status). Nobody is here to answer questions.`,
  },
];

/** D-61: live workers per lead (the memory budget of the shared pod). */
const LEAD_WORKERS = { orchestrator: 6, konfersi: 7, tradingbot: 2 };

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
/** Run as a script (not imported by its test, apps/server/src/keepgoing/supervisor.test.ts). */
const IS_MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN && !CODE) {
  console.error('PORTAL_SERVER_CODE is not set');
  process.exit(1);
}
mkdirSync(STATE_DIR, { recursive: true });
const STATE_FILE = join(STATE_DIR, 'state.json');
const readState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { tracks: {} });
const saveState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

/* ---------- The portal ---------- */

let cookie = '';
async function login() {
  const res = await fetch(`${PORTAL}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: PORTAL }, body: JSON.stringify({ code: CODE }) });
  if (!res.ok) throw new Error(`sign-in refused (${res.status})`);
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('sign-in gave no session');
}
/** One call; signs in again on a 401 and retries a few times (the portal restarts while a deploy rolls out). */
async function api(method, path, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      if (!cookie) await login();
      const res = await fetch(`${PORTAL}${path}`, { method, headers: { 'content-type': 'application/json', origin: PORTAL, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (res.status === 401) {
        cookie = '';
        if (attempt < 4) continue;
      }
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // a proxy error page while the portal restarts
      }
      if (!json && (res.status >= 500 || res.status === 404) && attempt < 6) {
        await sleep(10);
        continue;
      }
      return { status: res.status, data: json?.data, error: json?.error };
    } catch (e) {
      if (attempt >= 6) throw e;
      cookie = '';
      await sleep(10);
    }
  }
}

/**
 * Portal MCP over HTTP with one admin token for this process (only `session_send` and a few tool calls need it): 1 hour, reused while it
 * has more than 5 minutes left, renewed with `replace` (which also revokes a crashed run's leftover), revoked at exit (T-258).
 */
const mcp = tokenLease({ api, label: 'dev-sessions-supervisor' });
const mcpToken = () => mcp.get();
const revokeMcpToken = () => mcp.revoke();
/** One Portal MCP tool call with the supervisor's admin token. */
async function mcpCall(name, args) {
  const token = await mcpToken();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const init = await fetch(`${PORTAL}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dev-sessions-supervisor', version: '1' } } }) });
  const sid = init.headers.get('mcp-session-id');
  await init.text();
  const res = await fetch(`${PORTAL}/mcp`, { method: 'POST', headers: { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  const out = JSON.parse(line ? line.slice(6) : raw);
  if (out.error || out.result?.isError) throw new Error(`${name}: ${out.error?.message ?? out.result?.content?.[0]?.text ?? 'refused'}`);
  return out.result;
}

async function sessionSend(id, text) {
  if (DRY) return log(`[dry] would send to ${id.slice(0, 8)}: ${text.slice(0, 90)}...`);
  const token = await mcpToken();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const init = await fetch(`${PORTAL}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dev-sessions-supervisor', version: '1' } } }) });
  const sid = init.headers.get('mcp-session-id');
  await init.text();
  const res = await fetch(`${PORTAL}/mcp`, { method: 'POST', headers: { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_send', arguments: { id, text } } }) });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  const out = JSON.parse(line ? line.slice(6) : raw);
  if (out.error || out.result?.isError) throw new Error(`session_send: ${out.error?.message ?? out.result?.content?.[0]?.text ?? 'refused'}`);
}

/* ---------- The deploy ---------- */

async function runState(id) {
  const r = await api('GET', `/api/ci/runs/${encodeURIComponent(id)}`);
  const run = r.data;
  return run ? { status: run.status, number: run.number, sha: String(run.sha ?? '').slice(0, 8), release: run.detail?.find((j) => j.id === 'release')?.status ?? null } : null;
}

async function deploy() {
  log(`deploy: waiting for run ${DEPLOY_RUN}`);
  const until = Date.now() + 120 * 60_000;
  for (;;) {
    const s = await runState(DEPLOY_RUN);
    if (!s) throw new Error('deploy: no such run');
    if (['failed', 'cancelled'].includes(s.status)) throw new Error(`deploy: run #${s.number} ${s.status}`);
    if (s.status === 'passed') return log(`deploy: run #${s.number} already passed`);
    if (s.release === 'waiting') {
      if (DRY) {
        log(`[dry] would approve the release of run #${s.number}`);
        return;
      }
      const r = await api('POST', `/api/ci/runs/${encodeURIComponent(DEPLOY_RUN)}/approve`, { job: 'release' });
      if (r.error && r.error.code !== 'CONFLICT') throw new Error(`deploy: approval refused: ${r.error.message}`);
      log(`deploy: run #${s.number} (${s.sha}) approved for the owner, as asked`);
      break;
    }
    if (Date.now() > until) throw new Error('deploy: gave up waiting for the release job');
    await sleep(15);
  }
  const end = Date.now() + 60 * 60_000;
  for (;;) {
    const s = await runState(DEPLOY_RUN);
    if (s?.status === 'passed') return log(`deploy: run #${s.number} passed (released and verified)`);
    if (!s || ['failed', 'cancelled'].includes(s.status)) throw new Error(`deploy: run ${s?.number ?? '?'} ${s?.status ?? 'gone'} after the approval`);
    if (Date.now() > end) throw new Error('deploy: the run did not finish in an hour');
    await sleep(15);
  }
}

/* ---------- The sessions ---------- */

let claudeIds = null;
async function claudeIdOf(name) {
  if (!claudeIds) {
    const r = await api('GET', `/api/chat/claudes?workspaceId=${encodeURIComponent(WORKSPACE)}`);
    claudeIds = new Map((r.data ?? []).map((c) => [c.name, c.id]));
  }
  return claudeIds.get(name) ?? null;
}
/** The Claude of `names` with the most room (the lowest used share of its fullest plan window); a Claude whose usage is unknown counts as empty. */
/**
 * T-460: the ids of the Claudes auto move would leave now (below the move threshold, or projected to run out), asked of the portal
 * (`GET /api/autotransfer/leaving`: the server's one projection rule, never a copy here). An answer that fails is an empty set (the old
 * behaviour), said in the log.
 */
async function leavingIds(model) {
  const r = await api('GET', `/api/autotransfer/leaving${model ? `?model=${encodeURIComponent(model)}` : ''}`);
  if (r.error || !Array.isArray(r.data?.claudes)) return log(`could not read which Claudes auto move would leave (${r.error?.message ?? 'no answer'}): not filtering`), new Set();
  return new Set(r.data.claudes.filter((c) => c.leaves).map((c) => c.claudeId));
}
/**
 * The Claude of `names` with the most room (the lowest used share of its fullest plan window); a Claude whose usage is unknown counts as empty.
 * Never one auto move would leave (T-460: a lead started on a Claude at 22% left, projected 143%, was moved off it five minutes later); with
 * every one of them leaving, the least used of them, and the log says so.
 */
async function bestClaude(names) {
  const r = await api('GET', '/api/claude-usage');
  const used = new Map((r.data?.claudes ?? []).map((c) => [c.claudeId ?? c.id, Math.max(0, ...(c.windows ?? []).map((w) => (typeof w.usedPct === 'number' ? w.usedPct : 0)))]));
  const leaving = await leavingIds(null);
  let best = null;
  let leaver = null;
  for (const name of names) {
    const id = await claudeIdOf(name);
    if (!id) continue;
    const u = used.get(id) ?? 0;
    const cand = { name, id, used: u };
    if (leaving.has(id)) {
      if (!leaver || u < leaver.used) leaver = cand;
      continue;
    }
    if (!best || u < best.used) best = cand;
  }
  if (!best && leaver) log(`every delegated Claude is one auto move would leave: starting on ${leaver.name} anyway (${leaver.used}% used)`);
  return best ?? leaver;
}


/**
 * Stopgap until the portal's auto move waits and resumes by itself (T-105): a chat that is idle on a Claude with 10% or less left (or a spent
 * session window) moves to the delegated Claude with the most room above 10%, handoff skipped when the source is spent; with none above the
 * threshold it stays where it is and is looked at again on every round, so it moves the moment a Claude has room again. The continue nudge
 * that follows is the normal idle nudge. Never while a turn runs (the portal's own boundary rule).
 */
const LOW_USED_PCT = Number(process.env.LOW_USED_PCT ?? 90);
async function moveIfLow(t, ts, cur) {
  const r = await api('GET', '/api/claude-usage');
  const used = new Map((r.data?.claudes ?? []).map((c) => [c.claudeId ?? c.id, Math.max(0, ...(c.windows ?? []).map((w) => (typeof w.usedPct === 'number' ? w.usedPct : 0)))]));
  const mine = used.get(cur.claudeId);
  if (mine === undefined || mine < LOW_USED_PCT) return false;
  // A chat on a model only some Claudes have (Fable shows as its own window on those) goes to one that has it first; with none, to another
  // Claude with the model it should run there in the switch request (T-109: the portal applies it, verifies it and falls down the chain).
  const gated = /fable/i.exec(cur.model ?? '')?.[0]?.toLowerCase() ?? null;
  const has = new Map((r.data?.claudes ?? []).map((c) => [c.claudeId ?? c.id, (c.windows ?? []).some((w) => `${w.key ?? ''} ${w.label ?? ''}`.toLowerCase().includes(gated ?? '\u0000'))]));
  let best = null;
  let other = null;
  const leaving = await leavingIds(cur.model ?? null);
  for (const name of t.claudes) {
    const id = await claudeIdOf(name);
    if (!id || id === cur.claudeId) continue;
    const u = used.get(id) ?? 0;
    if (u >= LOW_USED_PCT || leaving.has(id)) continue;
    if (gated && !has.get(id)) {
      if (!other || u < other.used) other = { name, id, used: u, model: 'opus' };
      continue;
    }
    if (!best || u < best.used) best = { name, id, used: u };
  }
  best = best ?? other;
  if (!best) {
    if (ts.lowLoggedAt === undefined || Date.now() - ts.lowLoggedAt > 30 * 60_000) log(`${t.key}: its Claude is at ${mine}% used and no delegated Claude has more than ${100 - LOW_USED_PCT}% left: waiting, looking again every round`), (ts.lowLoggedAt = Date.now());
    return false;
  }
  const on = best.model ? ` on ${best.model}` : '';
  if (DRY) return log(`[dry] ${t.key}: would move ${cur.id.slice(0, 8)} from ${mine}% used to ${best.name}${on} (${best.used}% used)`), false;
  const res = await api('POST', `/api/chat/sessions/${cur.id}/switch`, { claudeId: best.id, handoff: mine >= 100 ? 'skip' : 'ask', ...(best.model ? { model: best.model } : {}) });
  if (res.error) {
    log(`${t.key}: could not move to ${best.name}: ${res.error.message}`);
    ts.backoffUntil = Date.now() + 5 * 60_000;
    return false;
  }
  ts.lowLoggedAt = undefined;
  log(`${t.key}: its Claude was at ${mine}% used: moved to ${best.name}${on} (${best.used}% used)`);
  return true;
}

const kickoff = (t, again, reason) =>
  again
    ? `You are the continuation of the ${t.title} session, which ended (${reason}). Nobody answers questions: decide, write it down, go on; the owner's only standing action is Konfersi production (D-62): never assign a ticket to the owner, tag it owner-checklist or ask him anything else; persona tools, permissions, rule files and gates are the harness's (propose on a ticket assigned to yourself; the coordinator lands it, D-60). First read docs/dev-sessions/README.md, docs/dev-sessions/orchestrator.md and your status file docs/dev-sessions/status/${t.key}.md. Sub-agents of the earlier session are gone: look at git worktree list, git status -sb and git log --oneline origin/integration..HEAD in each worktree under ~/work/claudepilot.worktrees/ for what is unmerged, keep what is good, then continue from NEXT. When the whole backlog is done, make TRACK COMPLETE the first line of the status file, commit and push, and end with the final report.`
    : `You are the ${t.title} session: the one autonomous development session of ClaudePilot and the lead of its crew (D-47, D-48, D-49): implementation, verification, review and exploration all run as worker sessions (Portal MCP session_spawn with claude auto, role, mode dontAsk, an explicit model, worktree for implementers, report idle) so the load spreads over the Claude accounts; no Agent-tool sub-agents of your own (off, D-61); you wait for the workers' one-line reports, never poll. ${LANES('ClaudePilot')} Nobody answers questions: decide, write it down, go on; the owner's only standing action is Konfersi production (D-62): never assign a ticket to the owner, tag it owner-checklist or ask him anything else; persona tools, permissions, rule files and gates are the harness's (propose on a ticket assigned to yourself; the coordinator lands it, D-60). First read docs/dev-sessions/README.md (the rules that bind you, every sub-agent and every worker), docs/dev-sessions/orchestrator.md (your brief, its Crew rule) and docs/context-pack.md, then start: read your status file docs/dev-sessions/status/${t.key}.md (create it if missing), and dispatch up to your worker limit (5 live workers, D-61, D-65 and D-67; QA and review on sonnet, D-63; you never implement or verify yourself). A supervisor watches you: if you go idle it tells you to continue. Do not rename the chat.`;

/**
 * The create request. A start again names the ended session it continues (T-270): the portal links the lineage and moves that chat's tickets
 * (and its ended predecessors') to the new one in the same step, so nobody has to reassign them by hand.
 */
/** What the supervisor sends to recover a chat in place: it is an agent to the portal (T-136), so only a person brings back a suspicious cause. */
const recoverBody = () => ({ by: 'agent' });
/** What a recover answer means: back in place; wait (the pause between recoveries, or the portal restarting); or a new session (absent, the cap, a suspicious cause, a person's close). */
const recoverVerdict = (r) => (!r.error && r.status < 300 ? 'recovered' : r.error?.code === 'RECOVER_PAUSED' || r.status >= 500 ? 'wait' : 'new');
// T-561: `lead: true` marks it a crew lead: with the portal's `sessions.leadRules` policy on, it launches with the lead rules (an older portal ignores it).
const createBody = (t, claudeId, continuedFrom) => ({ workspaceId: WORKSPACE, title: t.title, claudeId, allowBypass: true, lead: true, cwd: t.folder ?? MAIN, ...(continuedFrom ? { continuedFrom } : {}) });

async function startSession(t, tstate, again, reason, continuedFrom = null) {
  const pick = await bestClaude(t.claudes);
  if (!pick) throw new Error(`none of ${t.claudes.join(', ')} is a Claude on ${WORKSPACE}`);
  if (DRY) return log(`[dry] ${t.key}: would ${again ? 'start again' : 'start'} on ${pick.name} (${pick.used}% used) (${reason})`);
  const claudeName = pick.name;
  const claudeId = pick.id;
  const body = createBody(t, claudeId, continuedFrom);
  let r = await api('POST', '/api/chat/sessions', body);
  if (r.error?.code === 'FOLDER_UNTRUSTED') {
    // The folder holds the repository's own .claude/settings.json (allow and deny rules only: no hooks, MCP servers, plugins or env).
    const scan = r.error.details ?? {};
    if (scan.hooks?.length || scan.mcpServers?.length || scan.plugins?.length || scan.envNames?.length) throw new Error('the folder\'s project settings now load hooks, MCP servers, plugins or env: not trusting that unattended');
    const tr = await api('POST', '/api/chat/trust', { workspaceId: WORKSPACE, folder: scan.folder, hash: scan.hash });
    if (tr.error) throw new Error(`trust refused: ${tr.error.message}`);
    log(`${t.key}: trusted ${scan.folder} (${scan.allowRules} allow rules)`);
    r = await api('POST', '/api/chat/sessions', body);
  }
  const s = r.data;
  if (!s?.id) throw new Error(`create refused: ${r.error?.code ?? r.status} ${r.error?.message ?? ''}`);
  for (let i = 0; i < 40; i++) {
    const cur = (await api('GET', `/api/chat/sessions/${s.id}`)).data;
    if (cur && ['idle', 'waiting', 'working'].includes(cur.state)) break;
    if (cur?.state === 'ended') throw new Error(`the new session ended at once: ${cur.endedReason}`);
    await sleep(3);
  }
  // Bypass: the server code again (the same cookie), then the tick.
  const re = await api('POST', '/api/chat/reauth', { code: CODE });
  if (re.error) throw new Error(`reauth refused: ${re.error.message}`);
  const bp = await api('POST', `/api/chat/sessions/${s.id}/bypass`, { acknowledged: true });
  if (bp.error) throw new Error(`Bypass refused: ${bp.error.code} ${bp.error.message}`);
  const mode = (await api('GET', `/api/chat/sessions/${s.id}`)).data?.mode;
  if (mode !== 'bypassPermissions') throw new Error(`Bypass did not turn on (mode ${mode})`);
  // The model and effort are set on the record (D-46) before the kickoff, through the Portal MCP (session_configure); a refusal is logged, not fatal.
  const model = t.model ?? ORCH_MODEL, effort = t.effort ?? ORCH_EFFORT;
  try {
    const out = await mcpCall('session_configure', { id: s.id, model, effort });
    if (out?.error || out?.result?.isError) throw new Error(out.error?.message ?? out.result?.content?.[0]?.text ?? 'refused');
    log(`${t.key}: model ${model}, effort ${effort}`);
  } catch (e) { log(`${t.key}: could not set model ${model}: ${e.message}; it runs on the portal default`); }
  // D-61: a lead runs no Agent-tool sub-agents (they ran inside its process and on its Claude, and caused the 02:11 OOM) and at most a few
  // live workers. `subagents` applies at the process's next start: a fresh lead is restarted at once, before its kickoff (no context yet),
  // and must come back in Bypass. A refusal is logged, not fatal.
  try {
    const out = await mcpCall('session_configure', { id: s.id, subagents: false, max_workers: LEAD_WORKERS[t.key] ?? 3 });
    if (out?.error || out?.result?.isError) throw new Error(out.error?.message ?? out.result?.content?.[0]?.text ?? 'refused');
    const needed = out?.result?.structuredContent?.restart_needed ?? out?.result?.structuredContent?.restartNeeded;
    if (needed !== false) {
      const rs = await api('POST', `/api/chat/sessions/${s.id}/restart`, { why: 'manual' });
      if (rs.error) throw new Error(`restart refused: ${rs.error.code} ${rs.error.message}`);
      const after = (await api('GET', `/api/chat/sessions/${s.id}`)).data?.mode;
      if (after !== 'bypassPermissions') throw new Error(`not in Bypass after the restart (mode ${after})`);
    }
    log(`${t.key}: sub-agents off, at most ${LEAD_WORKERS[t.key] ?? 3} workers`);
  } catch (e) { log(`${t.key}: could not turn sub-agents off: ${e.message}`); }
  await sessionSend(s.id, t.kickoff ? t.kickoff(again, reason) : kickoff(t, again, reason));
  tstate.sessionId = s.id;
  tstate.cwd = s.cwd;
  (tstate.starts ??= []).push(Date.now());
  log(`${t.key}: ${again ? 'started again' : 'started'} session ${s.id.slice(0, 8)} on ${claudeName} in ${s.cwd}${continuedFrom ? ` (continues ${continuedFrom.slice(0, 8)}: its tickets moved with it)` : ''}`);
}

const statusSaysDone = (tstate) => {
  if (!tstate.cwd) return false;
  const f = join(tstate.cwd, 'docs/dev-sessions/status', `${tstate.key}.md`);
  try {
    return /^\s*TRACK COMPLETE/.test(readFileSync(f, 'utf8'));
  } catch {
    return false;
  }
};

const NUDGE = 'Nobody is here to answer. Continue now: integrate what finished sub-agents and worker sessions brought, give each lane its next ticket (session_message) and keep the lanes alive (D-70), within your worker limit (6 live workers, D-71; sub-agents are off; QA and review on sonnet, D-63; you never implement yourself), keep your status file current. If you asked a question, answer it yourself with the PRD default and go on. When the whole backlog is done, make TRACK COMPLETE the first line of your status file, commit and push it, and end with the final report. Do not stop to summarise or wait.';
const WAKE = (why) => `This session was interrupted (${why}). Continue where you left off: read your status file docs/dev-sessions/status/orchestrator.md, look at git worktree list and git status in each worktree, and carry on. Nobody is here to answer questions.`;
const MOVED = (to) => `This chat was moved to another Claude (${to}) and its process restarted: the sub-agents of the old process stopped. Continue now where you stopped: look at your tickets or status file, git worktree list and git status, restart the work that was in flight, commit and push WIP early. Nobody is here to answer questions.`;
const NUDGE_AFTER_MIN = Number(process.env.NUDGE_AFTER_MIN ?? 3);
const NUDGE_GAP_MIN = Number(process.env.NUDGE_GAP_MIN ?? 10);
const MAX_NUDGES = Number(process.env.MAX_NUDGES ?? 40);
/**
 * T-423, D-65: every turn of a lead re-reads its whole context (cache reads were half the crews' dollars, leads 67-78% of them, at 150-480k
 * tokens). An idle lead past COMPACT_AT tokens is told to `/compact` (allowed over MCP), at most once every COMPACT_GAP_MIN: the same chat, its
 * workers and Bypass stay; only the transcript shrinks.
 */
// ON since T-597 shipped (deploy #89, 2026-10-15): the portal passes an allowed slash command through unframed, and a real `/compact` took the
// tradingbot lead from 117k to 49k. Set COMPACT_AT=Infinity to turn it off.
const COMPACT_AT = Number(process.env.COMPACT_AT ?? 120_000);
const COMPACT_GAP_MIN = Number(process.env.COMPACT_GAP_MIN ?? 30);
const COMPACT =
  '/compact Keep only what your next turns need: your crew (each live worker: session id, function, the ticket it works on), the tickets in flight with their state and next step, branches waiting to merge or deploy, decisions taken today and why, and the rules that bind you (charter, D-61 to D-67). Drop tool output, diffs, logs and finished work.';
const COMPACT_LANE =
  '/compact Keep only what your next tickets need: your program, repository, integration line, areas and commands from your first brief, the rules that bind you, and open follow-ups with their ticket ids. Drop finished diffs, tool output and logs.';
/** D-70: an idle lane past COMPACT_AT is compacted like a lead (each lane at most every COMPACT_GAP_MIN); ended lanes leave the state. */
async function compactLanes(t, ts, sessions, cur) {
  const lanes = sessions.filter((x) => x.parentId === cur.id && /^lane-/.test(x.agent ?? '') && x.state !== 'ended');
  const last = Object.fromEntries(Object.entries(ts.laneCompacted ?? {}).filter(([id]) => lanes.some((l) => l.id === id)));
  for (const w of lanes) {
    if (!compactDue(w, { compactedAt: last[w.id] })) continue;
    last[w.id] = Date.now();
    try {
      await sessionSend(w.id, COMPACT_LANE);
      log(`${t.key}: lane ${String(w.title ?? w.id.slice(0, 8)).slice(0, 40)} at ${Math.round(w.context.usedTokens / 1000)}k: told to compact`);
    } catch (e) {
      log(`${t.key}: could not compact lane ${w.id.slice(0, 8)}: ${e.message}`);
    }
  }
  ts.laneCompacted = last;
}
/** Whether an idle lead is due a compaction now. */
function compactDue(cur, ts, now = Date.now()) {
  const used = cur?.context?.usedTokens ?? 0;
  return cur?.state === 'idle' && used >= COMPACT_AT && now - (ts?.compactedAt ?? 0) >= COMPACT_GAP_MIN * 60_000;
}
/**
 * D-65: a nudge only costs a turn that re-reads the lead's context, so a lead whose worker slots are all busy (working, active in the last 15
 * min) is left alone: their reports wake it. With a free slot it is nudged, so idle workers and an open backlog never wait on one busy worker.
 */
function slotsFull(sessions, cur, cap, now = Date.now()) {
  const busy = sessions.filter((x) => x.parentId === cur.id && x.state === 'working' && now - Date.parse(x.lastActivityAt ?? 0) < 15 * 60_000).length;
  return busy >= cap;
}

/**
 * A session waiting for an answer: a QUESTION (AskUserQuestion, an elicitation) is answered with a denial that tells it to decide itself, so it goes on; nobody is
 * here. A TOOL approval is left to a person on purpose (with the ask rules gone only Claude Code's own protection of .git and .claude can still raise one, and
 * approving that would let an agent edit its own deny rules): it is logged once with what it asks.
 */
async function answerWaiting(t, ts, cur) {
  const events = (await api('GET', `/api/chat/sessions/${cur.id}/events?after=${ts.seqFloor ?? 0}`)).data ?? [];
  const list = Array.isArray(events) ? events : [];
  const resolved = new Set(list.filter((e) => e.kind === 'resolved').map((e) => e.requestId));
  ts.seqFloor = Math.max(0, (list[list.length - 1]?.seq ?? 0) - 300);
  ts.toolWaitLogged ??= [];
  for (const e of list.filter((x) => x.kind === 'request' && x.request && !resolved.has(x.request.requestId))) {
    const q = e.request;
    if (q.kind === 'question' || q.kind === 'elicitation') {
      if (DRY) {
        log(`[dry] ${t.key}: would deny a ${q.kind}: ${String(q.detail ?? '').slice(0, 80)}`);
        continue;
      }
      try {
        await mcpCall('session_respond', { id: cur.id, request_id: q.requestId, decision: 'deny', message: 'Nobody is here to answer. Decide yourself with the PRD default, write the decision in your status file, and go on.' });
        log(`${t.key}: a ${q.kind} was asked (${String(q.detail ?? '').slice(0, 80)}): answered "decide yourself"`);
      } catch (err) {
        log(`${t.key}: could not answer a ${q.kind}: ${err.message}`);
      }
    } else if (q.kind === 'tool' && !ts.toolWaitLogged.includes(q.requestId)) {
      ts.toolWaitLogged = [...ts.toolWaitLogged.slice(-20), q.requestId];
      log(`${t.key}: a tool approval waits for a person: ${q.toolName}: ${String(q.detail ?? '').replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }
}

/**
 * Bypass on every round (T-256). A track chat runs in Bypass (D-3), but a wake from sleep or a Resume after a crash starts it on the start mode
 * (chat-sessions FR20, FR38: the portal never restores it there by itself), and its first command then waits for an approval nobody gives: the
 * Event chat waited 19:33 to 00:22 on 2026-10-13. So when a track's chat is not in Bypass, this re-asserts it through the same gates a person
 * passes (the server code again, then the acknowledgement; the policy and the session's own opt-in are the portal's checks) and logs one line.
 * A tool approval asked before that is denied with "run it again" (denying runs nothing; approving stays a person's). `wake`: the chat may be
 * asleep or interrupted, and the caller is about to message it anyway (entering Bypass wakes it first, so its first command does not ask).
 */
const BYPASS_GAP_MIN = Number(process.env.BYPASS_GAP_MIN ?? 5);
async function ensureBypass(t, ts, cur, wake = false) {
  if (t.bypass === false || !cur || cur.mode === 'bypassPermissions' || cur.switching || cur.archivedAt) return;
  if (!['idle', 'waiting', 'working', ...(wake ? ['interrupted'] : [])].includes(cur.state)) return;
  if (!wake && cur.process !== 'live') return; // asleep: re-asserted right before the next message wakes it
  if (!cur.bypassCapable) {
    if (ts.bypassNotCapable !== cur.id) log(`${t.key}: in ${cur.mode}, not Bypass, and the session was not started to allow it: a person must restart it for Bypass`), (ts.bypassNotCapable = cur.id);
    return;
  }
  if (ts.bypassAt && Date.now() - ts.bypassAt < BYPASS_GAP_MIN * 60_000) return;
  ts.bypassAt = Date.now();
  if (DRY) return log(`[dry] ${t.key}: in ${cur.mode}, not Bypass: would enter the server code again and turn Bypass back on`);
  const re = await api('POST', '/api/chat/reauth', { code: CODE });
  if (re.error) return log(`${t.key}: in ${cur.mode}, not Bypass: the server code was refused (${re.error.code ?? re.status})`);
  const bp = await api('POST', `/api/chat/sessions/${cur.id}/bypass`, { acknowledged: true });
  const mode = bp.error ? null : (await api('GET', `/api/chat/sessions/${cur.id}`)).data?.mode;
  if (mode !== 'bypassPermissions') return log(`${t.key}: in ${cur.mode}, not Bypass: re-asserting it failed (${bp.error ? `${bp.error.code} ${bp.error.message}` : `mode ${mode}`})`);
  const stale = await denyStaleToolApprovals(cur).catch(() => 0);
  log(`${t.key}: was in ${cur.mode}, not Bypass: Bypass on again${stale ? ` (${stale} tool approval${stale === 1 ? '' : 's'} asked before it denied with "run it again")` : ''}`);
}

/** Tool approvals still open on a chat that is in Bypass now: each was asked before it, and Claude Code does not ask them again by itself. */
async function denyStaleToolApprovals(cur) {
  const events = (await api('GET', `/api/chat/sessions/${cur.id}/events?after=${Math.max(0, (cur.lastSeq ?? 0) - 500)}`)).data ?? [];
  const list = Array.isArray(events) ? events : [];
  const resolved = new Set(list.filter((e) => e.kind === 'resolved').map((e) => e.requestId));
  let n = 0;
  for (const e of list.filter((x) => x.kind === 'request' && x.request?.kind === 'tool' && !resolved.has(x.request.requestId))) {
    await mcpCall('session_respond', { id: cur.id, request_id: e.request.requestId, decision: 'deny', message: 'This chat was out of Bypass by mistake and Bypass is on again: this approval is dropped. Run the same command again; it will not ask. Nobody is here to answer questions.' });
    n++;
  }
  return n;
}

/**
 * Folder trust is tied to the hash of .claude/settings.json: a commit that touches it makes the next Move, restart or wake of a session in the main folder fail
 * with FOLDER_UNTRUSTED until a person trusts the new hash (ticket T-38 asks the portal to do this itself). Until it does, this supervisor re-trusts a folder
 * whose scan lists NO hooks, MCP servers, plugins or env names (only permission rules), and says so; anything else is left for a person and logged.
 */
async function ensureTrust() {
  for (const folder of new Set(TRACKS.map((t) => t.folder ?? MAIN))) await ensureTrustOf(folder);
}
async function ensureWorktreeTrust(sessions) {
  // A crew worker's worktree (2026-10-15: a lane stood still on FOLDER_UNTRUSTED after its branch merged integration): its rules come from
  // its own branch, which a worker can change, so it is trusted again ONLY when its settings hash is one the portal already trusted for this
  // workspace (seen trusted on a scan: reviewed content) and it loads nothing but permission rules.
  const leads = new Set(sessions.filter((s) => TRACKS.some((t) => (s.title ?? '').startsWith(t.title))).map((s) => s.id));
  const folders = new Set(sessions.filter((s) => s.state !== 'ended' && leads.has(s.parentId) && s.cwd).map((s) => s.cwd));
  for (const folder of folders) await ensureTrustOfWorktree(folder);
}
/** Settings hashes seen trusted on this workspace, in a file of their own (the round's state is written back whole), so a restart remembers them. */
const TRUSTED_FILE = join(STATE_DIR, 'trusted-hashes.json');
const knownTrusted = new Set((() => {
  try {
    return existsSync(TRUSTED_FILE) ? JSON.parse(readFileSync(TRUSTED_FILE, 'utf8')) : [];
  } catch {
    return [];
  }
})());
function rememberTrusted(hash) {
  if (!hash || knownTrusted.has(hash)) return;
  knownTrusted.add(hash);
  writeFileSync(TRUSTED_FILE, JSON.stringify([...knownTrusted].slice(-200)));
}
/** Whether a worktree's scan may be trusted without a person: rules only, and content the portal trusted before. */
function worktreeTrustable(scan, known) {
  if (!scan || scan.trusted || scan.empty) return false;
  if (scan.hooks?.length || scan.mcpServers?.length || scan.plugins?.length || scan.envNames?.length) return false;
  return known.has(scan.hash);
}
async function ensureTrustOfWorktree(folder) {
  const scan = (await api('GET', `/api/chat/trust/scan?workspaceId=${encodeURIComponent(WORKSPACE)}&folder=${encodeURIComponent(folder)}`)).data;
  if (!scan) return;
  if (scan.trusted) return rememberTrusted(scan.hash);
  if (!worktreeTrustable(scan, knownTrusted)) {
    if (!scan.empty && !trustLogged.has(scan.hash)) log(`folder trust: ${folder} has settings never trusted here (or loads more than rules): left for the coordinator`), trustLogged.add(scan.hash);
    return;
  }
  if (DRY) return log(`[dry] would trust the worktree ${folder} (settings already trusted elsewhere)`);
  const tr = await api('POST', '/api/chat/trust', { workspaceId: WORKSPACE, folder: scan.folder ?? folder, hash: scan.hash });
  log(tr.error ? `folder trust: refused: ${tr.error.message}` : `folder trust: the worktree ${folder} has settings already trusted here (${scan.allowRules} rules): trusted`);
}
async function ensureTrustOf(folder) {
  const scan = (await api('GET', `/api/chat/trust/scan?workspaceId=${encodeURIComponent(WORKSPACE)}&folder=${encodeURIComponent(folder)}`)).data;
  if (scan?.trusted) rememberTrusted(scan.hash);
  if (!scan || scan.trusted || scan.empty) return;
  if (scan.hooks?.length || scan.mcpServers?.length || scan.plugins?.length || scan.envNames?.length) {
    if (!trustLogged.has(scan.hash)) log(`folder trust: the project settings now load hooks, MCP servers, plugins or env: a person must look (${folder})`), trustLogged.add(scan.hash);
    return;
  }
  if (DRY) return log(`[dry] would trust ${folder} (${scan.allowRules} permission rules, nothing else)`);
  const tr = await api('POST', '/api/chat/trust', { workspaceId: WORKSPACE, folder: scan.folder ?? folder, hash: scan.hash });
  log(tr.error ? `folder trust: refused: ${tr.error.message}` : `folder trust: the permission rules of ${folder} changed (${scan.allowRules} rules, no hooks, servers, plugins or env): trusted again`);
  if (!tr.error) rememberTrusted(scan.hash);
}
const trustLogged = new Set();

const within24h = (list) => (list ?? []).filter((x) => Date.now() - x < 24 * 3_600_000);

/**
 * T-257 item 2: an integrity ending T-136 classifies as harmless (a duplicate control response, a peer message after a sub-agent's) is the
 * harness's, not the chat's: a start after one does not count against MAX_STARTS or the 3-after-integrity cap. It has its own ceiling,
 * MAX_HARMLESS_STARTS per 24 h, so a loop of them still stops (and is reported).
 * The portal's own classification (`endedFor.classified`, T-136 slice 2) decides; a row without one (a portal before slice 2) is read from
 * its reason the way the portal reads legacy rows (chat/integrity.ts readEnding): only "a second control response for request <id>" is
 * harmless. "origin peer" alone is NOT: a peer line that no task of the process sent ends the same way and is suspicious.
 */
const MAX_HARMLESS_STARTS = Number(process.env.MAX_HARMLESS_STARTS ?? 12);
const harmlessEnding = (s) => {
  if (!/^integrity: /.test(s?.endedReason ?? '')) return false;
  if (s.endedFor?.classified) return s.endedFor.classified === 'harmless';
  return /^integrity: a second control response for request \S+$/.test(s.endedReason);
};

/**
 * T-257 item 1: a track left down for any reason (the start cap, a refusal, a missing Claude, a network error) opens ONE ticket through the
 * API (`POST /api/tickets`, type bug, priority high, tag watchdog) and logs it; the same cause is not reported again until the track runs
 * again. DRY_RUN only says what it would open. The ticket holds the reason the portal gave (never the code, a cookie or a token).
 */
async function reportDown(t, ts, cause, detail) {
  ts.downReported ??= {};
  if (ts.downReported[cause]) return;
  const at = new Date().toISOString();
  const summary = `${t.title}: left down (${cause}) since ${at.slice(11, 16)} UTC`.slice(0, 140);
  const description = [
    `The supervisor (docs/dev-sessions/supervisor.mjs) left the track \`${t.key}\` down and cannot start it again by itself.`,
    '',
    `- Cause: ${cause}`,
    `- Since: ${at}`,
    `- Last session: ${ts.sessionId ?? 'none'}`,
    `- Detail: ${String(detail ?? '').replace(/\s+/g, ' ').slice(0, 300)}`,
    `- Starts in 24 h: ${within24h(ts.starts).length} (after harmless endings: ${within24h(ts.harmless).length})`,
    '',
    'A person (or the portal watchdog, T-259) starts it again. This ticket is not repeated while the cause stands.',
  ].join('\n');
  if (DRY) {
    ts.downReported[cause] = { at, id: null };
    return log(`[dry] ${t.key}: would open a watchdog ticket: ${summary}`);
  }
  try {
    const r = await api('POST', '/api/tickets', { type: 'bug', priority: 'high', tags: ['watchdog'], summary, description, workspaceId: WORKSPACE });
    if (r.error || !r.data?.id) throw new Error(r.error?.message ?? `status ${r.status}`);
    ts.downReported[cause] = { at, id: r.data.id };
    log(`${t.key}: left down (${cause}): opened ${r.data.id}`);
  } catch (e) {
    log(`${t.key}: left down (${cause}) and the ticket could not be opened: ${e.message}`);
  }
}
/** What a failed start says about why the track is left down. */
const downCause = (msg) =>
  /is a Claude on/.test(msg) ? 'missing_claude' : /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(msg) ? 'network' : /refused|did not turn on|not trusting/i.test(msg) ? 'refused' : 'start_failed';

/**
 * T-400 item 1: during the portal outage of 2026-10-15 (T-365) the session list answered 502/503, read as an empty list, and a NEW lead was
 * started for every track while the real ones worked. A round fails when /healthz or the list does not answer; after a failed round nothing is
 * decided about a lead being gone (no recover, no start, no "closed by a person") until STEADY_ROUNDS good rounds in a row (6 minutes at the
 * default ROUND_S) AND HEALTH_QUIET_MIN minutes since the last failure.
 */
const STEADY_ROUNDS = Number(process.env.STEADY_ROUNDS ?? 3);
const HEALTH_QUIET_MIN = Number(process.env.HEALTH_QUIET_MIN ?? 5);
/**
 * T-400 items 2 and 3: a live chat of a track (not ended, not archived, not a worker: no parent) with activity in the last ADOPT_RECENT_H hours
 * is the track's lead: it is watched (adopted) instead of a newer ended one, and no new lead is started beside it. An idle lead is nudged every
 * NUDGE_GAP_MIN minutes, so a real one is far more recent than this.
 */
const ADOPT_RECENT_H = Number(process.env.ADOPT_RECENT_H ?? 2);
/** A chat of the track by its title; a worker a lead spawned (it has a parent) is never the track's chat. */
const ofTrack = (t, x) => !x.parentId && String(x.title ?? '').startsWith(t.title.split(':')[0]);
const liveChatOf = (t, sessions, sessionId = null) =>
  sessions
    .filter((x) => (x.id === sessionId || ofTrack(t, x)) && x.state !== 'ended' && !x.archivedAt)
    .filter((x) => Date.now() - Date.parse(x.lastActivityAt ?? x.createdAt) < ADOPT_RECENT_H * 3_600_000)
    .sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)))[0] ?? null;
/** /healthz answers ok (one plain call, no retries: a failure is what this asks about). */
async function healthy() {
  try {
    const res = await fetch(`${PORTAL}/healthz`, { signal: AbortSignal.timeout(15_000) });
    await res.text();
    return res.ok;
  } catch {
    return false;
  }
}

/** `rounds`: how many rounds to watch before returning (the test runs one or two; the script runs until LIFETIME_H). */
async function watch({ rounds = Infinity } = {}) {
  const until = Date.now() + LIFETIME_H * 3_600_000;
  const idleSince = new Map();
  let stagger = false;
  let netDownSince = null;
  // T-400 item 1: when a round last failed (null: none since this process started) and the good rounds since.
  let badAt = null;
  let goodRounds = 0;
  // T-400 item 4: chat id -> the Claude this process last saw it on; a move is only one it saw itself.
  const seenClaude = new Map();
  while (Date.now() < until && rounds-- > 0) {
    if (existsSync(join(STATE_DIR, 'STOP'))) return log('STOP file found: leaving the sessions as they are');
    await ensureTrust().catch((e) => log(`folder trust: could not check: ${e.message}`));
    const state = readState();
    let list;
    let failed = (await healthy()) ? null : '/healthz did not answer ok';
    if (!failed) {
      try {
        const r = await api('GET', '/api/chat/sessions');
        list = Array.isArray(r.data) ? r.data : r.data?.items;
        if (r.status >= 300 || !Array.isArray(list)) failed = `the session list answered ${r.status}${r.error?.code ? ` ${r.error.code}` : ''}`;
      } catch (e) {
        failed = e.message;
      }
    }
    if (failed) {
      // The portal cannot be reached or does not answer (T-259: the private network dropped; T-400: 502/503 while it restarts): every track
      // counts as down; reported once the portal answers again. Never read as "no sessions".
      netDownSince ??= Date.now();
      badAt = Date.now();
      goodRounds = 0;
      log(`portal unreachable (${failed}): looking again in ${ROUND_S} s`);
      await sleep(ROUND_S);
      continue;
    }
    goodRounds++;
    await ensureWorktreeTrust(list).catch((e) => log(`folder trust: could not check the worktrees: ${e.message}`));
    const steady = badAt === null || (goodRounds >= STEADY_ROUNDS && Date.now() - badAt >= HEALTH_QUIET_MIN * 60_000);
    if (netDownSince) {
      const mins = Math.round((Date.now() - netDownSince) / 60_000);
      netDownSince = null;
      if (mins >= 15) for (const t of TRACKS) await reportDown(t, (state.tracks[t.key] ??= { key: t.key, starts: [], nudges: [], wakes: [] }), 'network', `the portal was unreachable from the supervisor for about ${mins} minutes`);
    }
    const sessions = list;
    // The portal's pause switch (T-259 slice 3) is the source of truth: a pause of all, or of a track's key as the program, holds the track
    // here too. Read once a round; a portal that does not answer it (older) holds nothing, and the PAUSE files below still hold a track.
    const portalPauses = await api('GET', '/api/keepgoing')
      .then((r) => (Array.isArray(r.data?.pauses) ? r.data.pauses : []))
      .catch(() => []);
    for (const t of TRACKS) {
      const ts = (state.tracks[t.key] ??= { key: t.key, starts: [], nudges: [], wakes: [] });
      ts.nudges ??= [];
      ts.wakes ??= [];
      if (ts.done) {
        // A live chat of this track (a continuation someone started after a hand-over, or T-400 item 3: the older lead still working after a
        // person ended a newer duplicate, which may be ts.sessionId itself) is adopted: the track is watched again. The chat that wrote TRACK
        // COMPLETE stays left alone.
        const live = liveChatOf(t, sessions, ts.sessionId);
        if (!live || (live.id === ts.sessionId && statusSaysDone(ts))) continue;
        ts.done = false;
        ts.sessionId = live.id;
        log(`${t.key}: adopted the live chat ${live.id.slice(0, 8)}: watched again`);
        saveState(state);
      }
      // A paused program (the owner's order, 2026-10-14): `touch ~/.claudepilot/dev-sessions/PAUSE-<track key>` (orchestrator, konfersi); nothing is nudged, woken, moved or restarted until the file is removed.
      const held = portalPauses.find((p) => p.program === null || p.program === t.key);
      if (held || existsSync(join(STATE_DIR, `PAUSE-${t.key}`))) {
        if (!ts.pausedLogged) { log(`${t.key}: PAUSED by the owner (${held ? `the portal: ${held.program ?? 'all'}` : `file PAUSE-${t.key}`}): left alone`); ts.pausedLogged = true; }
        continue;
      }
      ts.pausedLogged = false;
      // A track's sessions are found by their worktree folder (a session may rename itself), or by title.
      const mine = sessions.filter((x) => x.id === ts.sessionId || ofTrack(t, x)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      // T-400 items 2 and 3: a live, recent chat of the track is its lead and is adopted, before the newest one: a new lead is never started
      // beside it, and a person ending a newer duplicate does not mark the track "closed by a person".
      const cur = liveChatOf(t, sessions, ts.sessionId) ?? mine.find((x) => !x.archivedAt) ?? mine[0];
      if (cur?.cwd) ts.cwd = cur.cwd;
      // Keep going is on for this track's chat: the portal watches and restarts it (T-259 slice 2). Only Bypass is still kept here.
      if (cur?.keepGoing?.enabled && !cur.keepGoing.paused) {
        if (ts.keepGoingLogged !== cur.id) log(`${t.key}: Keep going is on for ${cur.id.slice(0, 8)}: the portal keeps it going; only Bypass is kept here`), (ts.keepGoingLogged = cur.id);
        ts.sessionId = cur.id;
        if (cur.state !== 'ended' && !cur.archivedAt) await ensureBypass(t, ts, cur).catch((e) => log(`${t.key}: could not check Bypass: ${e.message}`));
        continue;
      }
      if (statusSaysDone(ts)) {
        ts.done = true;
        log(`${t.key}: TRACK COMPLETE: left alone`);
        continue;
      }
      if (ts.backoffUntil && Date.now() < ts.backoffUntil) continue;

      if (cur && cur.state !== 'ended' && !cur.archivedAt) {
        ts.sessionId = cur.id;
        ts.downReported = {}; // it runs: a later stop is reported again
        // A move to another Claude restarts the process and starts no turn: the chat sits idle until somebody speaks. Speak at once (not after the
        // idle wait), when it is idle, or as soon as it is.
        // T-400 item 4: only a move this process saw itself (the same chat on another Claude than in an earlier round): a Claude stored by an
        // earlier run, or another chat's, told two real leads they were moved when they were not.
        const seen = seenClaude.get(cur.id);
        if (seen && seen !== cur.claudeId) {
          log(`${t.key}: moved to another Claude (${cur.claudeName ?? cur.claudeId}): will continue it at once`);
          ts.pendingContinue = cur.id;
        }
        seenClaude.set(cur.id, cur.claudeId);
        await ensureBypass(t, ts, cur).catch((e) => log(`${t.key}: could not check Bypass: ${e.message}`));
        await compactLanes(t, ts, sessions, cur).catch((e) => log(`${t.key}: lane compaction failed: ${e.message}`));
        if (ts.pendingContinue === cur.id && cur.state === 'idle') {
          try {
            await ensureBypass(t, ts, cur, true);
            await sessionSend(cur.id, (t.moved ?? MOVED)(cur.claudeName ?? 'another Claude'));
            ts.pendingContinue = false;
            ts.nudges.push(Date.now());
            log(`${t.key}: continued after the move`);
          } catch (e) {
            log(`${t.key}: could not continue it after the move: ${e.message}`);
          }
          idleSince.delete(t.key);
          continue;
        }
        if (cur.state === 'idle') {
          if (await moveIfLow(t, ts, cur).catch((e) => (log(`${t.key}: low-quota check failed: ${e.message}`), false))) {
            idleSince.delete(t.key);
            continue;
          }
          if (compactDue(cur, ts)) {
            try {
              await ensureBypass(t, ts, cur, true);
              await sessionSend(cur.id, COMPACT);
              ts.compactedAt = Date.now();
              log(`${t.key}: context ${Math.round(cur.context.usedTokens / 1000)}k: told to compact`);
            } catch (e) {
              log(`${t.key}: could not compact: ${e.message}`);
              ts.compactedAt = Date.now();
            }
            idleSince.delete(t.key);
            continue;
          }
          if (slotsFull(sessions, cur, LEAD_WORKERS[t.key] ?? 4)) {
            idleSince.delete(t.key);
            continue;
          }
          const since = idleSince.get(t.key) ?? Date.now();
          idleSince.set(t.key, since);
          const lastNudge = ts.nudges[ts.nudges.length - 1] ?? 0;
          if (Date.now() - since >= NUDGE_AFTER_MIN * 60_000 && Date.now() - lastNudge >= NUDGE_GAP_MIN * 60_000) {
            if (within24h(ts.nudges).length >= MAX_NUDGES) {
              if (!ts.nudgeCapLogged) log(`${t.key}: ${MAX_NUDGES} nudges in 24 h: leaving it for a person`), (ts.nudgeCapLogged = true);
            } else {
              try {
                await ensureBypass(t, ts, cur, true);
                await sessionSend(cur.id, t.nudge ?? NUDGE);
                ts.nudges.push(Date.now());
                log(`${t.key}: idle for ${Math.round((Date.now() - since) / 60_000)} min: nudged`);
                idleSince.delete(t.key);
              } catch (e) {
                log(`${t.key}: could not nudge: ${e.message}`);
                ts.backoffUntil = Date.now() + 15 * 60_000;
              }
            }
          }
        } else {
          idleSince.delete(t.key);
          if (cur.state === 'waiting') await answerWaiting(t, ts, cur).catch((e) => log(`${t.key}: could not look at what waits: ${e.message}`));
        }
        continue;
      }
      idleSince.delete(t.key);

      // The process is gone but the conversation can be resumed: a message wakes it.
      if (cur && cur.state === 'interrupted') {
        const lastWake = ts.wakes[ts.wakes.length - 1] ?? 0;
        if (Date.now() - lastWake >= 5 * 60_000 && within24h(ts.wakes).length < 12) {
          try {
            await ensureBypass(t, ts, cur, true);
            await sessionSend(cur.id, (t.wake ?? WAKE)(String(cur.endedReason ?? 'its process stopped').slice(0, 120)));
            ts.wakes.push(Date.now());
            log(`${t.key}: interrupted (${String(cur.endedReason ?? '').slice(0, 80)}): woken`);
          } catch (e) {
            log(`${t.key}: could not wake it: ${e.message}`);
            ts.backoffUntil = Date.now() + 15 * 60_000;
          }
        }
        continue;
      }

      // T-400 item 1: no live lead seen, but the portal failed a round lately: what it shows is not trusted yet to say the lead is gone.
      if (!steady) {
        log(`${t.key}: no live lead seen, but the portal failed a round ${Math.round((Date.now() - badAt) / 60_000)} min ago (${goodRounds} good rounds since): not deciding it is gone yet`);
        continue;
      }

      // Ended (or never started). A person who closed it stays obeyed.
      if (cur && /closed by operator/i.test(cur.endedReason ?? '')) {
        // A hand-over (the coordinator wrote HANDOVER-<track> before ending it at a full context) is started again as a continuation.
        const handover = join(STATE_DIR, `HANDOVER-${t.key}`);
        if (existsSync(handover)) {
          rmSync(handover, { force: true });
          log(`${t.key}: handed over: starting a continuation of ${cur.id.slice(0, 8)}`);
        } else {
          ts.done = true;
          log(`${t.key}: closed by a person: not started again`);
          continue;
        }
      }
      // An integrity ending is recovered IN PLACE when the portal can (T-136: same session, tags, pins and numbers, no new row); a new session is the
      // fallback when the endpoint is absent or refuses (the day's cap, a suspicious cause, a person's close). The pause or a portal restarting:
      // wait for the next round. Recoveries never count as starts (the "too many starts" cap below counts new sessions only).
      if (cur && /^integrity/i.test(cur.endedReason ?? '')) {
        ts.recovered ??= {};
        const seen = ts.recovered[cur.id];
        const refusedThisEnding = seen && typeof seen === 'object' && seen.ending === cur.lastActivityAt && seen.verdict === 'new';
        if (!refusedThisEnding) {
          if (DRY) { log(`${t.key}: would recover ${cur.id.slice(0, 8)} in place (dry run): ${String(cur.endedReason).slice(0, 80)}`); continue; }
          const rec = await api('POST', `/api/chat/sessions/${cur.id}/recover`, recoverBody());
          const verdict = recoverVerdict(rec);
          ts.recovered[cur.id] = { at: Date.now(), ending: cur.lastActivityAt, verdict };
          saveState(state);
          if (verdict === 'recovered') {
            log(`${t.key}: recovered ${cur.id.slice(0, 8)} in place after: ${String(cur.endedReason).slice(0, 80)}`);
            continue;
          }
          if (verdict === 'wait') {
            log(`${t.key}: recover in place not now (${rec.error?.code ?? rec.status}): trying again next round`);
            continue;
          }
          log(`${t.key}: recover in place refused (${rec.error?.code ?? rec.status}): ${rec.status === 404 ? 'not available (or no such session)' : String(rec.error?.message ?? '').slice(0, 80)}; a new session instead`);
        }
      }
      const recent = within24h(ts.starts);
      ts.harmless = within24h(ts.harmless);
      // The cap counts per root cause (T-257 item 2): starts after a harmless integrity ending are not the chat's and count apart.
      const harmless = harmlessEnding(cur);
      const counted = recent.filter((x) => !ts.harmless.includes(x));
      const integrityEnds = counted.length && /^integrity/.test(cur?.endedReason ?? '');
      const capped = harmless ? ts.harmless.length >= MAX_HARMLESS_STARTS : counted.length >= MAX_STARTS || (integrityEnds && counted.length >= 3);
      if (capped) {
        if (!ts.capLogged) log(`${t.key}: too many starts in 24 h (${counted.length}, ${ts.harmless.length} after harmless endings): leaving it for a person (${String(cur?.endedReason ?? '').slice(0, 120)})`), (ts.capLogged = true);
        await reportDown(t, ts, 'start_cap', `${counted.length} starts in 24 h (${ts.harmless.length} after harmless endings); the last ending: ${cur?.endedReason ?? 'none'}`);
        saveState(state);
        continue;
      }
      if (recent.length && Date.now() - recent[recent.length - 1] < RESTART_GAP_MIN * 60_000) continue;
      if (stagger && !DRY) await sleep(STAGGER_S);
      try {
        await startSession(t, ts, !!cur, cur?.endedReason ?? 'it was not running', cur?.state === 'ended' ? cur.id : null);
        if (harmless && !DRY) ts.harmless.push(ts.starts[ts.starts.length - 1]);
        ts.capLogged = false;
        stagger = true;
      } catch (e) {
        log(`${t.key}: could not start: ${e.message}`);
        ts.backoffUntil = Date.now() + 10 * 60_000;
        await reportDown(t, ts, downCause(e.message), e.message);
      }
      saveState(state);
    }
    saveState(state);
    await sleep(ROUND_S);
  }
  log('lifetime reached: stopping (the sessions go on; start the supervisor again to keep watching)');
}

/* ---------- Go ---------- */

export { harmlessEnding, watch, STATE_FILE, bestClaude, compactDue, slotsFull, compactLanes, worktreeTrustable, COMPACT, COMPACT_LANE, LANES };
if (IS_MAIN) {
  process.on('SIGTERM', () => revokeMcpToken().finally(() => process.exit(0)));
  process.on('SIGINT', () => revokeMcpToken().finally(() => process.exit(0)));
  try {
    log(`supervisor up: portal ${PORTAL}, workspace ${WORKSPACE}${DEPLOY_RUN ? `, deploy run ${DEPLOY_RUN}` : ''}`);
    if (DEPLOY_RUN) await deploy();
    try {
      execFileSync('git', ['-C', MAIN, 'pull', '--ff-only', '-q', 'origin', 'integration'], { stdio: 'pipe' });
      log(`main folder at ${execFileSync('git', ['-C', MAIN, 'log', '--oneline', '-1'], { encoding: 'utf8' }).trim()}`);
    } catch (e) {
      // The orchestrator keeps its own commits in this folder until it integrates them, so it is ahead of GitHub and often diverged: not a reason to stop.
      log(`main folder not pulled (it is ahead of or diverged from GitHub; the orchestrator integrates it): ${String(e.stderr ?? e.message).replace(/\s+/g, ' ').slice(0, 120)}`);
    }
    await watch();
  } catch (e) {
    log(`STOPPED: ${e.message}`);
    process.exitCode = 2;
  } finally {
    await revokeMcpToken();
  }
}
