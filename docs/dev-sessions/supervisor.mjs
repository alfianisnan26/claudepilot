#!/usr/bin/env node
// The supervisor of the autonomous development sessions (docs/dev-sessions/README.md). It runs INSIDE the dev workspace
// (kubernetes/kohi-event) as a plain background process, so it goes on when the coordinator's own session is closed:
//   PORTAL_SERVER_CODE=<the 8-character sign-in code> [DEPLOY_RUN=<run id>] nohup node docs/dev-sessions/supervisor.mjs >> ~/.claudepilot/dev-sessions/supervisor.log 2>&1 &
// What it does, as the owner's delegate (it signs in with the owner's code, which the owner asked for: "start the sessions in Bypass mode
// without asking a human again"):
//   1. With DEPLOY_RUN: waits until that run's release job waits for its approval, approves it (once, that run only), and waits for the run to
//      pass. A run that fails or is cancelled stops everything: the sessions are not started on a portal that was not updated.
//   2. Brings the main folder's `integration` up to date (git pull --ff-only), the base of every session's worktree.
//   3. Starts one Bypass session per track (own worktree, own Claude), unless one already lives.
//   4. Keeps watching, every ROUND_S seconds, per track: a session idle for a few minutes gets a nudge to carry on (nobody else will);
//      an interrupted one (its process is gone) is woken by a message; one that ended is started again in the same worktree on the next
//      Claude of its list, told to continue from its status file (at most MAX_STARTS per track per 24 h, 3 after integrity endings,
//      RESTART_GAP_MIN apart). A track whose status file starts with TRACK COMPLETE, or whose session a person closed, is left alone.
//      One live session per track at most; it touches nothing else.
// Stop it: touch ~/.claudepilot/dev-sessions/STOP (checked every round), or kill the process. State: ~/.claudepilot/dev-sessions/state.json.
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

