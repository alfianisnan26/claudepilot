// T-486 S2 (local-git-ci PRD FR8a): a failing upstream sync is a Needs you item (redacted, cleared by the next good sync); the upstream
// webhook `POST /hooks/ci/:id` only kicks the detached sync, behind the Git host's signature and the seam, with the same 404 for every
// refusal, a failure block and coalesced kicks; the portal-wide upstream host allow-list setting, with the SSRF guard still in force.
// Real temporary git repositories as in upstream.test.ts; every key and value is made at run time.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CI_UPSTREAM_HOSTS_SETTING, type Actor } from '@portal/contracts';
import { createApp } from '../app.js';
import { singleOwner, useAuthz } from '../authz/seam.js';
import { Portal } from '../portal.js';
import { settingDef } from '../settings/registry.js';
import { CI_HOOK_POLICIES, registerCiAuthz } from './authz.js';
import { UPSTREAM_HOOK_GAP_MS } from './service.js';
import { upstreamHostsFrom } from './settings.js';
import { harness, remote, sleep, codeOf, WS, type H } from './testkit.js';
import type { Home } from './runner/testkit.js';
import { hostList, withoutUserinfo } from './upstream.js';
import { syncReason, upstreamAttentionSource } from './upstreamAttention.js';
import { CI_HOOK_LIMITS, burnHmac, createCiHookRoutes } from './upstreamHook.js';

const URL_ = 'https://upstream.test/x.git';
const PUBLIC = '93.184.216.34';
const publicLookup = async () => [PUBLIC];
const owner: Actor = { kind: 'user', userId: 'u_owner', loginSessionId: 'l1', via: 'ui' };
const BY = { actor: 'user:u_owner', userId: 'u_owner' };
const rnd = (n = 12) => randomBytes(n).toString('hex');

/** A bare upstream cloned from `from`, its https URL rewritten to it in the pilot remote's git configuration; a clone to push from. */
function upstream(home: Home, from: string) {
  const bare = join(home.home, 'up', 'x.git');
  mkdirSync(join(home.home, 'up'), { recursive: true });
  home.git(['clone', '--bare', '--quiet', from, bare]);
  appendFileSync(join(home.home, '.claudepilot', 'git', 'app.git', 'config'), `[url "${bare}"]\n\tinsteadOf = ${URL_}\n[protocol "file"]\n\tallow = always\n`);
  const work = join(home.home, 'upwork');
  home.git(['clone', '--quiet', bare, work], home.home);
  return { bare, work };
}

const syncCalls = (h: H) => h.host.calls.filter((c) => c[0] === 'repo' && c[1] === 'sync').length;
const items = (h: H) => upstreamAttentionSource(() => h.store.db).list(owner, Date.now(), 'decide');

