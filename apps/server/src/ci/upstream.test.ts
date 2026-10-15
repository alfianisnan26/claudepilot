// Upstream sync (local-git-ci PRD FR8a, T-486), on real temporary git repositories: the upstream is a bare repository here, reached by an
// https URL that the test home's git configuration rewrites to it (`url.<path>.insteadOf`), so nothing leaves the machine. Covers the
// fast-forward, divergence (no overwrite, a Needs you item), a new branch, a branch gone upstream (kept, reported), the triggers (once per
// moved branch on its new sha), the credential (never in argv, a reply or the audit) and the SSRF guard.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import type { Actor } from '@portal/contracts';
import { Home } from './runner/testkit.js';
import { scrub } from './runner/upstream.js';
import { harness, remote, sleep, WS, codeOf } from './testkit.js';
import { checkUpstream, nextState, upstreamPin, EMPTY_STATE } from './upstream.js';
import { upstreamAttentionSource } from './upstreamAttention.js';
import { registerCiAuthz } from './authz.js';

const URL_ = 'https://upstream.test/x.git';
const PUBLIC = '93.184.216.34';
const publicLookup = async () => [PUBLIC];
const owner: Actor = { kind: 'user', userId: 'u_owner', loginSessionId: 'l1', via: 'ui' };
const BY = { actor: 'user:u_owner', userId: 'u_owner' };

/**
 * A bare upstream cloned from `from`, its https URL rewritten to it in the pilot remote's own git configuration, and a working clone to
 * push from. The home's global configuration rewrites the same URL to a decoy that does not exist: the sync must not read it (T-486,
 * the pin holds only when no `insteadOf` from outside the remote applies), so a sync that did would fail to fetch.
 */
function upstream(home: Home, from: string) {
  const bare = join(home.home, 'up', 'x.git');
  mkdirSync(join(home.home, 'up'), { recursive: true });
  home.git(['clone', '--bare', '--quiet', from, bare]);
  appendFileSync(join(pilotDir(home), 'config'), `[url "${bare}"]\n\tinsteadOf = ${URL_}\n[protocol "file"]\n\tallow = always\n`);
  appendFileSync(join(home.home, '.gitconfig'), `[url "${join(home.home, 'decoy-not-here.git')}"]\n\tinsteadOf = ${URL_}\n`);
  const work = join(home.home, 'upwork');
  home.git(['clone', '--quiet', bare, work], home.home);
  return { bare, work };
}

const rev = (home: Home, gitDir: string, ref: string) => home.git([`--git-dir=${gitDir}`, 'rev-parse', '--verify', '--quiet', ref], home.home);
const pilotDir = (home: Home, name = 'app') => join(home.home, '.claudepilot', 'git', `${name}.git`);
const events = (home: Home) => {
  const dir = join(home.home, '.claudepilot', 'ci', 'events');
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as { ref: string; old: string; new: string; via: string; by: string }) : [];
};

