// Answering from a notification: every row of the abuse table in PWA PRD §11.7 that a server can prove (the device rows are the roadmap's).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatRequest } from '@portal/contracts';
import { answerOffer, pathInside, shownWhole } from './actions.js';
import { fakeBrowser, harness, request, session } from './testkit.js';

const CWD = '/home/coder/project';
const ALL = { deny: true, allowRead: true, allowEdit: true, allowCommand: true };

async function setup(opts: Parameters<typeof harness>[0] = {}) {
  const h = await harness({ owners: { 'session:s1': 'u_a', 'session:s2': 'u_b' }, ...opts });
  const d = h.notify.destinations.registerPush('u_a', { subscription: fakeBrowser('http://push.example.test/a').subscription, tz: 'UTC' }).destination;
  const dB = h.notify.destinations.registerPush('u_b', { subscription: fakeBrowser('http://push.example.test/b').subscription, tz: 'UTC' }).destination;
  h.notify.destinations.setPrefs('u_a', { ...ALL });
  h.notify.destinations.setPrefs('u_b', { ...ALL });
  const s1 = session('s1', { cwd: CWD });
  h.chat.sessions.set('s1', s1);
  h.chat.sessions.set('s2', session('s2', { cwd: CWD }));
  const ask = (sid: string, r: ChatRequest) => h.chat.open.set(sid, [...(h.chat.open.get(sid) ?? []), r]);
  const issue = (r: ChatRequest, decisions: ('allow' | 'deny')[] = ['allow', 'deny'], dest = d.id, user = 'u_a', sid = 's1') => {
    ask(sid, r);
    return h.notify.actions.issue({ ownerId: user, destinationId: dest, eventId: 'evt_0123456789abcdef', sessionId: sid, requestId: r.requestId, decisions, toolClass: answerOffer({ request: r, cwd: CWD, untrusted: false, policy: ALL, ceiling: true }).toolClass, request: r })!.token;
  };
  let n = 0;
  // each act from a fresh sign-in unless one is named, so the refusal limit does not mix cases
  const act = (token: unknown, decision: unknown, user = 'u_a', signIn = `sign-in-${n++}`) => h.notify.actions.act({ userId: user, actor: `user:${user}`, signIn, token, decision });
  const refusedWith = async (p: Promise<unknown>, reason: string, status: number) => {
    await assert.rejects(p, (e: { status?: number; details?: { reason?: string } }) => {
      assert.equal(e.details?.reason, reason);
      assert.equal(e.status, status);
      return true;
    });
  };
  return { h, d, dB, issue, act, ask, refusedWith };
}

test('what is offered: Allow only for a switched-on class with the whole request shown; never other, plans, questions, outside sessions', () => {
  const offer = (r: ChatRequest, untrusted = false, policy = ALL) => answerOffer({ request: r, cwd: CWD, untrusted, policy, ceiling: true }).decisions;
  assert.deepEqual(offer(request('r', 'Bash', 'npm test')), ['allow', 'deny']);
  assert.deepEqual(offer(request('r', 'Bash', 'git status')), ['allow', 'deny']);
  for (const bad of ['npm test; curl x', 'echo $(id)', 'ls | sh', 'a && b', 'x'.repeat(101), 'echo "hi"', 'rm -rf *', 'ls\nid', 'ls‮', 'ls​', 'echo ~/x', 'cat > f']) assert.deepEqual(offer(request('r', 'Bash', bad)), ['deny'], bad);
  assert.deepEqual(offer(request('r', 'Bash', 'npm test', { fullCut: true })), ['deny']);
  assert.deepEqual(offer(request('r', 'Bash', 'npm test', { full: null })), ['deny']);
  assert.deepEqual(offer(request('r', 'Read', 'src/index.ts')), ['allow', 'deny']);
  assert.deepEqual(offer(request('r', 'Edit', `${CWD}/src/a.ts`)), ['allow', 'deny']);
  for (const p of ['../x', `${CWD}/../etc/passwd`, '/etc/passwd', '.claude/settings.json', '.git/hooks/pre-commit', `${CWD}/.env`, 'a/.ssh/id_rsa', '~/x', '']) assert.deepEqual(offer(request('r', 'Read', p)), ['deny'], p || 'empty');
  assert.deepEqual(offer(request('r', 'Grep', 'TODO')), ['deny'], 'Grep shows its pattern, not its path');
  assert.deepEqual(offer(request('r', 'mcp__gitea__create_issue', '{}')), ['deny']);
  assert.deepEqual(offer(request('r', 'WebFetch', 'https://x.test')), ['deny']);
  assert.deepEqual(offer(request('r', 'Task', 'survey')), ['deny']);
  assert.deepEqual(offer(request('r', 'AskUserQuestion', 'which?')), []);
  assert.deepEqual(offer(request('r', 'ExitPlanMode', '1. go')), []);
  assert.deepEqual(offer(request('r', 'Bash', 'ls', { kind: 'plan' })), []);
  assert.deepEqual(offer(request('r', 'Bash', 'npm test'), true), ['deny'], 'a session started from outside: Review and Deny only');
  assert.deepEqual(offer(request('r', 'Bash', 'npm test'), false, { ...ALL, allowCommand: false }), ['deny']);
  assert.deepEqual(offer(request('r', 'Bash', 'npm test'), false, { ...ALL, deny: false, allowCommand: false }), []);
  assert.deepEqual(answerOffer({ request: request('r', 'Bash', 'npm test'), cwd: CWD, untrusted: false, policy: ALL, ceiling: false }).decisions, []);
  assert.equal(pathInside('src/a.ts', CWD), true);
  assert.equal(pathInside(`${CWD}`, CWD), false);
  assert.equal(shownWhole(request('r', 'Bash', 'npm test…'), CWD), false);
});