test('a failing sync is one Needs you item: the remote, a short redacted reason, the branch; it goes when a sync works again', async () => {
  // A credential the workspace delivers (the redactor knows it) and a user:password in a URL that nothing knows: neither may show.
  const value = `fixture-${rnd(18)}`;
  const user = `u${rnd(4)}`;
  const pass = `p${rnd(8)}`;
  const h = await harness({ lookup: publicLookup, redactFor: () => (t) => t.split(value).join('[secret]') });
  try {
    registerCiAuthz(h.svc, () => 'u_owner');
    const repo = await remote(h);
    upstream(h.home, h.src);
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_ } }, BY);
    let failure: 'reply' | 'throw' | null = 'reply';
    const cp = h.host.cp.bind(h.host);
    h.host.cp = async (id, args, opts) => {
      if (args[0] === 'repo' && args[1] === 'sync' && failure === 'reply')
        return { ok: false, error: 'fetch_failed', message: `fatal: unable to access 'https://${user}:${pass}@upstream.test/x.git/':\n  token ${value} refused` };
      if (args[0] === 'repo' && args[1] === 'sync' && failure === 'throw') throw new Error(`the sync timed out after 120 s (https://${user}@upstream.test)`);
      return cp(id, args, opts);
    };

    assert.equal(await codeOf(() => h.svc.syncUpstream(repo.id, BY)), 'SERVICE_UNAVAILABLE');
    const first = items(h);
    assert.equal(first.length, 1, JSON.stringify(first));
    const it = first[0]!;
    assert.deepEqual([it.kind, it.id, it.why, it.action.path], ['ci_upstream', `${repo.id}:sync`, 'question', `/api/ci/repos/${repo.id}/sync`]);
    assert.match(it.title, /^app: upstream sync failed$/);
    assert.match(it.risk, /unable to access/);
    assert.match(it.risk, /main/, 'the branch it holds back');
    assert.match(it.risk, /upstream\.test/, 'the host');
    const view = JSON.stringify((await h.svc.repo(repo.id)).upstream);
    for (const s of [user, pass, value]) {
      assert.ok(!JSON.stringify(first).includes(s), `no ${s === value ? 'secret value' : 'URL credential'} in the item`);
      assert.ok(!view.includes(s), 'nor in the error the remote keeps and the API shows');
    }
    assert.ok(it.risk.length < 260, 'short');
    const since = it.since;

    // A second failure, another reason (a timeout): still one item, still from the first failure.
    failure = 'throw';
    await sleep(5);
    assert.equal(await codeOf(() => h.svc.syncUpstream(repo.id, BY)), 'SERVICE_UNAVAILABLE');
    const second = items(h);
    assert.equal(second.length, 1);
    assert.match(second[0]!.risk, /timed out/);
    assert.equal(second[0]!.since, since, 'the item keeps the time of the first failure');
    assert.ok(!JSON.stringify(second).includes(user));
    // A token never decides.
    assert.deepEqual(upstreamAttentionSource(() => h.store.db).list({ kind: 'token', userId: 'u_owner', tokenId: 't', scope: 'admin' }, Date.now(), 'decide'), []);

    // The next sync works: the item is gone, the remote's error too.
    failure = null;
    await h.svc.syncUpstream(repo.id, BY);
    assert.deepEqual(items(h), []);
    assert.equal((await h.svc.repo(repo.id)).upstream?.error, null);
  } finally {
    h.done();
  }
});

test('syncReason: one line, no user or password of any URL, clipped', () => {
  const pw = rnd(8);
  const r = syncReason(`fatal:\n could not read https://bob:${pw}@git.example.com/a.git and ssh://${pw}@h/x ${'x'.repeat(400)}`);
  assert.ok(!r.includes(pw) && !r.includes('bob'), r);
  assert.ok(!r.includes('\n'));
  assert.ok(r.length <= 121, String(r.length));
  assert.match(r, /https:\/\/git\.example\.com\/a\.git/);
});

/** A remote following the upstream with the hook secret HOOK_KEY set; the key is made here, and given to the service by name. */
const GAP = 300;
async function hooked() {
  const key = `k-${rnd(16)}`;
  const h = await harness({
    lookup: publicLookup,
    hookGapMs: GAP,
    secrets: (_ws, name) => (name === 'HOOK_KEY' ? { kind: 'secret', asFile: true, asVariable: false } : name === 'PLAIN' ? { kind: 'variable', asFile: false, asVariable: true } : null),
    secretValue: (ws, name) => (ws === WS && name === 'HOOK_KEY' ? key : null),
  });
  registerCiAuthz(h.svc, () => 'u_owner');
  const repo = await remote(h);
  upstream(h.home, h.src);
  return { h, repo, key };
}

const sign = (key: string, body: string) => createHmac('sha256', key).update(body).digest('hex');