test('the runner: fast-forward, a new branch, divergence left alone, a branch gone upstream kept', async () => {
  const home = new Home();
  const src = home.repo('src');
  const base = home.git(['rev-parse', 'HEAD'], src);
  assert.equal((await home.ci(['repo', 'create', 'app', '--from', src])).ok, true);
  const up = upstream(home, src);

  // Upstream moves main forward and opens a branch.
  const c1 = home.commit(up.work, { 'a.txt': 'a\n' }, 'upstream one');
  home.git(['checkout', '--quiet', '-b', 'feat'], up.work);
  const f1 = home.commit(up.work, { 'f.txt': 'f\n' }, 'feature');
  home.git(['push', '--quiet', 'origin', 'main', 'feat'], up.work);

  const r1 = await home.ci(['repo', 'sync', 'app', '--url', URL_, '--pin', PUBLIC]);
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.deepEqual(r1.moved, [
    { branch: 'feat', old: '0'.repeat(40), new: f1 },
    { branch: 'main', old: base, new: c1 },
  ]);
  assert.deepEqual([r1.created, r1.diverged, r1.deleted], [['feat'], [], []]);
  assert.equal(rev(home, pilotDir(home), 'refs/heads/main'), c1, 'main fast-forwarded');
  assert.equal(rev(home, pilotDir(home), 'refs/heads/feat'), f1, 'feat created');
  assert.equal(rev(home, pilotDir(home), 'refs/upstream/heads/main'), c1, 'staged under refs/upstream');
  // The first sync is the baseline: the branches upstream already had start no pipeline.
  assert.deepEqual([r1.baseline, r1.events], [true, 0]);
  assert.deepEqual(events(home), [], 'no event for the baseline');

  // A later move: the same event a push writes, once per moved branch, on its new sha.
  const c2 = home.commit(up.work, { 'b.txt': 'b\n' }, 'upstream two on feat');
  home.git(['push', '--quiet', 'origin', 'feat'], up.work);
  home.git(['checkout', '--quiet', 'main'], up.work);
  const c3 = home.commit(up.work, { 'c.txt': 'c\n' }, 'upstream three on main');
  home.git(['push', '--quiet', 'origin', 'main'], up.work);
  const r1b = await home.ci(['repo', 'sync', 'app', '--url', URL_]);
  assert.deepEqual([r1b.ok, r1b.baseline, r1b.events], [true, false, 2], JSON.stringify(r1b));
  const ev = events(home).map((e) => [e.ref, e.old, e.new, e.via, e.by]).sort();
  assert.deepEqual(ev, [['refs/heads/feat', f1, c2, 'push', 'upstream'], ['refs/heads/main', c1, c3, 'push', 'upstream']]);

  // Nothing new: nothing moves, no event.
  const r2 = await home.ci(['repo', 'sync', 'app', '--url', URL_]);
  assert.deepEqual([r2.ok, r2.moved, r2.events], [true, [], 0]);

  // Pilot gets a commit of its own on main, upstream another: diverged. Pilot's main is not touched.
  const pw = join(home.home, 'pilotwork');
  home.git(['clone', '--quiet', pilotDir(home), pw], home.home);
  const mine = home.commit(pw, { 'p.txt': 'p\n' }, 'pilot only');
  home.git(['push', '--quiet', 'origin', 'main'], pw);
  home.git(['checkout', '--quiet', 'main'], up.work);
  const theirs = home.commit(up.work, { 'u.txt': 'u\n' }, 'upstream two');
  home.git(['push', '--quiet', 'origin', 'main'], up.work);
  // And upstream deletes feat; pilot gets a branch upstream never had.
  home.git(['push', '--quiet', 'origin', '--delete', 'feat'], up.work);
  home.git(['push', '--quiet', 'origin', 'main:local-only'], pw);

  const before = events(home).length;
  const r3 = await home.ci(['repo', 'sync', 'app', '--url', URL_]);
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.deepEqual(r3.moved, [], 'nothing is forced');
  assert.deepEqual(r3.diverged, [{ branch: 'main', local: mine, upstream: theirs }]);
  assert.equal(rev(home, pilotDir(home), 'refs/heads/main'), mine, 'pilot main kept');
  assert.deepEqual(r3.deleted, ['feat']);
  assert.equal(rev(home, pilotDir(home), 'refs/heads/feat'), c2, 'a branch gone upstream is kept');
  assert.deepEqual(r3.onlyHere, ['feat', 'local-only']);
  // The pushes above wrote their own events (the hook); the sync wrote none.
  assert.equal(events(home).length - before, 0);

  // Pilot ahead of upstream (a commit on top of what upstream has): reported, not touched.
  home.git(['push', '--quiet', 'origin', `${theirs}:refs/heads/side`], up.work);
  assert.equal((await home.ci(['repo', 'sync', 'app', '--url', URL_])).ok, true);
  home.git(['fetch', '--quiet', 'origin'], pw);
  home.git(['checkout', '--quiet', '-b', 'side', 'origin/side'], pw);
  const ahead = home.commit(pw, { 's.txt': 's\n' }, 'pilot ahead');
  home.git(['push', '--quiet', 'origin', 'side'], pw);
  const r4 = await home.ci(['repo', 'sync', 'app', '--url', URL_]);
  assert.deepEqual([r4.ok, r4.moved, r4.ahead], [true, [], ['side']]);
  assert.equal(rev(home, pilotDir(home), 'refs/heads/side'), ahead);
});

