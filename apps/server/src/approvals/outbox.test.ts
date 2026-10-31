// T-2885 (PILOT-1009): a refusal files ONE approval request through the workspace outbox, and the refusal message shows its id. The rule
// guard is run for real (the delivered script, node, a scratch home); the portal side is the handler index.ts subscribes to `approval`.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ownerActor } from '../authz/seam.js';
import { ChatStore } from '../chat/store.js';
import { changedAreas } from '../delivery/changes.js';
import { parseOutbox, type OutboxEvent } from '../delivery/outbox.js';
import { mayWrite } from '../delivery/ownership.js';
import { MANIFEST_PATH } from '../delivery/types.js';
import { RULE_GUARD_MESSAGE, RULE_GUARD_SCRIPT } from '../settings/ruleGuard.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { APPROVAL_KIND_DEFS, type ApprovalChat } from './kinds.js';
import { APPROVAL_CHANNEL, fileRefusalRequests, markUsedPasses, OUTBOX_PENDING_MAX } from './outbox.js';
import { APPROVAL_PASSES_PATH, deniedPoolEnvNames, PASS_TTL_MS, passesContent, passOf, poolEnvNames } from './pass.js';
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
async function portal(opts: { now?: () => number } = {}) {
  const store = await Store.open({ dataDir: scratch('cp-apr-outbox-db-'), secretKey: parseSecretKey(generateSecretKey()) });
  new ChatStore(store).create({ id: CHAT, workspaceId: WS, cwd: '/w', title: 't', origin: 'ui' });
  store.db!.prepare('UPDATE chat_sessions SET claude_session_id = ? WHERE id = ?').run(CLAUDE_SESSION, CHAT);
  const sessions: Record<string, string> = { [CHAT]: WS, 'chat-elsewhere': 'docker/ws2' };
  const chat: ApprovalChat = {
    enterBypass: () => Promise.reject(new Error('not in this test')),
    get: (id) => (sessions[id] ? { id, title: 't', workspaceId: sessions[id]!, bypassCapable: false, mode: 'default', state: 'idle' } : null),
    send: async () => undefined,
  };
  // T-2889: delivery is a fake that records which workspace it was asked to deliver again.
  const delivered: string[] = [];
  const approvals = new Approvals({ db: () => store.db, chat, delivery: { passesChanged: (ws) => void delivered.push(ws) }, ...(opts.now ? { now: opts.now } : {}) });
  after(() => store.close());
  return { store, approvals, delivered };
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
  // T-2889: the passes file of this rig and the owner the guard requires of it (the real ones are fixed; see ruleGuard.ts PASSES_FILE).
  const passes = join(root, 'approval-passes');
  let passOwner = process.getuid!();
  const run = (tool: string, toolInput: Record<string, unknown>, session = CLAUDE_SESSION, cwd = repo) => {
    const r = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ session_id: session, transcript_path: '/dev/null', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput }),
      cwd: repo,
      env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDEPILOT_GUARD_PASSES_FILE: passes, CLAUDEPILOT_GUARD_PASSES_UID: String(passOwner) },
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { code: r.status, stderr: r.stderr };
  };
  const owner = (uid: number) => void (passOwner = uid);
  const file = join(home, '.claudepilot', 'outbox', `${APPROVAL_CHANNEL}.jsonl`);
  const lines = () => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);
  /** What the portal's pull would hand the subscriber. */
  const pulled = (): OutboxEvent[] => parseOutbox(`\x1e${APPROVAL_CHANNEL}.1.pulling\n${lines().join('\n')}\n`).events.map((e) => e.event);
  return { root, home, repo, passes, run, owner, lines, pulled };
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
  assert.match(r.stderr, /When it is allowed, run this same call again \(same input, same folder\) within 15 minutes; it goes through once\./);
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
});

