import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { CreatedTrigger, Trigger } from '@portal/contracts';
import { clearResolvers } from '../authz/seam.js';
import { readBody, RECEIVER_LIMITS } from './receiver.js';
import { inputs, triggerHarness } from './testkit.js';

type H = Awaited<ReturnType<typeof triggerHarness>>;
const made: H[] = [];
after(() => {
  for (const h of made) h.runner.stop();
  clearResolvers();
});

const SHA = 'a10867b14bb761a232cd80139fbd4c0d33264240';
const pr = (title = 'Fix it', n = 42) =>
  JSON.stringify({ action: 'opened', number: n, pull_request: { number: n, title, body: 'b', html_url: `https://github.com/owner/name/pull/${n}`, base: { ref: 'main', repo: { full_name: 'owner/name' } }, head: { sha: SHA, repo: { full_name: 'owner/name', fork: false } }, labels: [] }, repository: { full_name: 'owner/name' }, sender: { login: 'octocat' } });
const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

async function setup(input: Record<string, unknown> = inputs.webhook('github')) {
  const h = await triggerHarness();
  made.push(h);
  const r = await h.api('POST', '/api/triggers', input);
  const c = r.json.data as CreatedTrigger;
  const post = (body: string, headers: Record<string, string> = {}, path = c.trigger.webhook!.path) =>
    h.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': `d-${Math.random()}`, ...headers }, body });
  const signed = (body: string, headers: Record<string, string> = {}) => post(body, { 'x-hub-signature-256': sign(c.secret!, body), ...headers });
  const runs = () => h.store.runs({ ownerId: 'u_a', triggerId: c.trigger.id, limit: 200 }).rows;
  return { h, c, post, signed, runs };
}