test('the runner: the credential reaches only the fetch, in its environment; never argv, the URL or the reply', async () => {
  const home = new Home();
  const src = home.repo('src');
  assert.equal((await home.ci(['repo', 'create', 'app', '--from', src])).ok, true);
  const up = upstream(home, src);
  home.commit(up.work, { 'a.txt': 'a\n' }, 'one');
  home.git(['push', '--quiet', 'origin', 'main'], up.work);

  // The fixture value is made at run time (no literal shaped like a key anywhere).
  const value = `fixture-${randomBytes(18).toString('hex')}`;
  mkdirSync(join(home.home, 'secrets', 'files'), { recursive: true });
  writeFileSync(join(home.home, 'secrets', 'files', 'UPSTREAM_READ'), `${value}\n`, { mode: 0o600 });
  const header = `Authorization: Basic ${Buffer.from(`x-access-token:${value}`).toString('base64')}`;

  // A git in front of the real one records every argv, and whether the fetch's environment carried the header (yes/no, never the value).
  const realGit = (process.env.PATH ?? '').split(delimiter).map((d) => join(d, 'git')).find((p) => existsSync(p))!;
  const bin = join(home.home, 'fakebin');
  mkdirSync(bin);
  const log = join(home.home, 'argv.log');
  // It also records whether the global and system git configuration were off and every proxy variable empty (ENV-CLEAN), for each
  // call that set them (only the fetch should).
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CPTEST_LOG"\nif [ -n "$GIT_CONFIG_VALUE_0" ]; then if [ "$GIT_CONFIG_VALUE_0" = "$CPTEST_EXPECT" ] && [ "$GIT_CONFIG_KEY_0" = "http.https://upstream.test/.extraHeader" ]; then echo HEADER-OK >> "$CPTEST_LOG"; else echo HEADER-WRONG >> "$CPTEST_LOG"; fi; fi\n` +
      `if [ "$GIT_CONFIG_GLOBAL" = /dev/null ] && [ "$GIT_CONFIG_NOSYSTEM" = 1 ] && [ -z "$HTTPS_PROXY$https_proxy$HTTP_PROXY$http_proxy$ALL_PROXY$all_proxy" ]; then echo ENV-CLEAN >> "$CPTEST_LOG"; fi\n` +
      `exec '${realGit}' "$@"\n`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  // The workspace has a proxy in its environment (a dead one) and a proxy in its global git configuration: the fetch must use neither.
  const deadProxy = 'http://127.0.0.1:9';
  appendFileSync(join(home.home, '.gitconfig'), `[http]\n\tproxy = ${deadProxy}\n`);
  home.extraEnv = { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, CPTEST_LOG: log, CPTEST_EXPECT: header, HTTPS_PROXY: deadProxy, https_proxy: deadProxy, ALL_PROXY: deadProxy, http_proxy: deadProxy };

  const r = await home.ci(['repo', 'sync', 'app', '--url', URL_, '--secret', 'UPSTREAM_READ']);
  assert.equal(r.ok, true, JSON.stringify(r));
  const argv = readFileSync(log, 'utf8');
  assert.match(argv, / fetch /, 'the fetch ran through the recorder');
  const lines = argv.split('\n');
  const fetchAt = lines.findIndex((l) => / fetch /.test(l));
  assert.equal(lines[fetchAt + 1], 'HEADER-OK', 'the fetch carried the header, scoped to the upstream origin');
  assert.equal(lines[fetchAt + 2], 'ENV-CLEAN', 'the fetch ran with no proxy variable and no global or system git configuration');
  assert.match(lines[fetchAt]!, /(^| )-c http\.proxy= /, 'git\'s own proxy is off for the fetch');
  for (const [i, l] of lines.entries()) if (/ (for-each-ref|update-ref|merge-base) /.test(l)) assert.notEqual(lines[i + 1], 'HEADER-OK', `no header for: ${l}`);
  assert.ok(!argv.includes('HEADER-WRONG'));
  const b64 = Buffer.from(`x-access-token:${value}`).toString('base64');
  for (const text of [argv, JSON.stringify(r)]) {
    assert.ok(!text.includes(value), 'no value in argv or the reply');
    assert.ok(!text.includes(b64), 'no header in argv or the reply');
  }

  // A secret that is not there: refused by name, nothing fetched.
  const missing = await home.ci(['repo', 'sync', 'app', '--url', URL_, '--secret', 'NOPE']);
  assert.deepEqual([missing.ok, missing.error], [false, 'no_secret']);
  // A name that walks out of the folder, a URL with a user in it, plain http: refused before git runs.
  for (const args of [['--secret', '../x'], ['--url', 'https://u:p@upstream.test/x.git'], ['--url', 'http://upstream.test/x.git'], ['--url', 'https://upstream.test/x.git?a=1']]) {
    const bad = await home.ci(['repo', 'sync', 'app', '--url', URL_, ...args]);
    assert.equal(bad.ok, false, args.join(' '));
  }
});

