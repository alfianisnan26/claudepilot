#!/usr/bin/env node
// cp-next-core to staging (PILOT-1145): the Worker on its own host, behind Cloudflare Access, in this order (D3: Access first):
//   0. the account is pinned before anything is written (PILOT-1180): GET /accounts/<id> must answer, its name must be KohiLabs, and the
//      zone must belong to it.
//   1. the Access application `cp-next-access` on the host (self-hosted, whole host). Created with no policy = everyone denied.
//   2. its one policy `cp-next-healthcheck`: the service token `cp-next-healthcheck` only (non_identity). No email, no domain:
//      people are added by the owner later. A policy on the app that this script did not make stops the run (the app is deny-first, so
//      an allow rule nobody here knows of is unsafe), unless --keep-unknown-policies is given.
//   3. `npm run build` (the SPA into public/, PILOT-1148; its env has no CP_NEXT_CF_* or CLOUDFLARE_* value, and a failed build stops
//      the run before wrangler), then `wrangler deploy` (wrangler.jsonc has no route; CP_VERSION/CP_COMMIT from this commit).
//      --plan and a guard stop never build.
//   4. the Worker custom domain for the host (this creates its DNS record; nothing else in the zone is touched).
//   5. the checks: /healthz with no credentials is the Access login redirect or 403; with the service token it is 200 and this commit.
//      The token's secret is known to a run only when it creates the token or rotates it. A plain re-run with the token in place does
//      NOT rotate it (PILOT-1180), so it cannot do the second check: it says SKIPPED and exits 3. --rotate rotates the token (its old
//      secret stops working), and the run then does both checks.
// Usage (in the cluster, never in the pod):
//   scripts/job-run.sh --ref <sha> --pool-env CP_NEXT_CF_API_TOKEN --pool-env CP_NEXT_CF_ACCOUNT_ID --pool-env CP_NEXT_ZONE \
//     --pool-env CP_NEXT_HOST -- 'node apps/core-worker/scripts/deploy-stg.mjs [--plan] [--rotate] [--keep-unknown-policies]; exit $?'
// --plan: reads only (account, zone, Access app and its policies, token, DNS record, custom domain, Worker) and says what a run would do;
//   the guards stop a plan the same way they stop a run.
// Any other argument stops the run before any call (a typo must never write).
// Exit: 0 both checks passed; 1 stopped by a guard, or a check failed; 3 deployed, the Access check passed, the token check skipped.
// Guards: every name is cp-next-*; the host must be pilot-next.<zone>; the account is KohiLabs; an existing Access app or DNS record
// that is not ours, or an unknown policy on our app, stops it.
// Never prints a credential: no response body that can hold one is logged, and fetch and wrangler get the token from the environment
// (wrangler as CLOUDFLARE_API_TOKEN); the service token's secret lives in memory for the check only.
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const APP_NAME = 'cp-next-access';
export const POLICY_NAME = 'cp-next-healthcheck';
export const TOKEN_NAME = 'cp-next-healthcheck';
export const WORKER = 'cp-next-core';
/**
 * The account this Worker belongs on (PILOT-1180): its whole name as GET /accounts/<id> gives it, exactly "KohiLabs" (any case, one
 * space allowed), so "KohiLabs Sandbox" does not pass. The id is checked against CP_NEXT_CF_ACCOUNT_ID; the name is the pin, because
 * an id literal here would only repeat the pool value and give a reader no way to see which account it is.
 */
export const ACCOUNT_NAME = /^kohi ?labs$/i;
/** The only arguments the script takes; anything else stops it. */
export const FLAGS = ['--plan', '--rotate', '--keep-unknown-policies'];
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A guard stopped the run (exit 1). */
export class Stop extends Error {}

/**
 * The environment the SPA build gets (PILOT-1148): the run's, without any Cloudflare value. `npm run build` runs apps/web's build and
 * its plugins, which have no business with the API token or the account: CP_NEXT_CF_* (the pool's) and CLOUDFLARE_* (wrangler's, if
 * the job's environment already had one) are dropped.
 */