test('the hook secret is a person’s setting, a SECRET by name; a plain variable or a missing name is refused', async () => {
  const { h, repo } = await hooked();
  try {
    assert.equal(await codeOf(() => h.svc.updateRepo(repo.id, { upstream: { url: URL_, hookSecret: 'PLAIN' } }, BY)), 'VALIDATION_FAILED');
    assert.equal(await codeOf(() => h.svc.updateRepo(repo.id, { upstream: { url: URL_, hookSecret: 'NOT_ASSIGNED' } }, BY)), 'VALIDATION_FAILED');
    assert.equal(await codeOf(() => h.svc.updateRepo(repo.id, { upstream: { url: URL_, hookSecret: '../x' } }, BY)), 'VALIDATION_FAILED');
    const set = await h.svc.updateRepo(repo.id, { upstream: { url: URL_, hookSecret: 'HOOK_KEY' } }, BY);
    assert.equal(set.upstream?.hookSecret, 'HOOK_KEY');
    // Removing the upstream clears it.
    await h.svc.updateRepo(repo.id, { upstream: null }, BY);
    assert.equal(h.svc.upstreamHookKey(repo.id), null);
  } finally {
    h.done();
  }
});

test('the webhook: signed by GitHub or Gitea it kicks the detached sync (202, nothing fetched inline); every refusal is the same 404', async () => {
  const { h, repo, key } = await hooked();
  try {
    let addr = '198.51.100.7';
    const app = createCiHookRoutes(h.svc, { clientAddress: () => addr });
    const body = JSON.stringify({ ref: 'refs/heads/main', after: rnd(20) });
    const post = (id: string, headers: Record<string, string>, b = body) => app.request(`/${encodeURIComponent(id)}`, { method: 'POST', body: b, headers: { 'content-type': 'application/json', ...headers } });
    const github = { 'x-hub-signature-256': `sha256=${sign(key, body)}` };

    // No hook secret on the remote yet: a correct signature is still the 404.
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_ } }, BY);
    const none = await post(repo.id, github);
    assert.equal(none.status, 404);
    const notFound = await none.text();
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_, hookSecret: 'HOOK_KEY' } }, BY);

    // The baseline sync, so the remote is not due by its interval (30 s): from here only a kick makes it sync.
    await h.svc.syncUpstream(repo.id, BY);
    await h.svc.poll(WS);
    await h.svc.syncsSettled();
    const before = syncCalls(h);

    const refusals: [string, Response][] = [
      ['unsigned', await post(repo.id, {})],
      ['signed with another key', await post(repo.id, { 'x-hub-signature-256': `sha256=${sign(`other-${rnd(8)}`, body)}` })],
      ['a sha1 signature', await post(repo.id, { 'x-hub-signature': `sha1=${rnd(20)}` })],
      ['signed over another body', await post(repo.id, github, `${body} `)],
      ['an unknown remote', await post(`cr_${rnd(6)}`, github)],
      ['GET', await app.request(`/${repo.id}`)],
    ];
    for (const [what, r] of refusals) {
      assert.equal(r.status, 404, what);
      const text = await r.text();
      assert.equal(text, notFound, `${what}: the same body`);
      assert.ok(!text.includes(key));
    }

    // Five refusals from that address: it is blocked for this remote now (the limits test covers that); the rest come from another.
    assert.equal((await post(repo.id, github)).status, 429);
    addr = '198.51.100.70';
    // The seam refuses (the owner may not operate it): the same 404, and no kick.
    const was = useAuthz({ ...singleOwner, can: (a, v, o) => (o.type === 'ci_repo' && a.kind === 'job' ? { allow: false, reason: 'not_found', level: 'none' } : singleOwner.can(a, v, o)) });
    try {
      const denied = await post(repo.id, github);
      assert.deepEqual([denied.status, await denied.text()], [404, notFound]);
    } finally {
      useAuthz(was);
    }

    // None of the refusals made a sync due.
    await sleep(GAP + 50);
    await h.svc.poll(WS);
    await h.svc.syncsSettled();
    assert.equal(syncCalls(h), before, 'a refused delivery kicks nothing');

    // Signed: 202 at once, and no sync ran during the request.
    const ok = await post(repo.id, github);
    assert.deepEqual([ok.status, await ok.json()], [202, { ok: true }]);
    assert.equal(syncCalls(h), before, 'the route never fetches inline');
    // The kick makes the sync due (one gap after the last start): the poll starts it, detached.
    await sleep(GAP + 50);
    await h.svc.poll(WS);
    await h.svc.syncsSettled();
    assert.equal(syncCalls(h), before + 1, 'the poll ran the kicked sync');

    // Gitea's bare header works too.
    const gitea = await post(repo.id, { 'x-gitea-signature': sign(key, body) });
    assert.equal(gitea.status, 202);
    await sleep(GAP + 50);
    await h.svc.poll(WS);
    await h.svc.syncsSettled();
    assert.equal(syncCalls(h), before + 2);
  } finally {
    h.done();
  }
});