test('scrub takes the value, its header and any Authorization line out of what git said', () => {
  const v = `fixture-${randomBytes(12).toString('hex')}`;
  const b = Buffer.from(`x-access-token:${v}`).toString('base64');
  const out = scrub(`fatal: unable to access: ${v}\n> Authorization: Basic ${b}\nremote: ${b}`, [v, b]);
  assert.ok(!out.includes(v) && !out.includes(b), out);
});

test('the setting: https only, no user or query, a secret name, 15 to 3600 s; the state keeps when a divergence was first seen', () => {
  assert.deepEqual(checkUpstream({ url: URL_ }), { url: URL_, secret: null, everyS: 30, hookSecret: null });
  assert.deepEqual(checkUpstream({ url: URL_, secret: 'GH_READ', everyS: 60 }), { url: URL_, secret: 'GH_READ', everyS: 60, hookSecret: null });
  for (const bad of [{ url: 'http://upstream.test/x.git' }, { url: 'https://u:p@upstream.test/x.git' }, { url: 'https://upstream.test/x.git#f' }, { url: 'ssh://upstream.test/x.git' }, { url: URL_, secret: '../etc' }, { url: URL_, everyS: 5 }, { url: URL_, everyS: 99999 }, {}]) {
    assert.throws(() => checkUpstream(bad), /./, JSON.stringify(bad));
  }
  const s1 = nextState(EMPTY_STATE, { moved: [], diverged: [{ branch: 'main', local: 'a'.repeat(40), upstream: 'b'.repeat(40) }], ahead: [], deleted: ['old'], onlyHere: ['old'] }, '2026-01-01T00:00:00.000Z');
  const s2 = nextState(s1, { moved: [], diverged: [{ branch: 'main', local: 'a'.repeat(40), upstream: 'b'.repeat(40) }], ahead: [], deleted: [], onlyHere: ['old'] }, '2026-01-01T00:01:00.000Z');
  assert.equal(s2.diverged[0]!.since, '2026-01-01T00:00:00.000Z', 'the same divergence keeps its time');
  assert.deepEqual(s2.gone, ['old'], 'a branch gone upstream stays reported while it is still here');
  assert.deepEqual(nextState(s2, { moved: [], diverged: [], ahead: [], deleted: [], onlyHere: [] }, '2026-01-01T00:02:00.000Z').gone, [], 'deleted here too: no longer reported');
});

