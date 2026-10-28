// T-2885 (PILOT-1009): a refusal files ONE approval request through the workspace outbox, and the refusal message shows its id. The rule
// guard is run for real (the delivered script, node, a scratch home); the portal side is the handler index.ts subscribes to `approval`.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ownerActor } from '../authz/seam.js';
import { ChatStore } from '../chat/store.js';
import { parseOutbox, type OutboxEvent } from '../delivery/outbox.js';
import { RULE_GUARD_MESSAGE, RULE_GUARD_SCRIPT } from '../settings/ruleGuard.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { ApprovalChat } from './kinds.js';
import { APPROVAL_CHANNEL, fileRefusalRequests, OUTBOX_PENDING_MAX } from './outbox.js';
import { APPROVAL_ID, Approvals } from './service.js';

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const scratch = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  roots.push(d);
  return d;
};

const WS = 'docker/ws1';
const CHAT = 'chat-a';
const CLAUDE_SESSION = 'a1b2c3d4-0000-4000-8000-0000000000aa';

/** The portal: a store whose chat CHAT (workspace WS) ran Claude Code session CLAUDE_SESSION, and an Approvals that knows that chat only. */
async function portal() {
  const store = await Store.open({ dataDir: scratch('cp-apr-outbox-db-'), secretKey: parseSecretKey(generateSecretKey()) });
  new ChatStore(store).create({ id: CHAT, workspaceId: WS, cwd: '/w', title: 't', origin: 'ui' });
  store.db!.prepare('UPDATE chat_sessions SET claude_session_id = ? WHERE id = ?').run(CLAUDE_SESSION, CHAT);
  const sessions: Record<string, string> = { [CHAT]: WS, 'chat-elsewhere': 'docker/ws2' };
  const chat: ApprovalChat = {
    enterBypass: () => Promise.reject(new Error('not in this test')),
    get: (id) => (sessions[id] ? { id, title: 't', workspaceId: sessions[id]!, bypassCapable: false, mode: 'default', state: 'idle' } : null),
    send: async () => undefined,
  };
  const approvals = new Approvals({ db: () => store.db, chat });
  after(() => store.close());
  return { store, approvals };
}

/** A scratch home with an outbox, and the guard's Node half. */
function guardRig() {
  const root = scratch('cp-apr-guard-');
  const home = join(root, 'home');
  mkdirSync(join(home, '.claudepilot', 'outbox'), { recursive: true });
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json'), '{}\n');
  const script = join(root, 'policy-rule-guard.cjs');
  writeFileSync(script, RULE_GUARD_SCRIPT);
  const run = (tool: string, toolInput: Record<string, unknown>, session = CLAUDE_SESSION) => {
    const r = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ session_id: session, transcript_path: '/dev/null', cwd: repo, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput }),
      cwd: repo,
      env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { code: r.status, stderr: r.stderr };
  };
  const file = join(home, '.claudepilot', 'outbox', `${APPROVAL_CHANNEL}.jsonl`);
  const lines = () => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);
  /** What the portal's pull would hand the subscriber. */
  const pulled = (): OutboxEvent[] => parseOutbox(`\x1e${APPROVAL_CHANNEL}.1.pulling\n${lines().join('\n')}\n`).events.map((e) => e.event);
  return { repo, run, lines, pulled };
}

const idIn = (text: string) => /approval request (apr-[0-9a-f]{18}) is filed/.exec(text)?.[1];

test('a guard refusal files exactly one request with the exact call, shows its id, and the portal makes that request', async () => {
  const g = guardRig();
  const command = `echo '{"x":1}' > .claude/settings.json`;
  const r = g.run('Bash', { command, description: 'x' });
  assert.equal(r.code, 2, r.stderr);
  assert.ok(r.stderr.startsWith(RULE_GUARD_MESSAGE), r.stderr);
  const id = idIn(r.stderr);
  assert.ok(id, `the refusal shows the request id: ${r.stderr}`);
  assert.match(r.stderr, /Allow runs nothing yet \(T-2889\)/);
  // One line, the exact call (tool, its whole input, the folder, the form), and the session.
  assert.equal(g.lines().length, 1);
  const line = JSON.parse(g.lines()[0]!) as Record<string, unknown>;
  assert.equal(line.id, id);
  assert.equal(line.kind, 'guard.refusal');
  assert.equal(line.claudeSession, CLAUDE_SESSION);
  assert.deepEqual(line.payload, { tool: 'Bash', input: { command, description: 'x' }, cwd: g.repo, form: (line.payload as { form: string }).form });
  // An allowed call files nothing.
  assert.equal(g.run('Bash', { command: 'echo hi > notes.txt', description: 'x' }).code, 0);
  assert.equal(g.lines().length, 1, 'no request for an allowed call');

  const { store, approvals } = await portal();
  assert.deepEqual(fileRefusalRequests(approvals, store, WS, g.pulled()), [id]);
  const a = approvals.getFor(ownerActor(), id);
  assert.equal(a.kind, 'guard.refusal');
  assert.equal(a.status, 'pending');
  assert.equal(a.requesterSession, CHAT, 'the Claude Code session maps to its portal chat');
  assert.equal(a.workspace, WS);
  assert.deepEqual((a.payload as { input: unknown }).input, { command, description: 'x' });
  // The same line pulled again (a restart re-reading a file) makes nothing more: the id is taken.
  assert.deepEqual(fileRefusalRequests(approvals, store, WS, g.pulled()), []);
  assert.equal(approvals.listOwn(CHAT).length, 1, 'exactly one request');
  // Allow runs nothing yet, and says so (T-2889).
  const allowed = await approvals.allow(ownerActor(), id);
  assert.equal(allowed.status, 'allowed');
  assert.equal(allowed.result?.ok, false);
  assert.match(allowed.result?.message ?? '', /Nothing ran.*T-2889/);
});