export const buildEnv = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^(?:CP_NEXT_CF_|CLOUDFLARE_)/i.test(k)));

/**
 * The whole run. `deps` are the outside world, so a test can stand in for each (no network, no git, no build, no wrangler):
 * fetch, env, argv, log, commit(), build(env) -> { status } (the SPA, PILOT-1148), wrangler(env, args) -> { status, stdout, stderr },
 * and sleep(ms).
 * Returns the exit code; a guard throws Stop.
 */
export async function run(deps) {
  const { fetch, env: e, argv, log = console.log } = deps;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const fail = (msg) => {
    throw new Stop(msg);
  };
  // A typo (`--plna`) must never write: any argument but these stops the run before anything is read or written (PILOT-1180).
  const unknown = argv.filter((a) => !FLAGS.includes(a));
  if (unknown.length) fail(`unknown argument ${JSON.stringify(unknown[0].slice(0, 40))}; allowed: ${FLAGS.join(', ')}`);
  const PLAN = argv.includes('--plan');
  const ROTATE = argv.includes('--rotate');
  const KEEP_UNKNOWN = argv.includes('--keep-unknown-policies');
  const say = (msg) => log(`deploy-stg: ${msg}`);

  for (const n of ['CP_NEXT_CF_API_TOKEN', 'CP_NEXT_CF_ACCOUNT_ID', 'CP_NEXT_ZONE', 'CP_NEXT_HOST']) if (!e[n]) fail(`${n} is not set`);
  const TOKEN = e.CP_NEXT_CF_API_TOKEN;
  const ACCOUNT = e.CP_NEXT_CF_ACCOUNT_ID;
  const ZONE = e.CP_NEXT_ZONE;
  const HOST = e.CP_NEXT_HOST;
  if (HOST !== `pilot-next.${ZONE}`) fail('CP_NEXT_HOST must be pilot-next.<CP_NEXT_ZONE>');
  if (!/^[0-9a-f]{32}$/.test(ACCOUNT)) fail('CP_NEXT_CF_ACCOUNT_ID is not an account id');
  for (const n of [APP_NAME, POLICY_NAME, TOKEN_NAME, WORKER]) if (!n.startsWith('cp-next-')) fail(`${n} is not a cp-next-* name`);

  /** The Cloudflare API. Returns `result`; on an error says the status and the API's error codes/messages (they hold no secret). */
  async function cf(method, path, body) {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) {
      const errs = (json?.errors ?? []).map((x) => `${x.code}: ${x.message}`).join('; ');
      const err = new Error(`${method} ${path.replaceAll(ACCOUNT, '<account>')} -> ${res.status} ${errs}`);
      err.status = res.status;
      throw err;
    }
    return json.result;
  }

  const acct = `/accounts/${ACCOUNT}`;
  const commit = deps.commit();

  // Read. The account first: nothing below runs on an account that is not KohiLabs.
  let account;
  try {
    account = await cf('GET', acct);
  } catch (x) {
    fail(`the account is not readable with this token (${x.status ?? x.message})`);
  }
  if (account?.id !== ACCOUNT || !ACCOUNT_NAME.test(String(account?.name ?? '').trim()))
    fail(`the account is not KohiLabs (its name: ${JSON.stringify(String(account?.name ?? '').slice(0, 60))})`);
  say(`account pinned: ${account.name}`);

  const zones = await cf('GET', `/zones?name=${encodeURIComponent(ZONE)}&account.id=${ACCOUNT}`);
  if (zones.length !== 1) fail(`zone not found on this account (${zones.length} matches)`);
  if (zones[0].account?.id !== ACCOUNT) fail('the zone belongs to another account');
  const zoneId = zones[0].id;
  say(`zone found on the account`);

  const apps = await cf('GET', `${acct}/access/apps?per_page=1000`);
  let app = apps.find((a) => a.name === APP_NAME);
  const onHost = apps.filter(
    (a) => a.name !== APP_NAME && [a.domain, ...(a.self_hosted_domains ?? [])].some((d) => d && (d === HOST || d.startsWith(`${HOST}/`))),
  );
  if (onHost.length) fail(`another Access app already covers the host (${onHost.map((a) => a.name).join(', ')})`);
  if (app && app.domain !== HOST) fail(`${APP_NAME} exists with another domain`);
  say(`Access app ${APP_NAME}: ${app ? `exists (${app.id})` : 'missing, will be created'}`);

  // The app's policies, read before any write: one this script did not make stops the run (deny-first app, PILOT-1180).
  let policies = [];
  if (app) {
    policies = await cf('GET', `${acct}/access/apps/${app.id}/policies`);
    const foreign = policies.filter((p) => p.name !== POLICY_NAME);
    const named = foreign.map((p) => `${p.name} (${p.decision})`).join(', ');
    if (foreign.length && !KEEP_UNKNOWN)
      fail(`${APP_NAME} has policies this script did not make: ${named}. Remove them, or re-run with --keep-unknown-policies`);
    if (foreign.length) say(`note: --keep-unknown-policies: the app's other policies are left as they are: ${named}`);
  }

  const tokens = await cf('GET', `${acct}/access/service_tokens?per_page=1000`);
  let svc = tokens.find((t) => t.name === TOKEN_NAME);
  say(
    `service token ${TOKEN_NAME}: ${
      !svc
        ? 'missing, will be created'
        : ROTATE
          ? `exists (${svc.id}), will be rotated (--rotate)`
          : `exists (${svc.id}), kept (no --rotate: the token check is skipped)`
    }`,
  );

  let dns = [];
  try {
    dns = await cf('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(HOST)}`);
  } catch (x) {
    say(`DNS records not readable (${x.status}); the custom domain call will say if one is in the way`);
  }
  const domains = await cf('GET', `${acct}/workers/domains?hostname=${encodeURIComponent(HOST)}`);
  const ours = domains.find((d) => d.hostname === HOST && d.service === WORKER);
  const theirs = domains.find((d) => d.hostname === HOST && d.service !== WORKER);
  if (theirs) fail(`the host is a custom domain of another Worker (${theirs.service})`);
  if (dns.length && !ours)
    fail(`a DNS record for the host already exists (${dns.map((r) => r.type).join(', ')}) and it is not this Worker's custom domain`);
  say(`custom domain: ${ours ? `attached (${ours.id})` : 'not attached, will be attached after the deploy'}`);

  let workerExists = true;
  try {
    await cf('GET', `${acct}/workers/scripts/${WORKER}/settings`);
  } catch (x) {
    if (x.status !== 404) throw x;
    workerExists = false;
  }
  say(`Worker ${WORKER}: ${workerExists ? 'exists' : 'missing, will be created'}; commit ${commit}`);

  if (PLAN) {
    say('PLAN only: nothing changed');
    return 0;
  }

  // 1. Access app (no policy yet = nobody gets in).
  if (!app) {
    app = await cf('POST', `${acct}/access/apps`, {
      name: APP_NAME,
      domain: HOST,
      type: 'self_hosted',
      session_duration: '24h',
      app_launcher_visible: false,
    });
    say(`Access app created: ${app.id} on the whole host`);
  }

  // 2. Service token and the only policy.
  let svcSecret;
  if (!svc) {
    const created = await cf('POST', `${acct}/access/service_tokens`, { name: TOKEN_NAME, duration: '8760h' });
    svc = { id: created.id, client_id: created.client_id };
    svcSecret = created.client_secret;
    say(`service token created: ${svc.id}`);
  } else if (ROTATE) {
    svcSecret = (await cf('POST', `${acct}/access/service_tokens/${svc.id}/rotate`)).client_secret;
    say(`service token rotated: ${svc.id}`);
  }
  const policyBody = { name: POLICY_NAME, decision: 'non_identity', include: [{ service_token: { token_id: svc.id } }], precedence: 1 };
  const existing = policies.find((p) => p.name === POLICY_NAME);
  if (existing) await cf('PUT', `${acct}/access/apps/${app.id}/policies/${existing.id}`, policyBody);
  else await cf('POST', `${acct}/access/apps/${app.id}/policies`, policyBody);
  say(`policy ${POLICY_NAME}: non_identity, include service token ${svc.id} only`);

  // 3. The Worker, with the SPA as its assets (PILOT-1148: apps/web's build and its _headers in public/). Only a run that got past every
  // guard and the PLAN return builds; the build gets no Cloudflare value, and a failed build deploys nothing.
  const built = deps.build(buildEnv(e));
  if (built.status !== 0) fail(`the SPA build exited ${built.status}`);
  const deploy = deps.wrangler({ ...e, CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, [
    'deploy',
    '--var',
    `CP_VERSION:stg-${commit.slice(0, 12)}`,
    '--var',
    `CP_COMMIT:${commit}`,
  ]);
  const out = `${deploy.stdout}\n${deploy.stderr}`;
  log(out.replaceAll(ACCOUNT, '<account>'));
  if (deploy.status !== 0) fail(`wrangler deploy exited ${deploy.status}`);
  const version = /Current Version ID:\s*([0-9a-f-]{36})/.exec(out)?.[1];
  say(`VERSION ${version ?? 'not found in the output'}`);

  // 4. The custom domain (after Access exists).
  if (!ours) {
    const d = await cf('PUT', `${acct}/workers/domains`, { hostname: HOST, service: WORKER, zone_id: zoneId, environment: 'production' });
    say(`custom domain attached: ${d.id}`);
  }

  // 5. Checks (the certificate can take a few minutes on a new custom domain).
  const url = `https://${HOST}/healthz`;
  let anon, authed, body;
  for (let i = 0; i < 40; i++) {
    try {
      anon = await fetch(url, { redirect: 'manual' });
      if (svcSecret === undefined) {
        if ([301, 302, 403].includes(anon.status)) break; // Access answers: the host is up
      } else {
        authed = await fetch(url, {
          redirect: 'manual',
          headers: { 'CF-Access-Client-Id': svc.client_id, 'CF-Access-Client-Secret': svcSecret },
        });
        body = await authed.text();
        if (authed.status === 200) break;
      }
    } catch (x) {
      say(`waiting for the host (${x.cause?.code ?? x.message})`);
    }
    await sleep(15_000);
  }
  const skipped = svcSecret === undefined;
  svcSecret = undefined;
  const loc = anon?.headers.get('location') ?? '';
  const anonOk = !!anon && (anon.status === 403 || ((anon.status === 302 || anon.status === 301) && /\.cloudflareaccess\.com\//.test(loc)));
  say(
    `CHECK unauthenticated: ${anon?.status} ${loc ? `-> ${new URL(loc).host}${new URL(loc).pathname}` : ''} ${anonOk ? 'PASS (Access)' : 'FAIL'}`,
  );
  let healthOk = false;
  if (skipped) say('CHECK service token: SKIPPED (the token was kept, so its secret is unknown to this run; --rotate checks it)');
  else {
    try {
      const h = JSON.parse(body ?? '');
      healthOk = authed.status === 200 && h.ok === true && h.service === WORKER && h.commit === commit;
    } catch {}
    say(`CHECK service token: ${authed?.status} ${healthOk ? `PASS ${body}` : 'FAIL'}`);
  }
  say(
    `ROLLBACK: npx wrangler rollback <previous version id> (cwd apps/core-worker); to take the host off: DELETE /accounts/<account>/workers/domains/<domain id>`,
  );
  if (!anonOk) return 1;
  if (skipped) return 3;
  return healthOk ? 0 : 1;
}

// Run as a script (not when a test imports it).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await run({
      fetch: globalThis.fetch,
      env: process.env,
      argv: process.argv.slice(2),
      commit: () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      build: (env) => spawnSync('npm', ['run', 'build'], { cwd: WORKER_DIR, env, stdio: 'inherit' }),
      wrangler: (env, args) => spawnSync('npx', ['wrangler', ...args], { cwd: WORKER_DIR, env, encoding: 'utf8' }),
    });
  } catch (x) {
    if (!(x instanceof Stop)) throw x;
    console.error(`deploy-stg: STOP: ${x.message}`);
    process.exitCode = 1;
  }
}
