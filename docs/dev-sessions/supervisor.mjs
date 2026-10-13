#!/usr/bin/env node
// The supervisor of the autonomous development session (docs/dev-sessions/README.md): ONE orchestrator session that works with sub-agents.
// It runs INSIDE the dev workspace (kubernetes/kohi-event) as a plain background process, so it goes on when the coordinator's own session is closed:
//   PORTAL_SERVER_CODE=<the 8-character sign-in code> [DEPLOY_RUN=<run id>] nohup node docs/dev-sessions/supervisor.mjs >> ~/.claudepilot/dev-sessions/supervisor.log 2>&1 &
// What it does, as the owner's delegate (it signs in with the owner's code, which the owner asked for: "run it autonomously, in Bypass mode, without
// asking a human again"):
//   1. With DEPLOY_RUN: waits until that run's release job waits for its approval, approves it (once, that run only), and waits for the run to
//      pass. A run that fails or is cancelled stops everything.
//   2. Brings the main folder's `integration` up to date (git pull --ff-only).
//   3. Starts the orchestrator (a Bypass session in the main folder, on the Claude with the most room) unless one already lives.
//   4. Keeps watching, every ROUND_S seconds: a session idle for a few minutes gets a nudge to carry on (nobody else will); an interrupted one (its
//      process is gone) is woken by a message; one that ended is started again, told to continue from its status file (at most MAX_STARTS per 24 h,
//      3 after integrity endings, RESTART_GAP_MIN apart). A status file that starts with TRACK COMPLETE, or a session a person closed, is left alone.
// Stop it: touch ~/.claudepilot/dev-sessions/STOP (checked every round), or kill the process by PID. State: ~/.claudepilot/dev-sessions/state.json.
// Never logs the code, a cookie or a token.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
/** DRY_RUN=1: reads the portal and says what it would do; changes nothing. */
const DRY = process.env.DRY_RUN === '1';