/** The tracks: which Claude (by its name on the workspace) and which brief. A Claude's name is looked up, so a changed id does not matter. */
const TRACKS = [
  { key: 'track-a-connect', title: 'Track A: Connect', branch: 'dev/track-a-connect', claudes: ['fadlilah', 'hasyim', 'alfian.isnan'] },
  { key: 'track-b-notify-triggers', title: 'Track B: Notify, triggers, version, auto move', branch: 'dev/track-b-notify-triggers', claudes: ['hasyim', 'alfian.isnan', 'fadlilah'] },
  { key: 'track-c-ui', title: 'Track C: UI', branch: 'dev/track-c-ui', claudes: ['alfian.isnan', 'fadlilah', 'hasyim'] },
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

const kickoff = (t, again, reason) =>
  again
    ? `You are the continuation of the ${t.title} session, which ended (${reason}). Nobody answers questions: decide, write it down, go on. This is the same worktree and branch. First read docs/dev-sessions/README.md, your track file docs/dev-sessions/${t.key}.md and your status file docs/dev-sessions/status/${t.key}.md; run git status and git log --oneline origin/integration..HEAD to see what is unmerged here, and git fetch origin && git rebase origin/integration when the worktree is clean. Then continue from NEXT. When the whole track list is done, make TRACK COMPLETE the first line of your status file, commit and push, and end with the final report.`
    : `You are the autonomous development session for ${t.title}. Nobody answers questions: decide, write it down, go on. First: git fetch origin && git rebase origin/integration (your branch has no work yet). Then read docs/dev-sessions/README.md (how you work: your worktree, the heavy-job lock, the integration cycle, the safety rules, status files), then your track file docs/dev-sessions/${t.key}.md, and do the track's items in order until it is done. Your status file is docs/dev-sessions/status/${t.key}.md (create it; at most 60 lines: DONE, DECISIONS, NEEDS A HUMAN, NEXT). When the whole track list is done, make TRACK COMPLETE the first line of that file, commit and push, and end with the final report. A supervisor watches you: if you go idle it tells you to continue.`;

async function startSession(t, tstate, again, reason) {
  if (DRY) return log(`[dry] ${t.key}: would ${again ? 'start again' : 'start'} (${reason})`);
  const claudeName = t.claudes[(tstate.starts?.length ?? 0) % t.claudes.length];
  const claudeId = await claudeIdOf(claudeName);
  if (!claudeId) throw new Error(`no Claude named ${claudeName} on ${WORKSPACE}`);
  let body = { workspaceId: WORKSPACE, title: t.title, claudeId, allowBypass: true };
  body = again && tstate.cwd ? { ...body, cwd: tstate.cwd } : { ...body, cwd: MAIN, worktree: { branch: t.branch, base: 'integration' } };
  let r = await api('POST', '/api/chat/sessions', body);
  if (r.error?.code === 'FOLDER_UNTRUSTED') {
    // The folder holds the repository's own .claude/settings.json (allow and deny rules only: no hooks, MCP servers, plugins or env).
    const scan = r.error.details ?? {};
    if (scan.hooks?.length || scan.mcpServers?.length || scan.plugins?.length || scan.envNames?.length) throw new Error('the folder\'s project settings now load hooks, MCP servers, plugins or env: not trusting that unattended');
    const tr = await api('POST', '/api/chat/trust', { workspaceId: WORKSPACE, folder: scan.folder, hash: scan.hash });
    if (tr.error) throw new Error(`trust refused: ${tr.error.message}`);
    log(`${t.key}: trusted ${scan.folder} (${scan.allowRules} allow rules)`);
    r = await api('POST', '/api/chat/sessions', scan.worktree ? { ...body, worktree: scan.worktree } : body);
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
  await sessionSend(s.id, kickoff(t, again, reason));
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

const NUDGE = 'Nobody is here to answer. Continue with your track now: take the next item (your status file says where you stopped; if you asked a question, answer it yourself with the PRD default and go on). When the whole track list is done, write TRACK COMPLETE as the first line of your status file, commit and push it, and end with the final report. Do not stop to summarise or wait.';
const WAKE = (why) => `This session was interrupted (${why}). Continue where you left off: read your status file docs/dev-sessions/status/<your track>.md, check git status, and carry on with the next item. Nobody is here to answer questions.`;
const NUDGE_AFTER_MIN = Number(process.env.NUDGE_AFTER_MIN ?? 3);
const NUDGE_GAP_MIN = Number(process.env.NUDGE_GAP_MIN ?? 10);
const MAX_NUDGES = Number(process.env.MAX_NUDGES ?? 40);

const within24h = (list) => (list ?? []).filter((x) => Date.now() - x < 24 * 3_600_000);
const slugOf = (t) => t.branch.replace(/\//g, '-');

async function watch() {
  const until = Date.now() + LIFETIME_H * 3_600_000;
  const idleSince = new Map();
  let stagger = false;
  while (Date.now() < until) {
    if (existsSync(join(STATE_DIR, 'STOP'))) return log('STOP file found: leaving the sessions as they are');
    const state = readState();
    const list = (await api('GET', '/api/chat/sessions')).data ?? [];
    const sessions = Array.isArray(list) ? list : (list.items ?? []);
    for (const t of TRACKS) {
      const ts = (state.tracks[t.key] ??= { key: t.key, starts: [], nudges: [], wakes: [] });
      ts.nudges ??= [];
      ts.wakes ??= [];
      if (ts.done) continue;
      // A track's sessions are found by their worktree folder (a session may rename itself), or by title.
      const mine = sessions.filter((x) => x.cwd?.endsWith(`/${slugOf(t)}`) || x.title === t.title).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
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
        if (cur.state === 'idle') {
          const since = idleSince.get(t.key) ?? Date.now();
          idleSince.set(t.key, since);
          const lastNudge = ts.nudges[ts.nudges.length - 1] ?? 0;
          if (Date.now() - since >= NUDGE_AFTER_MIN * 60_000 && Date.now() - lastNudge >= NUDGE_GAP_MIN * 60_000) {
            if (within24h(ts.nudges).length >= MAX_NUDGES) {
              if (!ts.nudgeCapLogged) log(`${t.key}: ${MAX_NUDGES} nudges in 24 h: leaving it for a person`), (ts.nudgeCapLogged = true);
            } else {
              try {
                await sessionSend(cur.id, NUDGE);
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
          if (cur.state === 'waiting') log(`${t.key}: waits for an answer (${cur.waitingFor ?? 'a request'}): only a person can give it`);
        }
        continue;
      }
      idleSince.delete(t.key);

      // The process is gone but the conversation can be resumed: a message wakes it.
      if (cur && cur.state === 'interrupted') {
        const lastWake = ts.wakes[ts.wakes.length - 1] ?? 0;
        if (Date.now() - lastWake >= 5 * 60_000 && within24h(ts.wakes).length < 12) {
          try {
            await sessionSend(cur.id, WAKE(String(cur.endedReason ?? 'its process stopped').slice(0, 120)));
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
    throw new Error(`could not bring ${MAIN} up to date: ${String(e.stderr ?? e.message).slice(0, 200)}`);
  }
  await watch();
} catch (e) {
  log(`STOPPED: ${e.message}`);
  process.exitCode = 2;
} finally {
  await revokeMcpToken();
}