test('T-2889 Allow on a guard refusal issues a pass the guard honours for exactly that call, once; the used line drops it', async () => {
  const g = guardRig();
  const command = `echo '{"x":1}' > .claude/settings.json`;
  const input = { command, description: 'x' };
  const r = g.run('Bash', input);
  assert.equal(r.code, 2, r.stderr);
  const id = idIn(r.stderr)!;
  let now = Date.now();
  const { store, approvals, delivered } = await portal({ now: () => now });
  assert.deepEqual(fileRefusalRequests(approvals, store, WS, g.pulled()), [id]);
  assert.deepEqual(approvals.livePasses(WS), [], 'no pass before Allow');
  // Allow: the result holds the pass (the hash of the exact call, no name or value) and its expiry; delivery is asked for this workspace.
  const allowed = await approvals.allow(ownerActor(), id);
  assert.equal(allowed.result?.ok, true, allowed.result?.message);
  assert.match(allowed.result?.message ?? '', /run the same call again, in the same folder with the same arguments/);
  const pass = passOf('guard.refusal', { tool: 'Bash', input, cwd: g.repo })!;
  const out = allowed.result?.output as { pass: string; until: string; used: boolean };
  assert.equal(out.pass, pass, 'the portal hashes the stored payload as the guard hashes the call');
  assert.equal(Date.parse(out.until), now + PASS_TTL_MS, 'a pass lasts 15 minutes');
  assert.deepEqual(delivered, [WS]);
  assert.deepEqual(approvals.livePasses(WS), [{ pass, until: now + PASS_TTL_MS }]);
  assert.deepEqual(approvals.livePasses('docker/ws2'), [], 'only its own workspace gets it');
  // What the policy owner delivers (agentEnv.fragments): the passes file.
  const deliver = (mode = 0o644) => {
    writeFileSync(g.passes, passesContent(approvals.livePasses(WS)));
    chmodSync(g.passes, mode);
  };
  deliver();
  assert.ok(!readFileSync(g.passes, 'utf8').includes(command), 'the file holds hashes, never the call');
  // Another input, another folder, another tool: still refused (each files its own request). A Bash call's free-text `description` is no
  // part of the call (T-3233, the test below), so "another input" is another command.
  assert.equal(g.run('Bash', { command: `echo '{"x":2}' > .claude/settings.json`, description: 'x' }).code, 2, 'another input');
  assert.equal(g.run('Bash', input, CLAUDE_SESSION, join(g.repo, '.claude')).code, 2, 'another folder');
  assert.equal(g.run('Bash', { ...input, run_in_background: true }).code, 2, 'another field');
  // A file group or others may write, or one root does not own: ignored, so refused.
  deliver(0o664);
  assert.equal(g.run('Bash', input).code, 2, 'group-writable');
  deliver();
  g.owner(process.getuid!() + 1);
  assert.equal(g.run('Bash', input).code, 2, 'not owned by the required owner');
  g.owner(process.getuid!());
  // The exact call: through, once. The use is on the outbox and in the used list.
  const before = g.lines().length;
  const ok = g.run('Bash', input);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stderr, /runs once on a one-time pass a person allowed \(T-2889\)/);
  assert.equal(readFileSync(join(g.home, '.claudepilot', 'approval-passes-used'), 'utf8'), `${pass}\n`);
  const usedLine = g.lines().slice(before).map((l) => JSON.parse(l) as { id: string; type: string; pass: string });
  assert.deepEqual(usedLine.map((l) => [l.type, l.pass]), [['used', pass]]);
  // Again, the file not yet redelivered: refused.
  assert.equal(g.run('Bash', input).code, 2, 'used once already');
  // The portal pulls the used line: the pass is marked used, the workspace is delivered again, and the file drops it.
  assert.equal(markUsedPasses(approvals, 'docker/ws2', g.pulled()), 0, 'another workspace cannot use it up');
  assert.equal(markUsedPasses(approvals, WS, g.pulled()), 1);
  assert.deepEqual(delivered, [WS, WS]);
  assert.deepEqual(approvals.livePasses(WS), []);
  assert.equal((approvals.getFor(ownerActor(), id).result?.output as { used: boolean }).used, true);
  assert.equal(markUsedPasses(approvals, WS, g.pulled()), 0, 'a second pull marks nothing');
  // Expiry: a pass past its time is not delivered, and a listed one past its time is refused by the guard.
  now += PASS_TTL_MS + 1;
  assert.deepEqual(approvals.livePasses(WS), []);
  rmSync(join(g.home, '.claudepilot', 'approval-passes-used'));
  writeFileSync(g.passes, passesContent([{ pass, until: Date.now() - 1000 }]));
  assert.equal(g.run('Bash', input).code, 2, 'expired');
});