test('the SSRF guard: a private, link-local or unresolvable host is refused; the allow-list is kept; the pin is the checked address', async () => {
  const look = (m: Record<string, string[]>) => async (h: string) => m[h] ?? [];
  assert.equal(await upstreamPin(URL_, look({ 'upstream.test': ['2606:4700::1', PUBLIC] })), PUBLIC, 'IPv4 first');
  for (const [url, map] of [
    [URL_, { 'upstream.test': ['10.0.0.5'] }],
    [URL_, { 'upstream.test': [PUBLIC, '127.0.0.1'] }],
    ['https://169.254.169.254/x.git', {}],
    ['https://[::1]/x.git', {}],
    [URL_, {}],
  ] as [string, Record<string, string[]>][]) {
    assert.equal(await codeOf(() => upstreamPin(url, look(map))), 'VALIDATION_FAILED', `${url} ${JSON.stringify(map)}`);
  }
  assert.equal(await codeOf(() => upstreamPin(URL_, publicLookup, ['github.com'])), 'VALIDATION_FAILED', 'not on the allow-list');
  assert.equal(await upstreamPin('https://GitHub.com/o/r.git', publicLookup, ['github.com']), PUBLIC);
});

test('the service: set by a person, synced by the poll; each moved branch starts the push triggers once, on its new sha; audited without a secret', async () => {
  const audits: { kind: string; actor: string; detail?: Record<string, unknown> }[] = [];
  const h = await harness({ lookup: publicLookup, audit: (e) => void audits.push(e), secrets: (_ws, name) => (name === 'GH_READ' ? { kind: 'secret', asFile: true, asVariable: false } : name === 'ENV_ONLY' ? { kind: 'variable', asFile: false, asVariable: true } : null) });
  try {
    const repo = await remote(h);
    const up = upstream(h.home, h.src);
    const value = `fixture-${randomBytes(18).toString('hex')}`;
    mkdirSync(join(h.home.home, 'secrets', 'files'), { recursive: true });
    writeFileSync(join(h.home.home, 'secrets', 'files', 'GH_READ'), value);

    // Only a person sets it; a name that is not a file in the workspace is refused.
    assert.equal(await codeOf(() => h.svc.updateRepo(repo.id, { upstream: { url: URL_ } })), 'FORBIDDEN');
    assert.equal(await codeOf(() => h.svc.updateRepo(repo.id, { upstream: { url: URL_, secret: 'ENV_ONLY' } }, BY)), 'VALIDATION_FAILED');
    assert.equal(await codeOf(() => h.svc.updateRepo(repo.id, { upstream: { url: URL_, secret: 'NOT_ASSIGNED' } }, BY)), 'VALIDATION_FAILED');
    const set = await h.svc.updateRepo(repo.id, { upstream: { url: URL_, secret: 'GH_READ' } }, BY);
    assert.deepEqual([set.upstream?.url, set.upstream?.secret, set.upstream?.everyS], [URL_, 'GH_READ', 30]);
    assert.deepEqual(audits.filter((a) => a.kind === 'ci.upstream_set').map((a) => [a.actor, a.detail?.secret]), [['user:u_owner', 'GH_READ']]);

    // A branch the upstream already has: the first sync (the poll's, detached) creates it as the baseline and starts nothing.
    h.home.git(['checkout', '--quiet', '-b', 'old'], up.work);
    const o1 = h.home.commit(up.work, { 'o.txt': 'o\n' }, 'an old upstream branch');
    h.home.git(['push', '--quiet', 'origin', 'old'], up.work);
    h.home.git(['checkout', '--quiet', 'main'], up.work);
    const runsAtStart = h.created.length;
    await h.svc.poll(WS);
    await h.svc.syncsSettled();
    for (let i = 0; i < 3; i++) await h.svc.poll(WS);
    assert.equal(rev(h.home, pilotDir(h.home), 'refs/heads/old'), o1, 'the baseline created the branch');
    assert.equal(h.created.length, runsAtStart, 'no pipeline for a branch the upstream already had');

    const c1 = h.home.commit(up.work, { 'a.txt': 'a\n' }, 'upstream main');
    h.home.git(['checkout', '--quiet', '-b', 'feat2'], up.work);
    const f1 = h.home.commit(up.work, { 'f.txt': 'f\n' }, 'upstream feature');
    h.home.git(['push', '--quiet', 'origin', 'main', 'feat2'], up.work);

    const runsBefore = h.created.length;
    // The next sync (now, instead of waiting out `everyS`): the moves kick the poll, which starts one run per moved branch.
    assert.equal((await h.svc.syncUpstream(repo.id, BY)).moved.length, 2);
    await h.until('the sync to start two runs', () => h.created.length - runsBefore >= 2);
    // A few more polls and a sync now: nothing moves again, so nothing fires again.
    const again = await h.svc.syncUpstream(repo.id, BY);
    assert.deepEqual(again.moved, []);
    for (let i = 0; i < 3; i++) await h.svc.poll(WS);
    const runs = await Promise.all(h.created.slice(runsBefore).map((id) => h.svc.show(id)));
    assert.deepEqual(runs.map((r) => [r.branch, r.sha, r.trigger]).sort(), [['feat2', f1, 'push'], ['main', c1, 'merge']]);

    const synced = audits.filter((a) => a.kind === 'ci.upstream_synced');
    // The baseline moved one branch (created `old`), the next sync two.
    assert.deepEqual(synced.map((a) => [a.actor, a.detail?.moved]), [['upstream', 1], ['user:u_owner', 2]]);
    const sync = h.host.calls.find((c) => c[0] === 'repo' && c[1] === 'sync')!;
    assert.deepEqual(sync.slice(sync.indexOf('--secret')), ['--secret', 'GH_READ'], 'the name goes to the workspace, never a value');
    assert.ok(sync.includes('--pin') && sync[sync.indexOf('--pin') + 1] === PUBLIC);
    for (const text of [JSON.stringify(audits), JSON.stringify(h.host.calls), JSON.stringify(await h.svc.repo(repo.id))]) assert.ok(!text.includes(value), 'no value anywhere the portal keeps');
  } finally {
    h.done();
  }
});