test('the webhook: a removed remote (it keeps its upstream and hook secret) is the same 404 as an unknown one, signed or not, and kicks nothing', async () => {
  const { h, repo, key } = await hooked();
  try {
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_, hookSecret: 'HOOK_KEY' } }, BY);
    const kicked: string[] = [];
    const app = createCiHookRoutes({ upstreamHookKey: (id) => h.svc.upstreamHookKey(id), kickUpstream: (id) => void kicked.push(id) }, { clientAddress: () => '198.51.100.31' });
    const body = JSON.stringify({ after: rnd(10) });
    const signed = { 'x-hub-signature-256': `sha256=${sign(key, body)}` };
    const post = (id: string) => app.request(`/${id}`, { method: 'POST', body, headers: signed });

    assert.equal((await post(repo.id)).status, 202, 'signed, it kicks while the remote exists');
    assert.deepEqual(kicked, [repo.id]);
    await h.svc.deleteRepo(repo.id);
    assert.equal(h.svc.upstreamHookKey(repo.id), null, 'a removed remote has no hook key');
    const unknown = await post(`cr_${rnd(6)}`);
    const removed = await post(repo.id);
    assert.equal(removed.status, 404);
    assert.equal(await removed.text(), await unknown.text(), 'the same body as an unknown remote');
    assert.deepEqual(kicked, [repo.id], 'a removed remote kicks nothing');
  } finally {
    await h.svc.syncsSettled();
    h.done();
  }
});

test('the webhook as mounted in createApp: /hooks/ci/:id answers 202 or the one 404 outside the session guard; GET gives no answer that tells remotes apart', async () => {
  const stub: object = new Proxy(function () {}, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
    apply: () => stub,
    construct: () => stub,
    set: () => true,
  });
  const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
  const { h, repo, key } = await hooked();
  try {
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_, hookSecret: 'HOOK_KEY' } }, BY);
    const app = make(new Portal(rnd(4), 60_000), stub, stub, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub, mcp: stub, skills: stub, ci: h.svc });
    const body = JSON.stringify({ after: rnd(10) });
    const post = (id: string, headers: Record<string, string>) => app.request(`http://localhost:3000/hooks/ci/${id}`, { method: 'POST', body, headers });
    const signed = { 'x-hub-signature-256': `sha256=${sign(key, body)}` };

    // No cookie and no Origin: the signature is the door.
    const ok = await post(repo.id, signed);
    assert.deepEqual([ok.status, await ok.json()], [202, { ok: true }]);
    const unsigned = await post(repo.id, {});
    assert.equal(unsigned.status, 404);
    const notFound = await unsigned.text();
    assert.ok(notFound.includes('NOT_FOUND') && !notFound.includes(key));
    const unknown = await post(`cr_${rnd(6)}`, signed);
    assert.deepEqual([unknown.status, await unknown.text()], [404, notFound]);
    await h.svc.syncsSettled();
    await h.svc.deleteRepo(repo.id);
    const removed = await post(repo.id, signed);
    assert.deepEqual([removed.status, await removed.text()], [404, notFound], 'a removed remote, signed');

    // GET is no route of the hook app; mounted, the parent answers every id the same, a remote that exists included.
    const getKnown = await app.request(`http://localhost:3000/hooks/ci/${repo.id}`);
    const getUnknown = await app.request(`http://localhost:3000/hooks/ci/cr_${rnd(6)}`);
    assert.equal(getKnown.status, 404);
    assert.deepEqual([getUnknown.status, await getUnknown.text()], [404, await getKnown.text()]);
  } finally {
    await h.svc.syncsSettled();
    h.done();
  }
});

