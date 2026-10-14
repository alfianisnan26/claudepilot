// T-136 slice 3 and T-277: the proof that a chat survives a portal restart (docs/prd/chat-sessions.md §10.4). A scratch portal
// (scripts/scratch-portal.sh, started under the pod's heavy lock) runs the REAL Claude Code CLI on its local workspace, answered by the
// stand-in Messages API (tools/qa/mock-anthropic.mjs) and wrapped by tools/qa/claude-shim.mjs. Two chats:
//   A  in Bypass (the gated path: the policy with its confirmation, a session started to allow it, the server code again, the tick), with a
//      sub-agent run in its process;
//   B  the twin, in the start mode (default), started to allow Bypass but never in it.
// The portal process is stopped under both, and while it is down Claude Code is put in another mode through its own input (A: default, a
// LESS permissive mode than the portal expects; B: acceptEdits, a MORE permissive one; the shim keeps the reply to that request away from the
// portal, so only Claude Code's own next report tells it). The portal is started again on the same data and session files
// (scratch-portal.sh restart), and each chat gets a message. Asserts:
//   - A survives: no integrity ending, the transcript says "Bypass is off in this chat", the audit has `bypass.left` with why=downgrade, the
//     row and the stored control state both expect `default` (the reported mode), the log shows the control state RELOADED for A (expected
//     bypassPermissions) and the resync comparison, and exactly one follower (`tail`) per session file;
//   - Bypass comes back on A only through the gated path (the server code again and the tick);
//   - B ends for integrity (`mode-changed`, suspicious): a more permissive report is still an ending, and an agent may not recover it (403);
//   - A, ended for a HARMLESS cause (a peer line from its own sub-agent with no cause in the stream, `replay-peer`), is recovered IN PLACE
//     by POST .../recover as an agent: the same id, title, pin, creation time and Claude Code session, no new row, and it answers again.
// usage: node tools/qa/restart-survive.mjs [--port 3471] [--mock 4671]     (needs `claude` on PATH, python3, flock; prints ok/FAIL lines and
//        "restart-survive: N checks, M failed"; exit 1 on any failure). It stops the scratch portal and the stand-in when done.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);
const PORT = Number(opt('--port', 3471));
const MOCK = Number(opt('--mock', 4671));
const CODE = '24681372'; // scratch-portal.sh's default code: a throwaway portal on the loopback only
process.env.QA_PORT = String(PORT);
process.env.QA_CODE = CODE;
const { api, login, openChat, sleep } = await import('./lib.mjs');

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const scratch = `/tmp/scratch-portal-${PORT}`;
const home = join(scratch, 'home');
const work = mkdtempSync(join(tmpdir(), 'restart-survive-'));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  return ok;
};
const must = (name, ok, detail = '') => {
  if (!check(name, ok, detail)) throw new Error(`cannot go on after: ${name}`);
};
const until = async (what, fn, ms = 60_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out (${ms / 1000} s) waiting for ${what}`);
    await sleep(500);
  }
};
const sh = (cmd, cmdArgs, env = {}) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 180_000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

/* ---------- The process listening on the port, its followers, its data ---------- */

/** The pid that listens on the port, through /proc (as scratch-portal.sh's pid_of). */
function pidOfPort(port) {
  const inodes = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c[3] === '0A' && Number.parseInt(c[1]?.split(':')[1] ?? '', 16) === port) inodes.add(`socket:[${c[9]}]`);
    }
  }
  for (const p of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      for (const fd of readdirSync(`/proc/${p}/fd`)) if (inodes.has(readlinkSync(`/proc/${p}/fd/${fd}`))) return Number(p);
    } catch {
      // not ours, or gone
    }
  }
  return null;
}

/** The live `tail` processes that follow one session file (the portal's followers, chat/host.ts `tail`). */
function followers(file) {
  let n = 0;
  for (const p of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      const argv = readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0');
      if (argv[0]?.split('/').pop() === 'tail' && argv.includes(file)) n++;
    } catch {
      // gone
    }
  }
  return n;
}

/** One row of the scratch portal's database, read only (the stored control state and segment are not on the API). */
function dbRow(sql, ...params) {
  const db = new DatabaseSync(join(scratch, 'data', 'portal.db'), { readOnly: true });
  try {
    return db.prepare(sql).get(...params) ?? null;
  } finally {
    db.close();
  }
}

const sessionDir = (id) => join(home, '.claudepilot', 'sessions', id);
const outFile = (id) => join(sessionDir(id), `out.${dbRow('SELECT segment FROM chat_sessions WHERE id = ?', id)?.segment ?? 0}.jsonl`);
const portalUp = async () => fetch(`http://localhost:${PORT}/healthz`).then((r) => r.ok, () => false);
const portalLog = () => (existsSync(join(scratch, 'log')) ? readFileSync(join(scratch, 'log'), 'utf8') : '');

/** Writes one control request into Claude Code's input FIFO, as anything in the workspace could; the shim drops its reply. */
function intoFifo(id, line) {
  writeFileSync(join(sessionDir(id), 'in'), `${JSON.stringify(line)}\n`, { flag: 'a' });
}

/* ---------- The run ---------- */

let mock = null;
let call;
const chats = [];
async function signIn() {
  call = api(await login(CODE));
}
async function ok(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.data;
}
const session = async (id) => {
  const d = await ok('GET', `/api/chat/sessions/${id}`);
  return d?.session ?? d;
};
async function turn(id, text, ms = 90_000) {
  const chat = await openChat((await login(CODE)), id);
  chats.push(chat);
  try {
    await chat.until((c) => c.session, 15_000, 'session');
    const before = chat.events.length;
    const ack = await chat.send(text);
    await sleep(800);
    await chat.until((c) => c.session && ['idle', 'ended', 'interrupted'].includes(c.session.state) && c.events.length > before, ms, `the turn of ${id.slice(0, 8)}`);
    return { ack, session: chat.session };
  } finally {
    chat.close();
  }
}
async function enterBypass(id) {
  await ok('POST', '/api/chat/reauth', { code: CODE });
  await ok('POST', `/api/chat/sessions/${id}/bypass`, { acknowledged: true });
  return until('Bypass on', async () => ((await session(id)).mode === 'bypassPermissions' ? true : null), 30_000).catch(() => false);
}

async function main() {
  const real = sh('sh', ['-c', 'command -v claude']).out;
  must('Claude Code is installed', real.startsWith('/'), real || 'no claude on PATH');

  // The stand-in Messages API, then the scratch portal (under the heavy lock while it starts), its local workspace answered by the stand-in.
  mock = spawn(process.execPath, [join(here, 'mock-anthropic.mjs'), String(MOCK), join(work, 'mock.jsonl')], { stdio: 'ignore' });
  const started = sh('flock', ['-o', '/tmp/heavy.lock', 'scripts/scratch-portal.sh', 'start', String(PORT), CODE], { PORTAL_LOCAL_ENABLED: 'true', PORTAL_HOST: '127.0.0.1' });
  must('scratch portal started', started.code === 0, started.out.split('\n').pop());
  mkdirSync(join(home, '.claude'), { recursive: true });
  // A placeholder key for the stand-in, built here: the stand-in never checks it, and it is no credential.
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK}`, ANTHROPIC_API_KEY: ['qa', 'stand', 'in'].join('-') } }));
  // The portal's local workspace puts $HOME/.local/bin first on PATH (workspaces/hostexec.ts userEnv): the wrapper there runs the shim.
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(here, 'claude-shim.mjs'))} ${JSON.stringify(real)} "$@"\n`);
  chmodSync(join(home, '.local', 'bin', 'claude'), 0o755);

  await signIn();
  await ok('POST', '/api/workspaces/local/local/start');
  await ok('PUT', '/api/settings/sessions.allowBypass', { value: true, confirm: true });
  const make = async (title) => {
    const d = await ok('POST', '/api/chat/sessions', { workspaceId: 'local/local', title, allowBypass: true });
    return (d?.session ?? d).id;
  };
  const A = await make('Restart A');
  const B = await make('Restart B');
  await ok('POST', `/api/chat/sessions/${A}/pin`);

  // Before the restart: both answer; A enters Bypass through the gates and runs a sub-agent in Bypass.
  const a1 = await turn(A, '[[echo]] first');
  must('A answers before the restart', a1.session.state === 'idle', `state ${a1.session.state}`);
  must('A enters Bypass through the gated path', await enterBypass(A));
  const a2 = await turn(A, '[[agent sonnet echo from a sub-agent]]', 120_000);
  must('A runs a sub-agent in Bypass', a2.session.state === 'idle' && a2.session.mode === 'bypassPermissions', `state ${a2.session.state}, mode ${a2.session.mode}`);
  const b1 = await turn(B, '[[echo]] first');
  must('B answers before the restart', b1.session.state === 'idle' && b1.session.mode === 'default', `state ${b1.session.state}, mode ${b1.session.mode}`);
  const before = await session(A);
  const rowsBefore = dbRow('SELECT COUNT(*) AS n FROM chat_sessions').n;
  const fileA = outFile(A);
  const procA = dbRow('SELECT parent_pid AS pid, process_started_at AS at FROM chat_sessions WHERE id = ?', A);

  // The restart: the portal process goes; while it is down Claude Code changes mode through its own input; the portal starts again.
  const pid = pidOfPort(PORT);
  must('the portal process is found', !!pid);
  process.kill(pid, 'SIGTERM');
  await until('the portal down', async () => !(await portalUp()), 30_000);
  intoFifo(A, { type: 'control_request', request_id: 'qa-restart-a', request: { subtype: 'set_permission_mode', mode: 'default' } });
  intoFifo(B, { type: 'control_request', request_id: 'qa-restart-b', request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } });
  const applied = (id, req) => existsSync(join(sessionDir(id), 'err.log')) && readFileSync(join(sessionDir(id), 'err.log'), 'utf8').includes(`reply to ${req} `);
  check('Claude Code took the mode changes while the portal was down', await until('the replies', () => applied(A, 'qa-restart-a') && applied(B, 'qa-restart-b'), 30_000).catch(() => false));
  const restarted = sh('scripts/scratch-portal.sh', ['restart', String(PORT), CODE], { PORTAL_LOCAL_ENABLED: 'true', PORTAL_HOST: '127.0.0.1' });
  must('the portal started again on the same data', restarted.code === 0, restarted.out.split('\n').pop());
  await signIn();
  check('the same Claude Code process is still there', JSON.stringify(dbRow('SELECT parent_pid AS pid, process_started_at AS at FROM chat_sessions WHERE id = ?', A)) === JSON.stringify(procA), `pid ${procA?.pid}`);

  // A: the report of a LESS permissive mode is a downgrade, never an ending.
  const peak = [];
  const sampler = setInterval(() => peak.push(followers(fileA)), 300);
  const a3 = await turn(A, '[[echo]] after the restart');
  clearInterval(sampler);
  const afterA = await session(A);
  check('A survives the restart (no integrity ending)', afterA.state !== 'ended' && !afterA.endedReason, `state ${afterA.state}${afterA.endedReason ? `, ${afterA.endedReason}` : ''}`);
  check('A answered after the restart', a3.session.state === 'idle', `state ${a3.session.state}`);
  check('A is in the reported mode (default)', afterA.mode === 'default', `mode ${afterA.mode}`);
  const history = JSON.stringify(await ok('GET', `/api/chat/sessions/${A}/events`));
  check('the transcript says "Bypass is off in this chat"', history.includes('Bypass is off in this chat'));
  const audit = await ok('GET', `/api/chat/audit?sessionId=${A}&kind=bypass&limit=50`);
  const left = (Array.isArray(audit) ? audit : (audit?.items ?? audit?.entries ?? [])).filter((e) => e.kind === 'bypass.left');
  check('the audit has bypass.left why=downgrade', left.some((e) => e.detail?.why === 'downgrade' && e.detail?.mode === 'default'), JSON.stringify(left.map((e) => e.detail)));
  const stored = dbRow('SELECT mode, control_state FROM chat_sessions WHERE id = ?', A);
  const control = stored?.control_state ? JSON.parse(stored.control_state) : null;
  check('the stored control state expects the reported mode', control?.mode?.expected === 'default' && stored.mode === 'default', `row ${stored?.mode}, stored ${control?.mode?.expected}`);
  const log = portalLog().split('\n');
  check('the control state was reloaded after the restart (expected bypassPermissions)', log.some((l) => l.includes(A) && l.includes('control state reloaded (expected bypassPermissions')));
  check('the first report was the resync comparison', log.some((l) => l.includes(A) && l.includes('resync: expected bypassPermissions')));
  check('one follower per session file', followers(fileA) === 1 && Math.max(0, ...peak) <= 1, `now ${followers(fileA)}, at most ${Math.max(0, ...peak)} over ${peak.length} looks`);

  // B: the report of a MORE permissive mode still ends the session, and only a person may bring that back.
  const b2 = await turn(B, '[[echo]] after the restart').catch((e) => ({ error: e.message }));
  const afterB = await until('B ended', async () => { const s = await session(B); return s.state === 'ended' ? s : null; }, 30_000).catch(() => null);
  check('B (more permissive report) ends for integrity', !!afterB && /^integrity/i.test(afterB.endedReason ?? '') && /acceptEdits/.test(afterB.endedReason ?? ''), afterB?.endedReason ?? `not ended${b2.error ? `: ${b2.error}` : ''}`);
  check('B is classified mode-changed, suspicious', afterB?.endedFor?.case === 'mode-changed' && afterB.endedFor.classified === 'suspicious', JSON.stringify(afterB?.endedFor ?? null));
  const recB = await call('POST', `/api/chat/sessions/${B}/recover`, { by: 'agent' });
  check('an agent may not recover B (suspicious)', recB.status === 403, `status ${recB.status}`);

  // Bypass back on A: only the gated path.
  check('Bypass comes back on A through the gated path', await enterBypass(A));

  // A ends for a HARMLESS cause: a peer line naming its own sub-agent, with no SendMessage in the stream. Then recovered in place.
  const task = dbRow('SELECT task_id FROM chat_tasks WHERE session_id = ? ORDER BY started_at DESC LIMIT 1', A);
  must('A has its sub-agent on record', !!task?.task_id);
  const fileNow = outFile(A);
  const csid = readFileSync(fileNow, 'utf8').split('\n').reverse().map((l) => { try { return JSON.parse(l).session_id; } catch { return null; } }).find(Boolean);
  const body = 'a message from the sub-agent';
  writeFileSync(fileNow, `${JSON.stringify({ type: 'user', isReplay: true, uuid: randomUUID(), session_id: csid, parent_tool_use_id: null, origin: { kind: 'peer', senderTaskId: task.task_id, body }, message: { role: 'user', content: body } })}\n`, { flag: 'a' });
  const endedA = await until('A ended', async () => { const s = await session(A); return s.state === 'ended' ? s : null; }, 30_000).catch(() => null);
  check('A ended for a harmless cause (replay-peer)', endedA?.endedFor?.case === 'replay-peer' && endedA.endedFor.classified === 'harmless', JSON.stringify(endedA?.endedFor ?? endedA?.endedReason ?? null));
  const rec = await call('POST', `/api/chat/sessions/${A}/recover`, { by: 'agent' });
  check('POST recover as an agent brings A back', rec.status < 300, `status ${rec.status} ${rec.status >= 300 ? rec.text.slice(0, 160) : ''}`);
  const back = await until('A back', async () => { const s = await session(A); return s.state !== 'ended' ? s : null; }, 30_000).catch(() => null);
  const same = (k) => back?.[k] === before[k];
  check('recovered in place: the same id, title, pin, creation time and Claude Code session', !!back && back.id === A && ['title', 'pinnedAt', 'createdAt', 'claudeSessionId'].every(same), back ? ['title', 'pinnedAt', 'createdAt', 'claudeSessionId'].filter((k) => !same(k)).join(', ') || 'all the same' : 'not back');
  check('no new session row', dbRow('SELECT COUNT(*) AS n FROM chat_sessions').n === rowsBefore, `${rowsBefore} rows before`);
  const a4 = await turn(A, '[[echo]] after the recovery');
  check('A answers after the recovery', a4.session.state === 'idle' && !a4.session.endedReason, `state ${a4.session.state}, mode ${a4.session.mode}`);
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.log(`FAIL harness: ${e.message}`);
  // The portal's own lines about this run's chats help the reader; nothing else from its log.
  for (const l of portalLog().split('\n').filter((x) => /\[chat\]/.test(x)).slice(-15)) console.log(`  log: ${l.slice(0, 220)}`);
} finally {
  for (const c of chats) c.close();
  const stopped = sh('scripts/scratch-portal.sh', ['stop', String(PORT)]);
  if (stopped.code !== 0) console.log(`scratch portal stop: ${stopped.out.slice(0, 200)}`);
  mock?.kill();
}
const bad = results.filter((r) => !r.ok).length;
console.log(`restart-survive: ${results.length} checks, ${bad} failed`);
process.exit(bad || failed ? 1 : 0);