test('the service: a changed or removed upstream is a baseline again; the same URL set again is not a change (T-486)', async () => {
  const URL_B = 'https://other.test/y.git';
  const h = await harness({ lookup: publicLookup });
  try {
    registerCiAuthz(h.svc, () => 'u_owner');
    const repo = await remote(h);
    const a = upstream(h.home, h.src);
    // A second upstream with other branches, reached the same way.
    const bareB = join(h.home.home, 'up', 'y.git');
    h.home.git(['clone', '--bare', '--quiet', h.src, bareB]);
    appendFileSync(join(pilotDir(h.home), 'config'), `[url "${bareB}"]\n\tinsteadOf = ${URL_B}\n`);
    const workB = join(h.home.home, 'upworkB');
    h.home.git(['clone', '--quiet', bareB, workB], h.home.home);
    const settle = async () => {
      for (let i = 0; i < 3; i++) await h.svc.poll(WS);
    };
    const created = () => h.created.length;

    // A: the baseline, then a moved branch starts a pipeline.
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_ } }, BY);
    await h.svc.syncUpstream(repo.id, BY);
    await settle();
    const start = created();
    h.home.commit(a.work, { 'a1.txt': 'a\n' }, 'A moves main');
    h.home.git(['push', '--quiet', 'origin', 'main'], a.work);
    assert.equal((await h.svc.syncUpstream(repo.id, BY)).moved.length, 1);
    await h.until('the moved branch to start a run', () => created() > start);

    // Switch to B, which has other branches: its first sync is a baseline, no pipeline.
    h.home.git(['checkout', '--quiet', '-b', 'other-b'], workB);
    h.home.commit(workB, { 'b1.txt': 'b\n' }, 'B branch');
    h.home.git(['push', '--quiet', 'origin', 'other-b'], workB);
    const syncs = () => h.host.calls.filter((c) => c[0] === 'repo' && c[1] === 'sync');
    const afterSwitch = created();
    const m0 = syncs().length;
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_B } }, BY);
    await settle();
    await h.svc.syncsSettled();
    await h.svc.syncUpstream(repo.id, BY);
    await settle();
    assert.equal(rev(h.home, pilotDir(h.home), 'refs/heads/other-b') !== '', true, 'the new upstream\'s branch came in');
    assert.equal(syncs().slice(m0).filter((c) => c.includes('--reset')).length, 1, 'only the first sync after the switch clears the old staging');
    assert.equal(created(), afterSwitch, 'a new upstream\'s branches start no pipeline on its first sync');

    // Later syncs of B are normal: a move fires. Setting the same URL again is no change (no reset).
    h.home.commit(workB, { 'b2.txt': 'b\n' }, 'B moves');
    h.home.git(['push', '--quiet', 'origin', 'other-b'], workB);
    const before = created();
    const m1 = syncs().length;
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_B } }, BY);
    await settle();
    await h.svc.syncsSettled();
    await h.svc.syncUpstream(repo.id, BY);
    await h.until('B\'s move to start a run', () => created() > before);
    assert.ok(syncs().length > m1);
    assert.equal(syncs().slice(m1).some((c) => c.includes('--reset')), false, 'the same URL again is not a change');

    // Removed, then set again: a baseline again, even for the same URL.
    await h.svc.updateRepo(repo.id, { upstream: null }, BY);
    h.home.git(['checkout', '--quiet', '-b', 'late'], workB);
    h.home.commit(workB, { 'l.txt': 'l\n' }, 'B late branch');
    h.home.git(['push', '--quiet', 'origin', 'late'], workB);
    const afterSet = created();
    const m2 = syncs().length;
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_B } }, BY);
    await settle();
    await h.svc.syncsSettled();
    await h.svc.syncUpstream(repo.id, BY);
    await settle();
    assert.equal(rev(h.home, pilotDir(h.home), 'refs/heads/late') !== '', true);
    assert.equal(syncs().slice(m2).filter((c) => c.includes('--reset')).length, 1);
    assert.equal(created(), afterSet, 'removed and set again: the first sync is a baseline');
  } finally {
    h.done();
  }
});