test('a guard refusal too large for one outbox line files nothing and says so; no session or no outbox files nothing', () => {
  const g = guardRig();
  const big = g.run('Write', { file_path: join(g.repo, '.claude', 'settings.json'), content: 'x'.repeat(5000) });
  assert.equal(big.code, 2);
  assert.match(big.stderr, /too large to file as an approval request/);
  assert.equal(idIn(big.stderr), undefined);
  const none = g.run('Bash', { command: 'echo x > .claude/settings.json' }, '');
  assert.equal(none.code, 2);
  assert.equal(idIn(none.stderr), undefined, 'no session: no request');
  assert.equal(g.lines().length, 0);
});

test('the portal files only the outbox kinds, only for a chat of the pulled workspace, at most five waiting per session, and never a secret-shaped payload', async () => {
  const { store, approvals } = await portal();
  const newId = () => `apr-${randomBytes(9).toString('hex')}`;
  const line = (over: Record<string, unknown> = {}): OutboxEvent => ({
    id: newId(),
    type: 'request',
    kind: 'jobrun.pool_env',
    session: CHAT,
    payload: { name: 'GITHUB_TOKEN', args: ['--pool-env', 'GITHUB_TOKEN', '--', 'true'], cwd: '/w' },
    ...over,
  });
  // Not an outbox kind (Bypass, a secret write): dropped, whatever the line says.
  assert.deepEqual(fileRefusalRequests(approvals, store, WS, [line({ kind: 'session.bypass', payload: { sessionId: CHAT } })]), []);
  // Another workspace's chat, an unknown chat, no session: dropped.
  assert.deepEqual(fileRefusalRequests(approvals, store, WS, [line({ session: 'chat-elsewhere' }), line({ session: 'chat-nobody' }), line({ session: undefined })]), []);
  // The same chat pulled from another workspace: dropped.
  assert.deepEqual(fileRefusalRequests(approvals, store, 'docker/ws2', [line()]), []);
  // A secret-shaped value in the payload, a payload of the wrong shape, an id not of the service's shape: refused by the service.
  const fake = `ghp_${randomBytes(18).toString('hex').slice(0, 36)}`;
  const logged: string[] = [];
  const bad = [line({ payload: { name: 'GITHUB_TOKEN', args: ['--', `echo ${fake}`], cwd: '/w' } }), line({ payload: { name: 'lower', args: ['x'], cwd: '/w' } }), line({ id: 'apr-nothex' })];
  assert.deepEqual(fileRefusalRequests(approvals, store, WS, bad, (what, e) => logged.push(`${what}: ${(e as Error).message}`)), []);
  assert.equal(logged.length, 3);
  assert.ok(!logged.join('\n').includes(fake), 'the log never holds the payload');
  // Five wait at once per session; the sixth is dropped until one is decided.
  const five = Array.from({ length: OUTBOX_PENDING_MAX + 1 }, () => line());
  const made = fileRefusalRequests(approvals, store, WS, five);
  assert.equal(made.length, OUTBOX_PENDING_MAX);
  assert.ok(made.every((id) => APPROVAL_ID.test(id)));
  await approvals.deny(ownerActor(), made[0]!);
  assert.equal(fileRefusalRequests(approvals, store, WS, [line()]).length, 1);
});

test('approval_request may not ask for a refusal kind as the portal (no session)', async () => {
  const { approvals } = await portal();
  assert.throws(() => approvals.create({ kind: 'jobrun.pool_env', payload: { name: 'GITHUB_TOKEN', args: ['x'], cwd: '/w' } }, null), /Only an agent session/);
  assert.throws(() => approvals.create({ kind: 'test.echo', payload: { text: 'x' } }, null, { id: 'apr-1' }), /Not an approval id/);
});