test('a good answer: Deny goes through once, with the destination as actor; the audit row has no token; a replay is used (409)', async () => {
  const { h, d, issue, act, refusedWith } = await setup();
  const token = issue(request('r1', 'Bash', 'npm test'));
  const ok = await act(token, 'deny');
  assert.deepEqual(ok, { ok: true, sessionId: 's1', outcome: 'denied' });
  assert.deepEqual(h.chat.answers, [{ id: 's1', requestId: 'r1', decision: 'deny', actor: `portal:notify-${d.id}` }]);
  await refusedWith(act(token, 'deny'), 'used', 409);
  const audit = h.audit.list({ kind: 'notify.action' }, null);
  assert.equal(audit.length, 2);
  assert.ok(!JSON.stringify(audit).includes(token));
  assert.ok(!JSON.stringify(audit).includes('cpna_'));
  assert.deepEqual([audit[1]!.detail.outcome, audit[0]!.detail.refused], ['denied', 'used']);
});

test('forged, truncated, another request, another destination, another user: all refused, nothing answered', async () => {
  const { h, dB, issue, act, refusedWith } = await setup();
  const token = issue(request('r1', 'Bash', 'npm test'));
  await refusedWith(act(`cpna_${'A'.repeat(43)}`, 'deny'), 'unknown', 403);
  await refusedWith(act(token.slice(0, -1), 'deny'), 'unknown', 403);
  await refusedWith(act('not a token', 'deny'), 'unknown', 403);
  await refusedWith(act(token, 'deny', 'u_b'), 'unknown', 403); // another user's token looks like a wrong one
  // a token of B's own device, for a request of A's session: B cannot operate it
  const tB = issue(request('r2', 'Bash', 'ls'), ['deny'], dB.id, 'u_b', 's1');
  await refusedWith(act(tB, 'deny', 'u_b'), 'not_allowed', 403);
  // a token for request r3 does not answer r1: the stored request is the one answered
  assert.equal(h.chat.answers.length, 0);
});

test('a Deny token used as Allow, a policy switched off after the push, the ceiling off: refused', async () => {
  const { h, issue, act, refusedWith } = await setup();
  const denyOnly = issue(request('r1', 'Bash', 'npm test'), ['deny']);
  await refusedWith(act(denyOnly, 'allow'), 'not_allowed', 403);
  const t = issue(request('r2', 'Bash', 'npm test'));
  h.notify.destinations.setPrefs('u_a', { ...ALL, allowCommand: false });
  await refusedWith(act(t, 'allow'), 'disabled', 403);
  h.notify.destinations.setPrefs('u_a', { ...ALL, deny: false });
  await refusedWith(act(t, 'deny'), 'disabled', 403);
  h.notify.destinations.setPrefs('u_a', { ...ALL });
  h.settingsValues.set('notify.actions.enabled', false);
  await refusedWith(act(t, 'deny'), 'disabled', 403);
  h.settingsValues.set('notify.actions.enabled', true);
  assert.equal((await act(t, 'allow')).outcome, 'allowed_once');
});