test('the runner: --reset clears the staged branches, so the sync is a baseline again (T-486)', async () => {
  const home = new Home();
  const src = home.repo('src');
  assert.equal((await home.ci(['repo', 'create', 'app', '--from', src])).ok, true);
  const up = upstream(home, src);
  home.commit(up.work, { 'a.txt': 'a\n' }, 'one');
  home.git(['push', '--quiet', 'origin', 'main'], up.work);
  assert.equal((await home.ci(['repo', 'sync', 'app', '--url', URL_, '--pin', PUBLIC])).baseline, true);
  home.commit(up.work, { 'b.txt': 'b\n' }, 'two');
  home.git(['push', '--quiet', 'origin', 'main'], up.work);
  const plain = await home.ci(['repo', 'sync', 'app', '--url', URL_]);
  assert.deepEqual([plain.baseline, plain.events], [false, 1]);
  home.commit(up.work, { 'c.txt': 'c\n' }, 'three');
  home.git(['push', '--quiet', 'origin', 'main'], up.work);
  const reset = await home.ci(['repo', 'sync', 'app', '--url', URL_, '--reset']);
  assert.deepEqual([reset.ok, reset.baseline, reset.events], [true, true, 0], JSON.stringify(reset));
});

test('the service: a diverged branch is not overwritten and is one Needs you item; a refused host never reaches the workspace', async () => {
  let addresses = [PUBLIC];
  const h = await harness({ lookup: async () => addresses });
  try {
    registerCiAuthz(h.svc, () => 'u_owner');
    const repo = await remote(h);
    const up = upstream(h.home, h.src);
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_ } }, BY);
    // Pilot's main gets its own commit (a push to the remote), upstream another.
    const conn = h.src;
    const mine = h.home.commit(conn, { 'p.txt': 'p\n' }, 'pilot only');
    h.home.git(['push', '--quiet', 'pilot', 'main'], conn);
    const theirs = h.home.commit(up.work, { 'u.txt': 'u\n' }, 'upstream only');
    h.home.git(['push', '--quiet', 'origin', 'main'], up.work);

    const r = await h.svc.syncUpstream(repo.id, BY);
    assert.deepEqual(r.moved, []);
    assert.equal(rev(h.home, pilotDir(h.home), 'refs/heads/main'), mine, 'not overwritten');
    assert.deepEqual(r.repo.upstream?.diverged.map((d) => [d.branch, d.local, d.upstream]), [['main', mine, theirs]]);

    const items = upstreamAttentionSource(() => h.store.db).list(owner, Date.now(), 'decide');
    assert.equal(items.length, 1);
    assert.deepEqual([items[0]!.kind, items[0]!.id, items[0]!.why, items[0]!.action.path], ['ci_upstream', `${repo.id}/main`, 'question', `/api/ci/repos/${repo.id}/sync`]);
    assert.match(items[0]!.risk, new RegExp(`pilot ${mine.slice(0, 7)} · upstream ${theirs.slice(0, 7)}`));
    assert.deepEqual(upstreamAttentionSource(() => h.store.db).list({ kind: 'token', userId: 'u_owner', tokenId: 't', scope: 'admin' }, Date.now(), 'decide'), [], 'a token never decides');

    // The host now resolves to a private address: refused, kept as the remote's error, and the workspace is never asked to fetch.
    addresses = ['10.1.2.3'];
    const calls = h.host.calls.length;
    assert.equal(await codeOf(() => h.svc.syncUpstream(repo.id, BY)), 'SERVICE_UNAVAILABLE');
    assert.equal(h.host.calls.slice(calls).filter((c) => c[1] === 'sync').length, 0);
    assert.match((await h.svc.repo(repo.id)).upstream?.error ?? '', /private address/);
    // And on set: a private host is refused at once.
    assert.equal(await codeOf(() => h.svc.updateRepo(repo.id, { upstream: { url: 'https://inside.test/x.git' } }, BY)), 'VALIDATION_FAILED');
    // Cleared: it follows nothing, and the item is gone.
    assert.equal((await h.svc.updateRepo(repo.id, { upstream: null }, BY)).upstream, null);
    assert.deepEqual(upstreamAttentionSource(() => h.store.db).list(owner, Date.now(), 'decide'), []);
  } finally {
    h.done();
  }
});