// T-3233 (PILOT-1119): T-3206 folds refusals of one Bash command whose free-text `description` differs (Claude Code writes a new one on
// most retries). The pass must ignore it too, on both sides (the guard's hash and passOf), or the retry after Allow is refused again.
test('T-3233 a Bash call\'s description is no part of its pass: after Allow on a folded card, a retry with another description runs once; another command is refused', async () => {
  const g = guardRig();
  const command = `echo '{"x":1}' > .claude/settings.json`;
  // Two refusals of one command, each with its own description: one card.
  assert.equal(g.run('Bash', { command, description: 'Write the settings' }).code, 2);
  assert.equal(g.run('Bash', { command, description: 'Try the settings write again' }).code, 2);
  const { store, approvals } = await portal();
  const ids = fileRefusalRequests(approvals, store, WS, g.pulled());
  assert.equal(new Set(ids).size, 1, 'folded into one card');
  assert.equal(approvals.getFor(ownerActor(), ids[0]!).count, 2);
  const allowed = await approvals.allow(ownerActor(), ids[0]!);
  assert.equal(allowed.result?.ok, true, allowed.result?.message);
  const pass = (allowed.result?.output as { pass: string }).pass;
  // The portal's pass is the same for every description of that command, and for none; not for another command or another field.
  const bash = (input: Record<string, unknown>) => passOf('guard.refusal', { tool: 'Bash', input, cwd: g.repo });
  assert.equal(bash({ command, description: 'anything else' }), pass);
  assert.equal(bash({ command }), pass);
  assert.notEqual(bash({ command: `echo '{"x":2}' > .claude/settings.json`, description: 'Write the settings' }), pass);
  assert.notEqual(bash({ command, description: 'Write the settings', timeout: 5000 }), pass);
  writeFileSync(g.passes, passesContent(approvals.livePasses(WS)));
  chmodSync(g.passes, 0o644);
  const usedFile = join(g.home, '.claudepilot', 'approval-passes-used');
  // A changed command, another field, another folder: refused, and the pass stays unused.
  assert.equal(g.run('Bash', { command: `echo '{"x":2}' > .claude/settings.json`, description: 'Write the settings' }).code, 2, 'another command');
  assert.equal(g.run('Bash', { command, description: 'Write the settings', run_in_background: true }).code, 2, 'another field');
  assert.equal(g.run('Bash', { command, description: 'Write the settings' }, CLAUDE_SESSION, join(g.repo, '.claude')).code, 2, 'another folder');
  assert.ok(!existsSync(usedFile), 'no pass used yet');
  // The same command with a third description: through, once, on the very pass the portal issued.
  const ok = g.run('Bash', { command, description: 'Third attempt at the settings write' });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stderr, /runs once on a one-time pass a person allowed \(T-2889\)/);
  assert.equal(readFileSync(usedFile, 'utf8'), `${pass}\n`, 'the guard hashed the call as the portal did');
  // Once only: the same command again, with yet another description or none, is refused.
  assert.equal(g.run('Bash', { command, description: 'Fourth attempt' }).code, 2, 'used once already');
  assert.equal(g.run('Bash', { command }).code, 2, 'used once already, no description');
});

