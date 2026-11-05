// PILOT-1180: the staging deploy is safe to run again. A fake Cloudflare API (mocked fetch, no network, no wrangler, no git) checks the
// plan and the guards: the account is pinned before any write, an unknown policy on the Access app stops the run, and a plain re-run
// keeps the service token (only --rotate rotates it). Every id and credential is made here at runtime.
// Run: node --test scripts/ (from apps/core-worker).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { APP_NAME, buildEnv, KUBE_IMAGES, POLICY_NAME, run, Stop, TOKEN_NAME, WORKER } from './deploy-stg.mjs';

const hex = (n) => randomBytes(n).toString('hex');
const ZONE = 'example.test';
const HOST = `pilot-next.${ZONE}`;
const COMMIT = hex(20);

/** A Cloudflare account as the fake API holds it; `over` changes the starting state. */
function world(over = {}) {
  const ACCOUNT = hex(16);
  const s = {
    account: { id: ACCOUNT, name: 'KohiLabs' },
    zones: [{ id: hex(16), name: ZONE, account: { id: ACCOUNT } }],
    apps: [],
    policies: [],
    tokens: [],
    dns: [],
    domains: [],
    worker: false,
    ...over,
  };
  if (typeof over.account === 'function') s.account = over.account(ACCOUNT);
  if (typeof over.zones === 'function') s.zones = over.zones(ACCOUNT);
  const env = {
    CP_NEXT_CF_API_TOKEN: randomBytes(30).toString('base64url'),
    CP_NEXT_CF_ACCOUNT_ID: ACCOUNT,
    CP_NEXT_ZONE: ZONE,
    CP_NEXT_HOST: HOST,
  };
  const calls = [];
  const secrets = [];
  const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
  const notFound = () => new Response(JSON.stringify({ success: false, errors: [{ code: 10007, message: 'not found' }] }), { status: 404 });
  const newSecret = () => {
    const v = randomBytes(32).toString('base64url');
    secrets.push(v);
    return v;
  };
  const acct = `/accounts/${ACCOUNT}`;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    if (u.host === HOST) {
      // The Worker behind Access: the service token's current secret gets in, nobody else does.
      const secret = init.headers?.['CF-Access-Client-Secret'];
      if (secret && secret === secrets.at(-1))
        return new Response(JSON.stringify({ ok: true, service: WORKER, commit: COMMIT }), { status: 200 });
      return new Response(null, { status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x' } });
    }
    assert.equal(u.host, 'api.cloudflare.com');
    assert.equal(init.headers.authorization, `Bearer ${env.CP_NEXT_CF_API_TOKEN}`);
    const path = u.pathname.replace('/client/v4', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (key === `GET ${acct}`) return s.account ? ok(s.account) : notFound();
    if (key === 'GET /zones') return ok(s.zones);
    if (key === `GET ${acct}/access/apps`) return ok(s.apps);
    if (key === `POST ${acct}/access/apps`) {
      const app = { id: hex(8), ...body };
      s.apps.push(app);
      return ok(app);
    }
    const pol = /^(GET|POST) \/accounts\/[0-9a-f]+\/access\/apps\/([0-9a-f]+)\/policies$/.exec(key);
    if (pol?.[1] === 'GET') return ok(s.policies);
    if (pol?.[1] === 'POST') return ok({ id: hex(8), ...body });
    if (/^PUT .*\/policies\/[0-9a-f]+$/.test(key)) return ok({ ...body });
    if (key === `GET ${acct}/access/service_tokens`) return ok(s.tokens);
    if (key === `POST ${acct}/access/service_tokens`) return ok({ id: hex(8), client_id: hex(16), client_secret: newSecret() });
    if (/^POST .*\/service_tokens\/[0-9a-f]+\/rotate$/.test(key)) return ok({ client_secret: newSecret() });
    if (/^GET \/zones\/[0-9a-f]+\/dns_records$/.test(key)) return ok(s.dns);
    if (key === `GET ${acct}/workers/domains`) return ok(s.domains);
    if (key === `PUT ${acct}/workers/domains`) return ok({ id: hex(8) });
    if (key === `GET ${acct}/workers/scripts/${WORKER}/settings`) return s.worker ? ok({}) : notFound();
    throw new Error(`unexpected call ${key}`);
  };
  const lines = [];
  const deployed = [];
  /** Each SPA build's environment (PILOT-1148), and the order of builds and deploys. */
  const builds = [];
  const steps = [];
  const deps = (argv, { buildStatus = 0 } = {}) => ({
    fetch,
    env,
    argv,
    log: (l) => lines.push(String(l)),
    commit: () => COMMIT,
    build: (benv) => {
      builds.push(benv);
      steps.push('build');
      return { status: buildStatus };
    },
    wrangler: (wenv, args) => {
      steps.push('wrangler');
      deployed.push(args);
      assert.equal(wenv.CLOUDFLARE_API_TOKEN, env.CP_NEXT_CF_API_TOKEN, 'wrangler gets the token through its environment');
      return { status: 0, stdout: `Current Version ID: ${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, stderr: '' };
    },
    sleep: async () => {},
  });
  const writes = () => calls.filter((c) => c.method !== 'GET');
  /** Nothing the run logged holds the API token or a service token's secret. */
  const clean = () => {
    const all = lines.join('\n');
    for (const v of [env.CP_NEXT_CF_API_TOKEN, ...secrets]) assert.ok(!all.includes(v), 'a credential reached the log');
    assert.ok(!all.includes(ACCOUNT), 'the account id is not logged');
  };
  return { s, env, calls, lines, deployed, builds, steps, deps, writes, clean, ACCOUNT };
}

/** The state after a first successful run: our app with our policy, the token, the domain, the Worker. */
const deployedState = () => {
  const appId = hex(8);
  const tokenId = hex(8);
  return {
    apps: [{ id: appId, name: APP_NAME, domain: HOST }],
    policies: [{ id: hex(8), name: POLICY_NAME, decision: 'non_identity' }],
    tokens: [{ id: tokenId, name: TOKEN_NAME, client_id: hex(16) }],
    dns: [{ type: 'AAAA' }],
    domains: [{ id: hex(8), hostname: HOST, service: WORKER }],
    worker: true,
  };
};

test('--plan on a fresh account: reads only, pins the account first, says what a run would do', async () => {
  const w = world();
  assert.equal(await run(w.deps(['--plan'])), 0);
  assert.deepEqual(w.writes(), [], 'a plan writes nothing');
  assert.equal(w.calls[0].path, `/accounts/${w.ACCOUNT}`, 'the account is read before anything else');
  const out = w.lines.join('\n');
  assert.match(out, /account pinned: KohiLabs/);
  assert.match(out, /Access app cp-next-access: missing, will be created/);
  assert.match(out, /service token cp-next-healthcheck: missing, will be created/);
  assert.match(out, /PLAN only: nothing changed/);
  assert.equal(w.deployed.length, 0);
  assert.equal(w.builds.length, 0, 'no SPA build (PILOT-1148)');
  w.clean();
});

test('an unknown argument (a typo of --plan, a stray value) stops before any call: a typo never writes', async () => {
  for (const argv of [['--plna'], ['--plan', '--rotat'], ['plan'], ['--plan=1'], ['--keep-unknown-policies', '--force'], ['']]) {
    const w = world(deployedState());
    await assert.rejects(run(w.deps(argv)), (x) => x instanceof Stop && /unknown argument/.test(x.message), JSON.stringify(argv));
    assert.deepEqual(w.calls, [], `no Cloudflare call at all (${JSON.stringify(argv)})`);
    assert.equal(w.deployed.length, 0);
    assert.equal(w.builds.length, 0, 'no SPA build (PILOT-1148)');
  }
  const w = world({ account: (id) => ({ id, name: 'Kohi Labs' }) });
  assert.equal(await run(w.deps(['--plan'])), 0, 'the allowed spelling with one space passes');
});

test('the account pin: another account name, an unreadable account, or a zone of another account stops before any write (a plan too)', async () => {
  for (const [over, why] of [
    [{ account: (id) => ({ id, name: 'Isnan.me' }) }, /not KohiLabs.*Isnan\.me/],
    [{ account: (id) => ({ id, name: 'KohiLabs Sandbox' }) }, /not KohiLabs.*KohiLabs Sandbox/],
    [{ account: (id) => ({ id, name: 'kohilabs-old' }) }, /not KohiLabs/],
    [{ account: (id) => ({ id: hex(16), name: 'KohiLabs' }) }, /not KohiLabs/],
    [{ account: null }, /not readable with this token \(404\)/],
    [{ zones: () => [{ id: hex(16), name: ZONE, account: { id: hex(16) } }] }, /zone belongs to another account/],
  ]) {
    for (const argv of [['--plan'], []]) {
      const w = world(over);
      await assert.rejects(run(w.deps(argv)), (x) => x instanceof Stop && why.test(x.message), `${why} (${argv.join(' ') || 'run'})`);
      assert.deepEqual(w.writes(), [], 'nothing written');
      assert.equal(w.deployed.length, 0, 'nothing deployed');
      assert.equal(w.builds.length, 0, 'no SPA build (PILOT-1148)');
    }
  }
});

test('an unknown policy on cp-next-access stops the plan and the run; --keep-unknown-policies goes on and leaves it', async () => {
  const state = () => ({
    ...deployedState(),
    policies: [...deployedState().policies, { id: hex(8), name: 'everyone', decision: 'allow' }],
  });
  for (const argv of [['--plan'], [], ['--rotate']]) {
    const w = world(state());
    await assert.rejects(
      run(w.deps(argv)),
      (x) => x instanceof Stop && /policies this script did not make: everyone \(allow\)/.test(x.message),
    );
    assert.deepEqual(w.writes(), [], `nothing written (${argv.join(' ') || 'run'})`);
    assert.equal(w.deployed.length, 0);
    assert.equal(w.builds.length, 0, 'no SPA build (PILOT-1148)');
  }
  const w = world(state());
  assert.equal(await run(w.deps(['--keep-unknown-policies', '--rotate'])), 0);
  assert.match(w.lines.join('\n'), /--keep-unknown-policies: the app's other policies are left as they are: everyone \(allow\)/);
  assert.ok(!w.writes().some((c) => /\/policies\//.test(c.path) && c.body?.name !== POLICY_NAME), 'the unknown policy is not touched');
  w.clean();
});

test('a plain re-run keeps the service token: no rotation, the token check SKIPPED, exit 3', async () => {
  const w = world(deployedState());
  assert.equal(await run(w.deps([])), 3);
  assert.ok(!w.calls.some((c) => c.path.endsWith('/rotate')), 'no rotation without --rotate');
  assert.ok(!w.calls.some((c) => c.method === 'POST' && c.path.endsWith('/service_tokens')), 'no new token either');
  const out = w.lines.join('\n');
  assert.match(out, /exists \([0-9a-f]+\), kept \(no --rotate/);
  assert.match(out, /CHECK unauthenticated: 302 .*PASS \(Access\)/);
  assert.match(out, /CHECK service token: SKIPPED/);
  assert.equal(w.deployed.length, 1);
  const put = w.writes().find((c) => c.method === 'PUT' && /\/policies\//.test(c.path));
  assert.equal(put.body.include[0].service_token.token_id, w.s.tokens[0].id, 'the policy still names the kept token');
  assert.ok(!w.writes().some((c) => c.path.endsWith('/workers/domains')), 'the attached domain is not attached again');
  w.clean();
});

test('the deploy writes CP_KUBE_IMAGES, the Worker’s image allow list, as a plain var (PILOT-1190)', async () => {
  const w = world(deployedState());
  assert.equal(await run(w.deps([])), 3);
  const args = w.deployed[0];
  const vars = args.flatMap((a, i) => (args[i - 1] === '--var' ? [a] : []));
  const kube = vars.find((v) => v.startsWith('CP_KUBE_IMAGES:'));
  assert.ok(kube, 'CP_KUBE_IMAGES is written');
  // wrangler splits at the first colon: the value keeps each tag's colon.
  assert.deepEqual(kube.slice('CP_KUBE_IMAGES:'.length).split(','), KUBE_IMAGES);
  assert.ok(
    KUBE_IMAGES.length > 0 && KUBE_IMAGES.every((r) => /^[a-z0-9.-]+\/[a-z0-9._/-]+:[A-Za-z0-9._-]+$/.test(r)),
    'plain tagged references',
  );
  w.clean();
});

test('KUBE_IMAGES holds every image the portal’s workspaces run (deploy/k3s/portal.yaml), so stg does not refuse them', () => {
  const yaml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../deploy/k3s/portal.yaml'), 'utf8');
  const base = /- name: PORTAL_K8S_IMAGE\s+value: (\S+)/.exec(yaml)?.[1];
  const targets = JSON.parse(/- name: PORTAL_K8S_TARGETS\s+value: '([^']+)'/.exec(yaml)?.[1] ?? '[]');
  const used = new Set([base, ...targets.map((t) => t.image).filter(Boolean)]);
  assert.ok(base && used.size >= 1, 'portal.yaml still names its images where this test looks');
  for (const ref of used) assert.ok(KUBE_IMAGES.includes(ref), `${ref} is in KUBE_IMAGES`);
});

test('--rotate on a re-run rotates the token and checks with its new secret: exit 0', async () => {
  const w = world(deployedState());
  assert.equal(await run(w.deps(['--rotate'])), 0);
  assert.equal(w.calls.filter((c) => c.path.endsWith('/rotate')).length, 1);
  assert.match(w.lines.join('\n'), /CHECK service token: 200 PASS/);
  w.clean();
});

test('a first run creates the app, the token, the one policy and the domain, in that order, and both checks pass', async () => {
  const w = world();
  assert.equal(await run(w.deps([])), 0);
  const order = w.writes().map((c) => `${c.method} ${c.path.replace(/\/accounts\/[0-9a-f]+/, '').replace(/[0-9a-f]{16}/g, '<id>')}`);
  assert.equal(order[0], 'POST /access/apps', 'Access first (D3)');
  assert.equal(order[1], 'POST /access/service_tokens');
  assert.equal(order[2], 'POST /access/apps/<id>/policies');
  assert.equal(order.at(-1), 'PUT /workers/domains', 'the host gets its DNS only after the deploy');
  const policy = w.writes()[2].body;
  assert.equal(policy.include.length, 1, 'one include rule');
  assert.deepEqual(Object.keys(policy.include[0]), ['service_token'], 'the service token only');
  assert.equal(policy.decision, 'non_identity');
  w.clean();
});

test('the SPA build (PILOT-1148): once per run, after the Access writes and before wrangler, with no Cloudflare value in its env', async () => {
  const w = world();
  // Values a job's environment may already hold; built at run time, never a literal.
  const extra = {
    CLOUDFLARE_API_TOKEN: randomBytes(30).toString('base64url'),
    CLOUDFLARE_ACCOUNT_ID: hex(16),
    cloudflare_api_key: hex(16),
    CP_NEXT_CF_OTHER: hex(8),
    PATH: '/usr/bin',
  };
  Object.assign(w.env, extra);
  assert.equal(await run(w.deps([])), 0);
  assert.deepEqual(w.steps, ['build', 'wrangler']);
  assert.equal(w.builds.length, 1);
  const benv = w.builds[0];
  const leaked = Object.keys(benv).filter((k) => /^(?:CP_NEXT_CF_|CLOUDFLARE_)/i.test(k));
  assert.deepEqual(leaked, [], 'no CP_NEXT_CF_* or CLOUDFLARE_* name reaches the build');
  for (const v of [w.env.CP_NEXT_CF_API_TOKEN, w.env.CP_NEXT_CF_ACCOUNT_ID, extra.CLOUDFLARE_API_TOKEN, extra.CLOUDFLARE_ACCOUNT_ID])
    assert.ok(!Object.values(benv).includes(v), 'no Cloudflare value reaches the build');
  assert.equal(benv.PATH, '/usr/bin', 'the rest of the environment is kept');
  assert.equal(benv.CP_NEXT_HOST, w.env.CP_NEXT_HOST);
  // Every Access write is before the build: a build that fails leaves Access deny-first and deploys nothing.
  assert.ok(
    w
      .writes()
      .slice(0, 3)
      .every((c) => /\/access\//.test(c.path)),
  );
  w.clean();
});

test('a failed SPA build stops the run before wrangler and before the custom domain', async () => {
  const w = world();
  await assert.rejects(run(w.deps([], { buildStatus: 2 })), (x) => x instanceof Stop && /the SPA build exited 2/.test(x.message));
  assert.deepEqual(w.steps, ['build']);
  assert.equal(w.deployed.length, 0);
  assert.ok(!w.writes().some((c) => c.path.endsWith('/workers/domains')), 'the host is not attached');
  w.clean();
});

test('buildEnv drops CP_NEXT_CF_* and CLOUDFLARE_* (any case) and keeps the rest', () => {
  const t = hex(8);
  assert.deepEqual(
    buildEnv({ CP_NEXT_CF_API_TOKEN: t, CLOUDFLARE_API_TOKEN: t, Cloudflare_Account_Id: t, CP_NEXT_HOST: 'h', HOME: '/h' }),
    {
      CP_NEXT_HOST: 'h',
      HOME: '/h',
    },
  );
});