/** What is kept alive: one orchestrator in the main folder (no worktree of its own: its sub-agents make theirs). The Claudes are tried by name, best room first. */
const KONFERSI = process.env.KONFERSI_FOLDER ?? join(homedir(), 'work/konfersi-universe');
const TRACKS = [
  { key: 'orchestrator', title: 'Orchestrator: ClaudePilot dev', claudes: ['hasyim', 'fadlilah', 'alfian.isnan'] },
  // The Konfersi migration chat (its own folder, tickets instead of a status file). Not named Orchestrator: the title prefix finds the track's chats.
  {
    key: 'konfersi',
    title: 'Konfersi: migration',
    folder: KONFERSI,
    claudes: ['alfian.isnan', 'hasyim', 'satria', 'one.claude', 'two.claude', 'sekar'],
    kickoff: (again, reason) =>
      `You are the Konfersi orchestrator, running in ClaudePilot${again ? ` (the earlier chat ended: ${reason}; your role-subagents are gone)` : ''}. Nobody answers questions: decide, write it on the ticket, go on. Read first: your pilot tickets (ticket_list, tag konfersi-migration; T-94, T-96 and T-103 especially), then git worktree list and git status in ~/work/agentic-worktrees and ~/work/konfersi-universe; git fetch origin stg; docs/agentic/pilot-migration/*.md. Rules: run every role as a SUB-AGENT of this chat (Agent tool, a git worktree each, they inherit Bypass); never session_spawn (never Bypass, capped at 4 sessions); one heavy job at a time through flock /tmp/heavy.lock nice -n 10; stg only (uat and prod are never touched; uat waits for T-103); production-only questions are one line on T-93; secrets arrive through the Secrets pool, never print them; status on pilot tickets (T-84 every ~2 h). Keep every role busy.`,
    nudge: 'Nobody is here to answer. Continue now: look at your pilot tickets (ticket_list, tag konfersi-migration) and your sub-agents, start or restart the roles that have work, one heavy job at a time. If you asked a question, answer it yourself with the default written on the ticket and go on. Do not stop to summarise or wait.',
    wake: (why) => `This chat was interrupted (${why}). Continue where you left off: look at your pilot tickets, git worktree list and git status in ~/work/agentic-worktrees, restart the roles that had work in flight, and carry on. Nobody is here to answer questions.`,
  },
];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
if (!CODE) {
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

/** Portal MCP over HTTP with a short-lived admin token made for this process (only `session_send` needs it) and revoked at exit. */
const mcp = { token: '', id: '' };
async function mcpToken() {
  if (mcp.token) return mcp.token;
  const r = await api('POST', '/api/portal-mcp/tokens', { label: 'dev-sessions-supervisor', scope: 'admin', expiresInDays: 7 });
  if (!r.data?.secret) throw new Error(`no MCP token: ${r.error?.message ?? r.status}`);
  mcp.token = r.data.secret;
  mcp.id = r.data.token?.id ?? '';
  return mcp.token;
}
async function revokeMcpToken() {
  if (mcp.id) await api('DELETE', `/api/portal-mcp/tokens/${mcp.id}`).catch(() => {});
  mcp.token = mcp.id = '';
}
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
async function bestClaude(names) {
  const r = await api('GET', '/api/claude-usage');
  const used = new Map((r.data?.claudes ?? []).map((c) => [c.claudeId ?? c.id, Math.max(0, ...(c.windows ?? []).map((w) => (typeof w.usedPct === 'number' ? w.usedPct : 0)))]));
  let best = null;
  for (const name of names) {
    const id = await claudeIdOf(name);
    if (!id) continue;
    const u = used.get(id) ?? 0;
    if (!best || u < best.used) best = { name, id, used: u };
  }
  return best;
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
  // A chat on a model only some Claudes have (Fable shows as its own window on those) must land on one that has it: otherwise the restore of its
  // model fails quietly and it runs on whatever the other Claude defaults to (T-109 makes the portal pick the best available model instead).
  const gated = /fable/i.exec(cur.model ?? '')?.[0]?.toLowerCase() ?? null;
  const has = new Map((r.data?.claudes ?? []).map((c) => [c.claudeId ?? c.id, (c.windows ?? []).some((w) => `${w.key ?? ''} ${w.label ?? ''}`.toLowerCase().includes(gated ?? '\u0000'))]));
  let best = null;
  for (const name of t.claudes) {
    const id = await claudeIdOf(name);
    if (!id || id === cur.claudeId) continue;
    if (gated && !has.get(id)) continue;
    const u = used.get(id) ?? 0;
    if (u >= LOW_USED_PCT) continue;
    if (!best || u < best.used) best = { name, id, used: u };
  }
  if (!best) {
    if (ts.lowLoggedAt === undefined || Date.now() - ts.lowLoggedAt > 30 * 60_000) log(`${t.key}: its Claude is at ${mine}% used and no delegated Claude has more than ${100 - LOW_USED_PCT}% left: waiting, looking again every round`), (ts.lowLoggedAt = Date.now());
    return false;
  }
  if (DRY) return log(`[dry] ${t.key}: would move ${cur.id.slice(0, 8)} from ${mine}% used to ${best.name} (${best.used}% used)`), false;
  const res = await api('POST', `/api/chat/sessions/${cur.id}/switch`, { claudeId: best.id, handoff: mine >= 100 ? 'skip' : 'ask' });
  if (res.error) {
    log(`${t.key}: could not move to ${best.name}: ${res.error.message}`);
    ts.backoffUntil = Date.now() + 5 * 60_000;
    return false;
  }
  ts.lowLoggedAt = undefined;
  log(`${t.key}: its Claude was at ${mine}% used: moved to ${best.name} (${best.used}% used)`);
  return true;
}

const kickoff = (t, again, reason) =>
  again
    ? `You are the continuation of the ${t.title} session, which ended (${reason}). Nobody answers questions: decide, write it down, go on. First read docs/dev-sessions/README.md, docs/dev-sessions/orchestrator.md and your status file docs/dev-sessions/status/${t.key}.md. Sub-agents of the earlier session are gone: look at git worktree list, git status -sb and git log --oneline origin/integration..HEAD in each worktree under ~/work/claudepilot.worktrees/ for what is unmerged, keep what is good, then continue from NEXT. When the whole backlog is done, make TRACK COMPLETE the first line of the status file, commit and push, and end with the final report.`
    : `You are the ${t.title} session: the one autonomous development session of ClaudePilot, working with sub-agents (the Agent tool) in git worktrees. Nobody answers questions: decide, write it down, go on. First read docs/dev-sessions/README.md (the rules that bind you and every sub-agent) and docs/dev-sessions/orchestrator.md (your brief), then start: look at the three prepared worktrees, create your status file docs/dev-sessions/status/${t.key}.md, and dispatch up to three sub-agents in parallel, one per work package. A supervisor watches you: if you go idle it tells you to continue. Do not rename the chat.`;

async function startSession(t, tstate, again, reason) {
  const pick = await bestClaude(t.claudes);
  if (!pick) throw new Error(`none of ${t.claudes.join(', ')} is a Claude on ${WORKSPACE}`);
  if (DRY) return log(`[dry] ${t.key}: would ${again ? 'start again' : 'start'} on ${pick.name} (${pick.used}% used) (${reason})`);
  const claudeName = pick.name;
  const claudeId = pick.id;
  const body = { workspaceId: WORKSPACE, title: t.title, claudeId, allowBypass: true, cwd: t.folder ?? MAIN };
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
  await sessionSend(s.id, t.kickoff ? t.kickoff(again, reason) : kickoff(t, again, reason));
  tstate.sessionId = s.id;
  tstate.cwd = s.cwd;
  (tstate.starts ??= []).push(Date.now());
  log(`${t.key}: ${again ? 'started again' : 'started'} session ${s.id.slice(0, 8)} on ${claudeName} in ${s.cwd}`);
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

const NUDGE = 'Nobody is here to answer. Continue now: integrate what finished sub-agents brought, dispatch the next slices to up to three sub-agents in parallel, keep your status file current. If you asked a question, answer it yourself with the PRD default and go on. When the whole backlog is done, make TRACK COMPLETE the first line of your status file, commit and push it, and end with the final report. Do not stop to summarise or wait.';
const WAKE = (why) => `This session was interrupted (${why}). Continue where you left off: read your status file docs/dev-sessions/status/orchestrator.md, look at git worktree list and git status in each worktree, and carry on. Nobody is here to answer questions.`;
const MOVED = (to) => `This chat was moved to another Claude (${to}) and its process restarted: the sub-agents of the old process stopped. Continue now where you stopped: look at your tickets or status file, git worktree list and git status, restart the work that was in flight, commit and push WIP early. Nobody is here to answer questions.`;
const NUDGE_AFTER_MIN = Number(process.env.NUDGE_AFTER_MIN ?? 3);
const NUDGE_GAP_MIN = Number(process.env.NUDGE_GAP_MIN ?? 10);
const MAX_NUDGES = Number(process.env.MAX_NUDGES ?? 40);

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
 * Folder trust is tied to the hash of .claude/settings.json: a commit that touches it makes the next Move, restart or wake of a session in the main folder fail
 * with FOLDER_UNTRUSTED until a person trusts the new hash (ticket T-38 asks the portal to do this itself). Until it does, this supervisor re-trusts a folder
 * whose scan lists NO hooks, MCP servers, plugins or env names (only permission rules), and says so; anything else is left for a person and logged.
 */
async function ensureTrust() {
  for (const folder of new Set(TRACKS.map((t) => t.folder ?? MAIN))) await ensureTrustOf(folder);
}
async function ensureTrustOf(folder) {
  const scan = (await api('GET', `/api/chat/trust/scan?workspaceId=${encodeURIComponent(WORKSPACE)}&folder=${encodeURIComponent(folder)}`)).data;
  if (!scan || scan.trusted || scan.empty) return;
  if (scan.hooks?.length || scan.mcpServers?.length || scan.plugins?.length || scan.envNames?.length) {
    if (!trustLogged.has(scan.hash)) log(`folder trust: the project settings now load hooks, MCP servers, plugins or env: a person must look (${folder})`), trustLogged.add(scan.hash);
    return;
  }
  if (DRY) return log(`[dry] would trust ${folder} (${scan.allowRules} permission rules, nothing else)`);
  const tr = await api('POST', '/api/chat/trust', { workspaceId: WORKSPACE, folder: scan.folder ?? folder, hash: scan.hash });
  log(tr.error ? `folder trust: refused: ${tr.error.message}` : `folder trust: the permission rules of ${folder} changed (${scan.allowRules} rules, no hooks, servers, plugins or env): trusted again`);
}
const trustLogged = new Set();

const within24h = (list) => (list ?? []).filter((x) => Date.now() - x < 24 * 3_600_000);

async function watch() {
  const until = Date.now() + LIFETIME_H * 3_600_000;
  const idleSince = new Map();
  let stagger = false;
  while (Date.now() < until) {
    if (existsSync(join(STATE_DIR, 'STOP'))) return log('STOP file found: leaving the sessions as they are');
    await ensureTrust().catch((e) => log(`folder trust: could not check: ${e.message}`));
    const state = readState();
    const list = (await api('GET', '/api/chat/sessions')).data ?? [];
    const sessions = Array.isArray(list) ? list : (list.items ?? []);
    for (const t of TRACKS) {
      const ts = (state.tracks[t.key] ??= { key: t.key, starts: [], nudges: [], wakes: [] });
      ts.nudges ??= [];
      ts.wakes ??= [];
      if (ts.done) continue;
      // A track's sessions are found by their worktree folder (a session may rename itself), or by title.
      const mine = sessions.filter((x) => x.id === ts.sessionId || String(x.title ?? '').startsWith(t.title.split(':')[0])).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const cur = mine.find((x) => !x.archivedAt) ?? mine[0];
      if (cur?.cwd) ts.cwd = cur.cwd;
      if (statusSaysDone(ts)) {
        ts.done = true;
        log(`${t.key}: TRACK COMPLETE: left alone`);
        continue;
      }
      if (ts.backoffUntil && Date.now() < ts.backoffUntil) continue;

      if (cur && cur.state !== 'ended' && !cur.archivedAt) {
        ts.sessionId = cur.id;
        // A move to another Claude restarts the process and starts no turn: the chat sits idle until somebody speaks. Speak at once (not after the
        // idle wait), when it is idle, or as soon as it is.
        if (ts.claudeId && ts.claudeId !== cur.claudeId) {
          log(`${t.key}: moved to another Claude (${cur.claudeName ?? cur.claudeId}): will continue it at once`);
          ts.pendingContinue = true;
        }
        ts.claudeId = cur.claudeId;
        if (ts.pendingContinue && cur.state === 'idle') {
          try {
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
          const since = idleSince.get(t.key) ?? Date.now();
          idleSince.set(t.key, since);
          const lastNudge = ts.nudges[ts.nudges.length - 1] ?? 0;
          if (Date.now() - since >= NUDGE_AFTER_MIN * 60_000 && Date.now() - lastNudge >= NUDGE_GAP_MIN * 60_000) {
            if (within24h(ts.nudges).length >= MAX_NUDGES) {
              if (!ts.nudgeCapLogged) log(`${t.key}: ${MAX_NUDGES} nudges in 24 h: leaving it for a person`), (ts.nudgeCapLogged = true);
            } else {
              try {
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

      // Ended (or never started). A person who closed it stays obeyed.
      if (cur && /closed by operator/i.test(cur.endedReason ?? '')) {
        ts.done = true;
        log(`${t.key}: closed by a person: not started again`);
        continue;
      }
      // An integrity ending is recovered IN PLACE when the portal can (T-136: same session, tags, pins and numbers, no new row); a new session is the
      // fallback when the endpoint is absent or refuses (a cap, a person's close).
      if (cur && /^integrity/i.test(cur.endedReason ?? '')) {
        ts.recovered ??= {};
        if (!ts.recovered[cur.id]) {
          ts.recovered[cur.id] = Date.now();
          const rec = await api('POST', `/api/chat/sessions/${cur.id}/recover`, {});
          if (!rec.error && rec.status < 300) {
            log(`${t.key}: recovered ${cur.id.slice(0, 8)} in place after: ${String(cur.endedReason).slice(0, 80)}`);
            saveState(state);
            continue;
          }
          log(`${t.key}: recover in place refused (${rec.error?.code ?? rec.status}): ${rec.error?.code === 'NOT_FOUND' ? 'not available yet' : String(rec.error?.message ?? '').slice(0, 80)}; a new session instead`);
        }
      }
      const recent = within24h(ts.starts);
      const integrityEnds = recent.length && /^integrity/.test(cur?.endedReason ?? '');
      if (recent.length >= MAX_STARTS || (integrityEnds && recent.length >= 3)) {
        if (!ts.capLogged) log(`${t.key}: too many starts in 24 h (${recent.length}): leaving it for a person (${String(cur?.endedReason ?? '').slice(0, 120)})`), (ts.capLogged = true);
        continue;
      }
      if (recent.length && Date.now() - recent[recent.length - 1] < RESTART_GAP_MIN * 60_000) continue;
      if (stagger && !DRY) await sleep(STAGGER_S);
      try {
        await startSession(t, ts, !!cur, cur?.endedReason ?? 'it was not running');
        ts.capLogged = false;
        stagger = true;
      } catch (e) {
        log(`${t.key}: could not start: ${e.message}`);
        ts.backoffUntil = Date.now() + 10 * 60_000;
      }
      saveState(state);
    }
    saveState(state);
    await sleep(ROUND_S);
  }
  log('lifetime reached: stopping (the sessions go on; start the supervisor again to keep watching)');
}

/* ---------- Go ---------- */

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