test('the webhook: kicks during a sync coalesce into ONE more sync, one gap after its start', async () => {
  const { h, repo, key } = await hooked();
  let release: () => void = () => undefined;
  try {
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_, hookSecret: 'HOOK_KEY' } }, BY);
    const app = createCiHookRoutes(h.svc, { clientAddress: () => '198.51.100.8' });
    const body = '{"zen":"ping"}';
    const kick = () => app.request(`/${repo.id}`, { method: 'POST', body, headers: { 'x-hub-signature-256': `sha256=${sign(key, body)}` } });

    // The baseline sync first, so the remote is not due by its interval (30 s) during the test.
    await h.svc.syncUpstream(repo.id, BY);
    // From here the workspace's sync hangs until released; each start is counted when it begins.
    let starts = 0;
    let stalled = new Promise<void>((r) => (release = r));
    const cp = h.host.cp.bind(h.host);
    h.host.cp = async (id, args, opts) => {
      if (args[0] === 'repo' && args[1] === 'sync') {
        starts++;
        await stalled;
      }
      return cp(id, args, opts);
    };
    assert.equal((await kick()).status, 202);
    await h.until('the kicked sync to start', () => starts === 1, 10_000);
    // Five more pushes announced while it runs: no second sync beside it.
    for (let i = 0; i < 5; i++) assert.equal((await kick()).status, 202);
    for (let i = 0; i < 3; i++) await h.svc.poll(WS);
    assert.equal(starts, 1, 'one sync at a time per remote');
    stalled = Promise.resolve();
    release();
    await h.svc.syncsSettled();

    // Exactly one more, then nothing.
    await h.until('the one coalesced sync', () => starts === 2, 20_000);
    await h.svc.syncsSettled();
    await sleep(GAP * 2);
    for (let i = 0; i < 5; i++) await h.svc.poll(WS);
    await h.svc.syncsSettled();
    assert.equal(starts, 2, 'five kicks during a sync: one more sync, not five');

    // Kicks closer than the gap after a start coalesce too: two kicks at once, one sync.
    assert.equal((await kick()).status, 202);
    assert.equal((await kick()).status, 202);
    await h.until('the next kicked sync', () => starts === 3, 20_000);
    await h.svc.syncsSettled();
    await sleep(GAP * 2);
    for (let i = 0; i < 5; i++) await h.svc.poll(WS);
    await h.svc.syncsSettled();
    assert.equal(starts, 3);
    assert.ok(UPSTREAM_HOOK_GAP_MS >= 1000, 'the default gap is real');
  } finally {
    release();
    await h.svc.syncsSettled();
    h.done();
  }
});