test('the service: a stalled upstream fetch never holds the poll; a queued run still starts in the normal poll', async () => {
  const h = await harness({ lookup: publicLookup });
  let release: () => void = () => undefined;
  try {
    const repo = await remote(h);
    upstream(h.home, h.src);
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_ } }, BY);
    // The workspace's `repo sync` hangs (a stalled GitHub) until the test lets it go; every other call goes through.
    const stalled = new Promise<void>((r) => (release = r));
    const cp = h.host.cp.bind(h.host);
    let syncs = 0;
    h.host.cp = async (id, args, opts) => {
      if (args[0] === 'repo' && args[1] === 'sync') {
        syncs++;
        await stalled;
      }
      return cp(id, args, opts);
    };
    const within = (p: Promise<void>, ms: number) => Promise.race([p.then(() => 'done'), sleep(ms).then(() => 'stalled')]);

    // A push to pilot: an event, a run queued and started, by the polls, while the sync stays stuck.
    h.home.commit(h.src, { 'b.txt': 'b\n' }, 'a push while upstream stalls');
    h.home.git(['push', '--quiet', 'pilot', 'main'], h.src);
    assert.equal(await within(h.svc.poll(WS), 10_000), 'done', 'the poll does not wait for the sync');
    assert.equal(syncs, 1, 'the sync was started');
    const started = () => h.svc.list().items.some((r) => r.branch === 'main' && r.status !== 'queued');
    for (let i = 0; i < 5 && !started(); i++) assert.equal(await within(h.svc.poll(WS), 10_000), 'done');
    assert.ok(started(), 'the queued run started while the upstream fetch stalls');
    assert.equal(syncs, 1, 'one sync at a time per remote: none started beside the stalled one');
  } finally {
    release();
    await h.svc.syncsSettled?.();
    h.done();
  }
});