// T-3233 decision: only a Bash call's `description` is left out. Bash documents it as a label that does not change what runs; another tool
// (an MCP server's) may give a `description` field meaning (a body it writes), so there it stays bound: Allow covers that exact text only.
test('T-3233 a non-Bash tool\'s description stays part of its pass: another description is refused, the allowed one runs once', async () => {
  const g = guardRig();
  const tool = 'mcp__fs__write_file';
  const input = { path: join(g.repo, '.claude', 'settings.json'), content: '{}', description: 'Reset the settings' };
  const r = g.run(tool, input);
  assert.equal(r.code, 2, r.stderr);
  const id = idIn(r.stderr)!;
  const { store, approvals } = await portal();
  assert.deepEqual(fileRefusalRequests(approvals, store, WS, g.pulled()), [id]);
  const allowed = await approvals.allow(ownerActor(), id);
  assert.equal(allowed.result?.ok, true, allowed.result?.message);
  const pass = (allowed.result?.output as { pass: string }).pass;
  assert.notEqual(passOf('guard.refusal', { tool, input: { ...input, description: 'Something else' }, cwd: g.repo }), pass);
  assert.notEqual(passOf('guard.refusal', { tool, input: { path: input.path, content: input.content }, cwd: g.repo }), pass);
  writeFileSync(g.passes, passesContent(approvals.livePasses(WS)));
  chmodSync(g.passes, 0o644);
  assert.equal(g.run(tool, { ...input, description: 'Something else' }).code, 2, 'another description');
  assert.equal(g.run(tool, { path: input.path, content: input.content }).code, 2, 'no description');
  const ok = g.run(tool, input);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(g.run(tool, input).code, 2, 'used once already');
});