test('the webhook: 5 bad signatures from one address block that address for that remote (429); a hook\'s own rate is capped', async () => {
  const { h, repo, key } = await hooked();
  try {
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_, hookSecret: 'HOOK_KEY' } }, BY);
    let addr = '203.0.113.9';
    let clock = Date.now();
    const app = createCiHookRoutes(h.svc, { clientAddress: () => addr, now: () => clock });
    const body = '{}';
    const good = { 'x-hub-signature-256': `sha256=${sign(key, body)}` };
    const post = (headers: Record<string, string>) => app.request(`/${repo.id}`, { method: 'POST', body, headers });

    for (let i = 0; i < CI_HOOK_LIMITS.failures; i++) assert.equal((await post({ 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` })).status, 404);
    const blocked = await post(good);
    assert.equal(blocked.status, 429, 'blocked even with a good signature');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    // Another address (the real host) is not locked out by a stranger.
    addr = '203.0.113.10';
    assert.equal((await post(good)).status, 202);
    // The block ends.
    addr = '203.0.113.9';
    clock += CI_HOOK_LIMITS.blockMs + 1;
    assert.equal((await post(good)).status, 202);

    // The hook's own cap: past it, 429 for that hook until the minute turns.
    clock += 60_000;
    const statuses: number[] = [];
    for (let i = 0; i <= CI_HOOK_LIMITS.hookMinute; i++) {
      addr = `198.18.${Math.floor(i / 250)}.${i % 250}`;
      statuses.push((await post(good)).status);
    }
    assert.equal(statuses.filter((s) => s === 202).length, CI_HOOK_LIMITS.hookMinute);
    assert.equal(statuses.at(-1), 429);
    clock += 60_000;
    assert.equal((await post(good)).status, 202);
  } finally {
    await h.svc.syncsSettled();
    h.done();
  }
});

test('the webhook: junk from one address fills its own bucket and a signed hook (another address) still gets 202', async () => {
  const { h, repo, key } = await hooked();
  try {
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_, hookSecret: 'HOOK_KEY' } }, BY);
    let addr = '203.0.113.50';
    const clock = Date.now();
    const app = createCiHookRoutes(h.svc, { clientAddress: () => addr, now: () => clock });
    const body = '{}';
    const good = { 'x-hub-signature-256': `sha256=${sign(key, body)}` };
    const bad = { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` };
    const post = (id: string, headers: Record<string, string>) => app.request(`/${id}`, { method: 'POST', body, headers });
    // Junk at many ids (so the per-pair block never trips) until the address bucket answers 429.
    const junk: number[] = [];
    for (let i = 0; i < CI_HOOK_LIMITS.addressMinute + 20; i++) junk.push((await post(`junk${i}`, bad)).status);
    assert.equal(junk.filter((s) => s === 404).length, CI_HOOK_LIMITS.addressMinute);
    assert.equal(junk.at(-1), 429, 'the junk address is throttled');
    // More junk than the old shared 120/min would hold: the hook is not starved.
    for (let i = 0; i < CI_HOOK_LIMITS.hookMinute + 50; i++) await post(`junk${i}`, bad);
    addr = '192.0.2.77';
    assert.equal((await post(repo.id, good)).status, 202, 'a signed hook from another address still gets 2xx');
  } finally {
    await h.svc.syncsSettled();
    h.done();
  }
});

test('the upstream host allow-list: a portal setting, empty by default; it narrows, and the SSRF guard still refuses a private address', async () => {
  const def = settingDef(CI_UPSTREAM_HOSTS_SETTING);
  assert.deepEqual([def?.type, def?.default, def?.scope], ['string', '', 'global']);
  assert.deepEqual(hostList(' GitHub.com, gitea.example.com\ngithub.com '), ['github.com', 'gitea.example.com']);
  assert.equal(hostList(''), undefined);
  assert.equal(hostList(undefined), undefined);
  assert.deepEqual(upstreamHostsFrom({ get: () => 'github.com' })(), ['github.com']);

  let hosts = '';
  let addresses = [PUBLIC];
  const h = await harness({ lookup: async () => addresses, upstreamHosts: upstreamHostsFrom({ get: (k) => (k === CI_UPSTREAM_HOSTS_SETTING ? hosts : undefined) }) });
  try {
    registerCiAuthz(h.svc, () => 'u_owner');
    const repo = await remote(h);
    upstream(h.home, h.src);
    // Unset: any public host.
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_ } }, BY);
    // Set to other hosts: refused on set, and the next sync never reaches the workspace (read at each use).
    hosts = 'github.com, gitea.example.com';
    assert.equal(await codeOf(() => h.svc.updateRepo(repo.id, { upstream: { url: URL_, everyS: 60 } }, BY)), 'VALIDATION_FAILED');
    const calls = syncCalls(h);
    assert.equal(await codeOf(() => h.svc.syncUpstream(repo.id, BY)), 'SERVICE_UNAVAILABLE');
    assert.equal(syncCalls(h), calls, 'no fetch for a host off the list');
    assert.match((await h.svc.repo(repo.id)).upstream?.error ?? '', /./);
    // On the list but resolving to a private address: the SSRF guard still refuses.
    hosts = 'upstream.test';
    addresses = ['10.0.0.9'];
    assert.equal(await codeOf(() => h.svc.syncUpstream(repo.id, BY)), 'SERVICE_UNAVAILABLE');
    assert.equal(syncCalls(h), calls);
    // On the list and public: it syncs.
    addresses = [PUBLIC];
    await h.svc.syncUpstream(repo.id, BY);
    assert.equal(syncCalls(h), calls + 1);
  } finally {
    h.done();
  }
});