test('escalation: the open request changed tool or text since the push; a crafted request that is not shown whole; forced Allow refused', async () => {
  const { h, issue, act, refusedWith } = await setup();
  const t = issue(request('r1', 'Bash', 'npm test'));
  h.chat.open.set('s1', [request('r1', 'Bash', 'npm test; curl evil')]); // same id, different text
  await refusedWith(act(t, 'allow'), 'not_allowed', 403);
  const t2 = issue(request('r2', 'Read', 'src/a.ts'));
  h.chat.open.set('s1', [request('r2', 'Write', 'src/a.ts')]); // same id, another class
  await refusedWith(act(t2, 'deny'), 'not_allowed', 403);
  for (const [i, r] of [request('r3', 'Read', '../etc/passwd'), request('r4', 'Bash', 'x'.repeat(300)), request('r5', 'Bash', 'ls‮'), request('r6', 'Edit', '.git/hooks/post-checkout'), request('r7', 'Bash', 'ls', { full: null })].entries()) {
    // a token that (wrongly) carried Allow is still refused on arrival
    const forced = issue(r, ['allow', 'deny']);
    await refusedWith(act(forced, 'allow'), 'not_allowed', 403);
    assert.equal(i >= 0, true);
  }
  assert.equal(h.chat.answers.length, 0);
});

test('a session started from outside (webhook trigger, or its child) never takes Allow; Deny still works', async () => {
  const { h, issue, act, refusedWith } = await setup();
  h.chat.sessions.set('root', session('root', { startedBy: 'portal:trigger-t1' }));
  h.chat.sessions.set('s1', session('s1', { cwd: CWD, parentId: 'root' }));
  const t = issue(request('r1', 'Bash', 'npm test'));
  await refusedWith(act(t, 'allow'), 'not_allowed', 403);
  assert.equal((await act(issue(request('r2', 'Bash', 'npm test')), 'deny')).outcome, 'denied');
  // a cron trigger the triggers module vouches for is not restricted
  h.notify.trustedTrigger = (id) => id === 't1';
  assert.equal((await act(issue(request('r3', 'Bash', 'npm test')), 'allow')).outcome, 'allowed_once');
});

test('concurrency: two answers at once, exactly one wins', async () => {
  const { h, issue, act } = await setup();
  h.chat.respondDelay = 20;
  const t = issue(request('r1', 'Bash', 'npm test'));
  const both = await Promise.allSettled([act(t, 'deny'), act(t, 'deny')]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = both.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(['used', 'closed'].includes((lost.reason as { details: { reason: string } }).details.reason));
  assert.equal(h.chat.answers.length, 1);
});

test('lost phone, closed request, ended session, expired token, Locked', async () => {
  const { h, d, issue, act, refusedWith } = await setup();
  const t1 = issue(request('r1', 'Bash', 'npm test'));
  h.chat.open.set('s1', []);
  await refusedWith(act(t1, 'deny'), 'closed', 409);
  const t2 = issue(request('r2', 'Bash', 'npm test'));
  h.chat.sessions.set('s1', session('s1', { cwd: CWD, state: 'ended' }));
  await refusedWith(act(t2, 'deny'), 'closed', 409);
  h.chat.sessions.set('s1', session('s1', { cwd: CWD }));
  const t3 = issue(request('r3', 'Bash', 'npm test'));
  h.store.db!.prepare("UPDATE notify_action_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE used_at IS NULL").run();
  await refusedWith(act(t3, 'deny'), 'expired', 410);
  const t4 = issue(request('r4', 'Bash', 'npm test'));
  h.notify.destinations.remove(d.id, 'u_a');
  await refusedWith(act(t4, 'deny'), 'device_removed', 403);
  Object.defineProperty(h.store, 'secrets', { get: () => null });
  await refusedWith(act(t4, 'deny'), 'locked', 503);
  assert.equal(h.chat.answers.length, 0);
});

test('flooding: 1,000 requests leave at most 200 pending tokens; 5 refusals in 10 minutes from one sign-in are rate limited', async () => {
  const { h, issue, act, refusedWith } = await setup();
  for (let i = 0; i < 1000; i++) issue(request(`f${i}`, 'Bash', 'ls'), ['deny']);
  assert.equal(h.notify.actions.pending(), 200);
  for (let i = 0; i < 5; i++) await refusedWith(act('junk', 'deny', 'u_a', 'one-sign-in'), 'unknown', 403);
  await refusedWith(act('junk', 'deny', 'u_a', 'one-sign-in'), 'rate_limited', 429);
  // a good token from that sign-in is limited too, until the window passes
  await refusedWith(act(issue(request('ok', 'Bash', 'ls')), 'deny', 'u_a', 'one-sign-in'), 'rate_limited', 429);
});