describe('the public receiver (FR4 to FR9)', () => {
  it('a signed delivery answers {"ok":true} and becomes a pending run', async () => {
    const { signed, runs } = await setup();
    const res = await signed(pr());
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"ok":true}');
    assert.deepEqual(runs().map((r) => r.state), ['pending_approval']);
  });

  it('R1, R7: an unknown, malformed or deleted token, and GET, PUT, HEAD answer the same 404', async () => {
    const { h, c, post, signed } = await setup();
    const base = await h.app.request('/hooks/cpwh_' + 'A'.repeat(32), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const want = [base.status, await base.text()];
    assert.equal(want[0], 404);
    for (const res of [
      await h.app.request('/hooks/nope', { method: 'POST', body: '{}' }),
      await h.app.request(c.trigger.webhook!.path, { method: 'GET' }),
      await h.app.request(c.trigger.webhook!.path, { method: 'PUT', body: '{}' }),
    ])
      assert.deepEqual([res.status, await res.text()], want);
    const head = await h.app.request(c.trigger.webhook!.path, { method: 'HEAD' });
    assert.equal(head.status, 404);
    // Disabled, then deleted: 404 as well.
    await h.api('PATCH', `/api/triggers/${c.trigger.id}`, { enabled: false });
    const off = await signed(pr());
    assert.deepEqual([off.status, await off.text()], want);
    await h.api('PATCH', `/api/triggers/${c.trigger.id}`, { enabled: true });
    await h.api('DELETE', `/api/triggers/${c.trigger.id}`);
    const gone = await post('{}');
    assert.deepEqual([gone.status, await gone.text()], want);
  });

  it('R2, R3: missing, wrong, empty signatures and another body are 401 with a fixed body; 5 failures block that address only', async () => {
    const { h, c, post, signed, runs } = await setup();
    const body = pr();
    const answers = [
      await post(body),
      await post(body, { 'x-hub-signature-256': '' }),
      await post(body, { 'x-hub-signature-256': sign('wrong', body) }),
      await post(body + ' ', { 'x-hub-signature-256': sign(c.secret!, body) }),
    ];
    const texts = await Promise.all(answers.map((r) => r.text()));
    assert.deepEqual(answers.map((r) => r.status), [401, 401, 401, 401]);
    assert.equal(new Set(texts).size, 1, 'one fixed body');
    const fifth = await post(body, { 'x-hub-signature-256': 'sha1=00' });
    assert.equal(fifth.status, 401);
    const blocked = await signed(body);
    assert.equal(blocked.status, 429, 'the pair (token, 10.0.0.1) is blocked, even for a valid one');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    const other = await signed(body, { 'x-test-addr': '10.0.0.2' });
    assert.equal(other.status, 200, 'another address is still answered');
    assert.equal(runs().length, 1);
    void h;
  });

  it('R4: the same delivery id twice: 200 both times, one run, counted as a duplicate', async () => {
    const { h, c, signed, runs } = await setup();
    const a = await signed(pr(), { 'x-github-delivery': 'same-1' });
    const b = await signed(pr(), { 'x-github-delivery': 'same-1' });
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(runs().length, 1);
    assert.equal(h.store.counts(c.trigger.id, h.clock.now().toISOString().slice(0, 10)).duplicate, 1);
  });

  it('R6: a body over 1 MiB is 413 before the rest is read; a body that trickles past the time limit is cut', async () => {
    const { signed } = await setup();
    const big = '{"x":"' + 'a'.repeat(1_048_576) + '"}';
    const res = await signed(big);
    assert.equal(res.status, 413);
    assert.equal(res.headers.get('connection'), 'close');
    let pulled = 0;
    const slow = new Request('http://x/', {
      method: 'POST',
      body: new ReadableStream({
        async pull(ctl) {
          pulled++;
          await new Promise((r) => setTimeout(r, 30));
          ctl.enqueue(new TextEncoder().encode('a'));
        },
      }),
      duplex: 'half',
    } as RequestInit);
    assert.equal(await readBody(slow, 1024, 100), 'timeout');
    assert.ok(pulled < 10);
    const huge = new Request('http://x/', { method: 'POST', body: new ReadableStream({ pull: (ctl) => ctl.enqueue(new Uint8Array(4096)) }), duplex: 'half' } as RequestInit);
    assert.equal(await readBody(huge, 10_000, 5_000), 'too_large');
  });

  it('R7: a form or text type, and gzip, are 415', async () => {
    const { signed } = await setup();
    assert.equal((await signed(pr(), { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await signed(pr(), { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await signed(pr(), { 'content-encoding': 'gzip' })).status, 415);
    assert.equal((await signed(pr(), { 'content-type': 'application/json; charset=utf-8' })).status, 200);
  });

  it('R8: a valid signature over malformed JSON is 400; over an unknown event or a ping, 200 and no run', async () => {
    const { signed, runs } = await setup();
    assert.equal((await signed('{"a":')).status, 400);
    assert.equal((await signed('[1]')).status, 400);
    assert.equal((await signed('{"zen":"x"}', { 'x-github-event': 'ping' })).status, 200);
    assert.equal((await signed('{"action":"created"}', { 'x-github-event': 'star' })).status, 200);
    assert.equal(runs().length, 0);
  });

  it('filters: an event the trigger does not listen to is answered 200 and counted, not stored', async () => {
    const { h, c, signed, runs } = await setup(inputs.webhook('github', { webhook: { ...inputs.webhook().webhook, events: ['issue'] } }));
    assert.equal((await signed(pr())).status, 200);
    assert.equal(runs().length, 0);
    assert.equal(h.store.counts(c.trigger.id, h.clock.now().toISOString().slice(0, 10)).filtered, 1);
  });

  it('R14: a flood of valid deliveries is bounded: 60 a minute per token, then 429; stored skips at most 120 an hour', async () => {
    const { h, signed, runs } = await setup(inputs.webhook('github', { approval: { mode: 'never' }, confirm: true }));
    h.state.masterOn = false; // every delivery is a skip: the storage bound is what is tested
    const statuses: number[] = [];
    for (let i = 0; i < 200; i++) statuses.push((await signed(pr('x', i + 1))).status);
    assert.equal(statuses.filter((s) => s === 200).length, RECEIVER_LIMITS.perTokenMinute);
    assert.equal(statuses.filter((s) => s === 429).length, 140);
    for (let m = 0; m < 3; m++) {
      h.clock.advance(60_000);
      for (let i = 0; i < 60; i++) await signed(pr('x', 1000 + m * 100 + i));
    }
    await new Promise((r) => setImmediate(r));
    assert.equal(runs().length, 120, 'at most 120 stored skips an hour');
  });

  it('R15: a frozen database answers 503 and starts nothing', async () => {
    const { h, signed, runs } = await setup();
    h.db.freeze('frozen-by-admin', 'test');
    assert.equal((await signed(pr())).status, 503);
    assert.equal(runs().length, 0);
  });

  it('R18: after Rotate URL the old path is 404 at once; after Rotate secret the old signature is 401 at once', async () => {
    const { h, c, post, signed } = await setup();
    const rotated = (await h.api('POST', `/api/triggers/${c.trigger.id}/url`)).json.data as Trigger;
    assert.notEqual(rotated.webhook!.path, c.trigger.webhook!.path);
    assert.equal((await signed(pr())).status, 404);
    const body = pr();
    assert.equal((await post(body, { 'x-hub-signature-256': sign(c.secret!, body) }, rotated.webhook!.path)).status, 200);
    const { secret } = (await h.api('POST', `/api/triggers/${c.trigger.id}/secret`)).json.data as { secret: string };
    assert.equal((await post(body, { 'x-hub-signature-256': sign(c.secret!, body) }, rotated.webhook!.path)).status, 401);
    assert.equal((await post(body, { 'x-hub-signature-256': sign(secret, body), 'x-test-addr': '10.0.0.9' }, rotated.webhook!.path)).status, 200);
  });

  it('R22: a GitLab trigger with the signing token answers 401 until the token is set; a bad token is refused and never echoed', async () => {
    const { h, c, post } = await setup(inputs.webhook('gitlab'));
    const body = JSON.stringify({ object_kind: 'push', ref: 'refs/heads/main', after: SHA, checkout_sha: SHA, user_username: 'jsmith', project: { path_with_namespace: 'grp/proj' }, commits: [] });
    const ts = String(Math.floor(h.clock.ms / 1000));
    const token = 'whsec_' + Buffer.alloc(24, 7).toString('base64');
    const key = Buffer.alloc(24, 7);
    const headers = (id: string) => ({ 'x-gitlab-event': 'Push Hook', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}` });
    assert.equal((await post(body, headers('msg_1'))).status, 401);
    const bad = await h.api('PUT', `/api/triggers/${c.trigger.id}/secret`, { secret: 'whsec_c2hvcnQ=' });
    assert.equal(bad.status, 422);
    assert.ok(!bad.text.includes('c2hvcnQ'));
    const ok = await h.api('PUT', `/api/triggers/${c.trigger.id}/secret`, { secret: token });
    assert.equal(ok.status, 200);
    assert.equal((ok.json.data as Trigger).webhook!.secretSet, true);
    assert.ok(!ok.text.includes(token.slice(6)));
    assert.equal((await post(body, { ...headers('msg_2'), 'x-test-addr': '10.0.0.3' })).status, 200);
    // R5: the same delivery signed 6 minutes ago is refused.
    const old = String(Math.floor(h.clock.ms / 1000) - 360);
    const oldHeaders = { ...headers('msg_3'), 'webhook-timestamp': old, 'webhook-signature': `v1,${createHmac('sha256', key).update(`msg_3.${old}.${body}`).digest('base64')}`, 'x-test-addr': '10.0.0.3' };
    assert.equal((await post(body, oldHeaders)).status, 401);
  });

  it('R16: the secret, the token and the payload text are in no response, audit row, notification or log', async () => {
    const { h, c, signed } = await setup();
    const logs: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = (...a: unknown[]) => void logs.push(a.join(' '));
    try {
      await signed(pr('CANARY-PAYLOAD'));
      await signed(pr('CANARY-PAYLOAD'), { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) });
    } finally {
      Object.assign(console, orig);
    }
    const all = JSON.stringify([h.audit.list({}, null), h.events, logs, (await h.api('GET', '/api/triggers')).text]);
    assert.ok(!all.includes('CANARY-PAYLOAD'));
    assert.ok(!all.includes(c.secret!));
    assert.ok(!all.includes(c.trigger.webhook!.path.slice('/hooks/'.length)) || (await h.api('GET', '/api/triggers')).text.includes(c.trigger.webhook!.path), 'the path is shown only on the owner’s own view');
    assert.ok(!JSON.stringify([h.audit.list({}, null), h.events, logs]).includes(c.trigger.webhook!.path.slice('/hooks/'.length)));
  });
});