test('T-2889 the passes file is root-owned 0644 outside every workspace folder, only the policy owner may write it, and a change to it is no configuration change', () => {
  assert.equal(APPROVAL_PASSES_PATH, '/etc/claudepilot/approval-passes');
  assert.ok(mayWrite('policy', APPROVAL_PASSES_PATH));
  for (const o of ['secrets', 'mcpset', 'skillset', 'persona', 'context', 'browser', 'account', 'settings', 'foundation'] as const) assert.ok(!mayWrite(o, APPROVAL_PASSES_PATH), o);
  const content = passesContent([{ pass: 'a'.repeat(64), until: 2_000_000_000_000 }, { pass: 'not-a-hash', until: 2_000_000_000_000 }]);
  assert.match(content, /^# claudepilot: one-time passes/);
  assert.ok(content.endsWith(`${'a'.repeat(64)} 2000000000\n`) && !content.includes('not-a-hash'), 'only hashes, with expiry in seconds');
  const files = (passesFile: string) => ({ [MANIFEST_PATH]: 'm', [APPROVAL_PASSES_PATH]: passesFile });
  assert.deepEqual(changedAreas({ files: files('one') } as never, { files: files('two') } as never), [], 'no Restart hint for a new pass');
});

test('T-2889 job-run and the portal hash a run the same way; a kind with no pass has none', () => {
  // bash: printf '%s\0' jobrun.pool_env "$PWD" "${argv0[@]}" | sha256sum (jobRun.test.ts runs the script itself).
  const argv = ['--pool-env', 'GITHUB_TOKEN', '--', 'npm test'];
  const nul = ['jobrun.pool_env', '/w', ...argv].map((p) => `${p}\0`).join('');
  assert.equal(passOf('jobrun.pool_env', { name: 'GITHUB_TOKEN', args: argv, cwd: '/w' }), createHash('sha256').update(nul).digest('hex'));
  assert.notEqual(passOf('jobrun.pool_env', { args: argv, cwd: '/w2' }), passOf('jobrun.pool_env', { args: argv, cwd: '/w' }));
  // Key order does not matter (canonical JSON), the value does.
  assert.equal(passOf('guard.refusal', { tool: 'Bash', input: { a: 1, b: [1, { d: 2, c: 3 }] }, cwd: '/w' }), passOf('guard.refusal', { tool: 'Bash', input: { b: [1, { c: 3, d: 2 }], a: 1 }, cwd: '/w' }));
  assert.notEqual(passOf('guard.refusal', { tool: 'Bash', input: { a: 1 }, cwd: '/w' }), passOf('guard.refusal', { tool: 'Bash', input: { a: 2 }, cwd: '/w' }));
  assert.equal(passOf('test.echo', { text: 'x' }), null);
});

test('a guard refusal too large for one outbox line files nothing and says so; no session or no outbox files nothing', () => {
  const g = guardRig();
  // A Write's content is stored as its digest (review M2), so a long call is a long command.
  const big = g.run('Bash', { command: `echo ${'x'.repeat(5000)} > .claude/settings.json` });
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

test('T-2885 review M2: a refused Write stores the path and a digest of the content, never the content; the pass still binds that content', async () => {
  const g = guardRig();
  // A password with no token shape, made at runtime.
  const pw = `hunter-${randomBytes(6).toString('hex')}-pass`;
  const content = `{"db":{"password":"${pw}"}}\n`;
  const input = { file_path: join(g.repo, '.claude', 'settings.json'), content };
  const r = g.run('Write', input);
  assert.equal(r.code, 2, r.stderr);
  const id = idIn(r.stderr)!;
  assert.ok(id, r.stderr);
  // Review m3: the refusal tells the agent the card has no content, and where to put it; a Bash refusal does not say so.
  assert.match(r.stderr, /The card shows the path and a digest, not the content: put the content on your ticket/);
  // The outbox line: path kept, content as sha256.
  const raw = g.lines().join('\n');
  assert.ok(!raw.includes(pw), 'the outbox line never holds the content');
  const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  assert.deepEqual((JSON.parse(g.lines()[0]!) as { payload: { input: unknown } }).payload.input, { file_path: input.file_path, content: digest });
  // The card: the same.
  const { store, approvals } = await portal();
  assert.deepEqual(fileRefusalRequests(approvals, store, WS, g.pulled()), [id]);
  const card = approvals.getFor(ownerActor(), id);
  assert.ok(!JSON.stringify(card).includes(pw), 'the card never holds the content');
  assert.deepEqual((card.payload as { input: unknown }).input, { file_path: input.file_path, content: digest });
  // A line written by hand with raw content (an old guard, a forged line): the portal digests it before it stores it.
  const forged: OutboxEvent = { id: `apr-${randomBytes(9).toString('hex')}`, type: 'request', kind: 'guard.refusal', claudeSession: CLAUDE_SESSION, payload: { tool: 'Write', input, cwd: g.repo, form: 'forged' } };
  const [fid] = fileRefusalRequests(approvals, store, WS, [forged]);
  assert.ok(fid);
  assert.ok(!JSON.stringify(approvals.getFor(ownerActor(), fid!)).includes(pw));
  // Allow: the pass binds the exact content (the same Write passes once; other content is refused).
  const allowed = await approvals.allow(ownerActor(), id);
  assert.equal(allowed.result?.ok, true, allowed.result?.message);
  writeFileSync(g.passes, passesContent(approvals.livePasses(WS)));
  chmodSync(g.passes, 0o644);
  assert.equal(g.run('Write', { ...input, content: `${content} ` }).code, 2, 'other content');
  assert.equal(g.run('Write', { ...input, content: digest }).code, 2, 'the digest itself as content');
  const ok = g.run('Write', input);
  assert.equal(ok.code, 0, ok.stderr);
  // A Bash refusal has no content to point at.
  assert.doesNotMatch(g.run('Bash', { command: 'echo x > .claude/settings.json' }).stderr, /put the content on your ticket/);
});

test('T-2885 review M1: a forged outbox line buys no pass for a call that was never refused', async () => {
  const g = guardRig();
  const { store, approvals, delivered } = await portal();
  const newId = () => `apr-${randomBytes(9).toString('hex')}`;
  // job-run: a name it delivers freely, or a deny-listed name the arguments never pass as --pool-env: Allow gives no pass.
  const runs = [
    { name: 'STG_SEARCH_READ_KEY', args: ['--pool-env', 'STG_SEARCH_READ_KEY', '--', 'true'], cwd: '/w' },
    { name: 'GITHUB_TOKEN', args: ['--', 'echo GITHUB_TOKEN'], cwd: '/w' },
  ];
  const jobIds = fileRefusalRequests(approvals, store, WS, runs.map((payload) => ({ id: newId(), type: 'request', kind: 'jobrun.pool_env', session: CHAT, payload })));
  assert.equal(jobIds.length, 2);
  for (const id of jobIds) {
    const r = await approvals.allow(ownerActor(), id);
    assert.equal(r.result?.ok, false, r.result?.message);
    assert.match(r.result?.message ?? '', /No pass: job-run would not refuse this run/);
  }
  // guard: a call whose secret part redaction removed is not the exact call: no pass, and the card never holds the value.
  const fake = `ghp_${randomBytes(18).toString('hex').slice(0, 36)}`;
  const [redId] = fileRefusalRequests(approvals, store, WS, [
    { id: newId(), type: 'request', kind: 'guard.refusal', claudeSession: CLAUDE_SESSION, payload: { tool: 'Bash', input: { command: `echo ${fake} > .claude/settings.json` }, cwd: g.repo, form: 'forged' } },
  ]);
  assert.ok(redId);
  assert.ok(!JSON.stringify(approvals.getFor(ownerActor(), redId!)).includes(fake));
  const red = await approvals.allow(ownerActor(), redId!);
  assert.equal(red.result?.ok, false);
  assert.match(red.result?.message ?? '', /No pass: parts of this call were redacted/);
  assert.deepEqual(approvals.livePasses(WS), []);
  assert.deepEqual(delivered, [], 'nothing delivered');
  // guard: a forged line for a call the guard allows anyway. Allow makes a pass, but the guard consults passes only when it refuses,
  // so the pass is never used: the call runs as it always did, nothing is marked used, and a refused call is not helped by it.
  const allowedCall = { command: 'echo hi > notes.txt', description: 'x' };
  const [aid] = fileRefusalRequests(approvals, store, WS, [{ id: newId(), type: 'request', kind: 'guard.refusal', claudeSession: CLAUDE_SESSION, payload: { tool: 'Bash', input: allowedCall, cwd: g.repo, form: 'forged' } }]);
  assert.equal((await approvals.allow(ownerActor(), aid!)).result?.ok, true);
  writeFileSync(g.passes, passesContent(approvals.livePasses(WS)));
  chmodSync(g.passes, 0o644);
  const r = g.run('Bash', allowedCall);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /one-time pass/);
  assert.ok(!existsSync(join(g.home, '.claudepilot', 'approval-passes-used')), 'the pass is not consumed');
  assert.equal(g.run('Bash', { command: `echo '{"x":1}' > .claude/settings.json` }).code, 2, 'a refused call is still refused');
});

test('T-2889 review m4: the job-run card names every deny-listed name the run passes; the arguments parse as job-run parses them', async () => {
  const { store, approvals } = await portal();
  // Two deny-listed names, one delivered freely, and words after `--` (the command, not options).
  const args = ['--ref', 'main', '--pool-env', 'GITHUB_TOKEN', '--pool-env', 'STG_SEARCH_READ_KEY', '--pool-env', 'X_RW_Y', '--pool-env', 'GITHUB_TOKEN', '--', 'echo', '--pool-env', 'PROD_X'];
  assert.deepEqual(poolEnvNames(args), ['GITHUB_TOKEN', 'STG_SEARCH_READ_KEY', 'X_RW_Y', 'GITHUB_TOKEN']);
  assert.deepEqual(deniedPoolEnvNames(args), ['GITHUB_TOKEN', 'X_RW_Y']);
  // A value option takes the next word, even one that looks like --pool-env: job-run would not read it as an option.
  assert.deepEqual(poolEnvNames(['--ref', '--pool-env', 'GITHUB_TOKEN']), []);
  const [id] = fileRefusalRequests(approvals, store, WS, [{ id: `apr-${randomBytes(9).toString('hex')}`, type: 'request', kind: 'jobrun.pool_env', session: CHAT, payload: { name: 'GITHUB_TOKEN', args, cwd: '/w' } }]);
  assert.ok(id);
  const title = APPROVAL_KIND_DEFS['jobrun.pool_env'].title(approvals.getFor(ownerActor(), id!).payload as Record<string, unknown>, approvals.deps);
  assert.match(title, /GITHUB_TOKEN/);
  assert.match(title, /X_RW_Y/);
  assert.doesNotMatch(title, /STG_SEARCH_READ_KEY|PROD_X/);
});

test('approval_request may not ask for a refusal kind as the portal (no session)', async () => {
  const { approvals } = await portal();
  assert.throws(() => approvals.create({ kind: 'jobrun.pool_env', payload: { name: 'GITHUB_TOKEN', args: ['x'], cwd: '/w' } }, null), /Only an agent session/);
  assert.throws(() => approvals.create({ kind: 'test.echo', payload: { text: 'x' } }, null, { id: 'apr-1' }), /Not an approval id/);
});