test('every hook route is declared in CI_HOOK_POLICIES, and every declaration names a real route (a route added without a policy fails)', () => {
  const routes = createCiHookRoutes({ upstreamHookKey: () => null, kickUpstream: () => undefined });
  const listed = new Set(routes.routes.map((r) => `${r.method} /hooks/ci${r.path}`));
  const declared = new Set(Object.keys(CI_HOOK_POLICIES));
  assert.deepEqual([...listed].filter((k) => !declared.has(k)), [], 'undeclared routes');
  assert.deepEqual([...declared].filter((k) => !listed.has(k)), [], 'declarations without a route');
});

test('the webhook: an unknown id, a malformed id and a remote with no hook key still run an HMAC check (timing cover); a real key does not need it', async () => {
  const body = JSON.stringify({ n: rnd(8) });
  const seen: number[] = [];
  const key = `k-${rnd(16)}`;
  const kicked: string[] = [];
  const app = createCiHookRoutes(
    { upstreamHookKey: (id: string) => (id === 'known' ? { key } : null), kickUpstream: (id: string) => void kicked.push(id) } as never,
    { clientAddress: () => '198.51.100.9', dummyCheck: (raw) => void seen.push(raw.length) },
  );
  const post = (id: string, headers: Record<string, string> = {}) => app.request(`/${id}`, { method: 'POST', body, headers });
  assert.equal((await post(`cr_${rnd(6)}`)).status, 404);
  assert.equal((await post('bad.id')).status, 404);
  assert.deepEqual(seen, [body.length, body.length]);
  await post('known', { 'x-hub-signature-256': `sha256=${sign(key, body)}` }); // a real key: checked for real, the dummy is not called (the seam has no owner here)
  assert.equal(seen.length, 2);
  assert.deepEqual(kicked, []);
  burnHmac(Buffer.from(body)); // the default does not throw
});

test('withoutUserinfo: the authority’s userinfo goes, whatever the password holds; an @ after the host stays', () => {
  // D-65: a fixed password that starts with a letter. A random one could be all digits, and `bob:<digits>/` reads as a port (the lookahead
  // in withoutUserinfo), which made this test flake. Built at run time; nothing token-shaped.
  const pw = ['not', 'a', 'port'].join('-');
  const cases: [string, string][] = [
    [`https://bob:${pw}@host.test/a.git`, 'https://host.test/a.git'],
    [`ssh://${pw}@host.test/x`, 'ssh://host.test/x'],
    [`fatal: https://bob:${pw}/${pw}@host.test/a.git failed`, 'fatal: https://host.test/a.git failed'],
    [`fatal: https://bob:${pw} ${pw}@host.test/a.git failed`, 'fatal: https://host.test/a.git failed'],
    ['https://host.test/path/a@b.git', 'https://host.test/path/a@b.git'],
    ['https://host.test:8080/path/a@b.git', 'https://host.test:8080/path/a@b.git'],
    ['https://host.test/x then mail me@host.test', 'https://host.test/x then mail me@host.test'],
  ];
  for (const [input, want] of cases) {
    const got = withoutUserinfo(input);
    assert.equal(got, want, input);
    assert.ok(!got.includes(pw), input);
  }
});
