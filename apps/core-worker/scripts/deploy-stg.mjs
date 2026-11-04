#!/usr/bin/env node
// cp-next-core to staging (PILOT-1145): the Worker on its own host, behind Cloudflare Access, in this order (D3: Access first):
//   1. the Access application `cp-next-access` on the host (self-hosted, whole host). Created with no policy = everyone denied.
//   2. its one policy `cp-next-healthcheck`: the service token `cp-next-healthcheck` only (non_identity). No email, no domain:
//      people are added by the owner later. The token's secret is used in this run for the check and is never printed or kept;
//      an existing token is rotated (its old secret stops working).
//   3. `wrangler deploy` (wrangler.jsonc has no route; CP_VERSION/CP_COMMIT from this commit).
//   4. the Worker custom domain for the host (this creates its DNS record; nothing else in the zone is touched).
//   5. the checks: /healthz with no credentials is the Access login redirect or 403; with the service token it is 200 and this commit.
// Usage (in the cluster, never in the pod):
//   scripts/job-run.sh --ref <sha> --pool-env CP_NEXT_CF_API_TOKEN --pool-env CP_NEXT_CF_ACCOUNT_ID --pool-env CP_NEXT_ZONE \
//     --pool-env CP_NEXT_HOST -- 'node apps/core-worker/scripts/deploy-stg.mjs [--plan]; exit $?'
// --plan: reads only (zone, Access app, token, DNS record, custom domain, Worker) and says what a run would do.
// Guards: every name is cp-next-*; the host must be pilot-next.<zone>; an existing Access app or DNS record that is not ours stops it.
// Never prints a credential: no response body that can hold one is logged, and curl/wrangler get the token through the environment.
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLAN = process.argv.includes('--plan');
const APP_NAME = 'cp-next-access';
const POLICY_NAME = 'cp-next-healthcheck';
const TOKEN_NAME = 'cp-next-healthcheck';
const WORKER = 'cp-next-core';
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const fail = (msg) => {
  console.error(`deploy-stg: STOP: ${msg}`);
  process.exit(1);
};
const say = (msg) => console.log(`deploy-stg: ${msg}`);

for (const n of ['CP_NEXT_CF_API_TOKEN', 'CP_NEXT_CF_ACCOUNT_ID', 'CP_NEXT_ZONE', 'CP_NEXT_HOST'])
  if (!process.env[n]) fail(`${n} is not set`);
const TOKEN = process.env.CP_NEXT_CF_API_TOKEN;
const ACCOUNT = process.env.CP_NEXT_CF_ACCOUNT_ID;
const ZONE = process.env.CP_NEXT_ZONE;
const HOST = process.env.CP_NEXT_HOST;
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
    const errs = (json?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ');
    const err = new Error(`${method} ${path.replace(ACCOUNT, '<account>')} -> ${res.status} ${errs}`);
    err.status = res.status;
    throw err;
  }
  return json.result;
}

const acct = `/accounts/${ACCOUNT}`;
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

// Read.
const zones = await cf('GET', `/zones?name=${encodeURIComponent(ZONE)}&account.id=${ACCOUNT}`);
if (zones.length !== 1) fail(`zone not found on this account (${zones.length} matches)`);
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

const tokens = await cf('GET', `${acct}/access/service_tokens?per_page=1000`);
let svc = tokens.find((t) => t.name === TOKEN_NAME);
say(`service token ${TOKEN_NAME}: ${svc ? `exists (${svc.id}), will be rotated for the check` : 'missing, will be created'}`);

let dns = [];
try {
  dns = await cf('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(HOST)}`);
} catch (e) {
  say(`DNS records not readable (${e.status}); the custom domain call will say if one is in the way`);
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
} catch (e) {
  if (e.status !== 404) throw e;
  workerExists = false;
}
say(`Worker ${WORKER}: ${workerExists ? 'exists' : 'missing, will be created'}; commit ${commit}`);

if (PLAN) {
  say('PLAN only: nothing changed');
  process.exit(0);
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
if (svc) {
  svcSecret = (await cf('POST', `${acct}/access/service_tokens/${svc.id}/rotate`)).client_secret;
  say(`service token rotated: ${svc.id}`);
} else {
  const created = await cf('POST', `${acct}/access/service_tokens`, { name: TOKEN_NAME, duration: '8760h' });
  svc = { id: created.id, client_id: created.client_id };
  svcSecret = created.client_secret;
  say(`service token created: ${svc.id}`);
}
const policies = await cf('GET', `${acct}/access/apps/${app.id}/policies`);
const foreign = policies.filter((p) => p.name !== POLICY_NAME);
if (foreign.length)
  say(`note: the app has other policies, left as they are: ${foreign.map((p) => `${p.name} (${p.decision})`).join(', ')}`);
const policyBody = { name: POLICY_NAME, decision: 'non_identity', include: [{ service_token: { token_id: svc.id } }], precedence: 1 };
const existing = policies.find((p) => p.name === POLICY_NAME);
if (existing) await cf('PUT', `${acct}/access/apps/${app.id}/policies/${existing.id}`, policyBody);
else await cf('POST', `${acct}/access/apps/${app.id}/policies`, policyBody);
say(`policy ${POLICY_NAME}: non_identity, include service token ${svc.id} only`);

// 3. The Worker.
const env = { ...process.env, CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
const deploy = spawnSync('npx', ['wrangler', 'deploy', '--var', `CP_VERSION:stg-${commit.slice(0, 12)}`, '--var', `CP_COMMIT:${commit}`], {
  cwd: WORKER_DIR,
  env,
  encoding: 'utf8',
});
const out = `${deploy.stdout}\n${deploy.stderr}`;
console.log(out.replaceAll(ACCOUNT, '<account>'));
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
    authed = await fetch(url, {
      redirect: 'manual',
      headers: { 'CF-Access-Client-Id': svc.client_id, 'CF-Access-Client-Secret': svcSecret },
    });
    body = await authed.text();
    if (authed.status === 200) break;
  } catch (e) {
    say(`waiting for the host (${e.cause?.code ?? e.message})`);
  }
  await new Promise((r) => setTimeout(r, 15_000));
}
svcSecret = undefined;
const loc = anon?.headers.get('location') ?? '';
const anonOk = anon && (anon.status === 403 || ((anon.status === 302 || anon.status === 301) && /\.cloudflareaccess\.com\//.test(loc)));
say(
  `CHECK unauthenticated: ${anon?.status} ${loc ? `-> ${new URL(loc).host}${new URL(loc).pathname}` : ''} ${anonOk ? 'PASS (Access)' : 'FAIL'}`,
);
let healthOk = false;
try {
  const h = JSON.parse(body ?? '');
  healthOk = authed.status === 200 && h.ok === true && h.service === WORKER && h.commit === commit;
} catch {}
say(`CHECK service token: ${authed?.status} ${healthOk ? `PASS ${body}` : 'FAIL'}`);
say(
  `ROLLBACK: npx wrangler rollback <previous version id> (cwd apps/core-worker); to take the host off: DELETE ${'/accounts/<account>/workers/domains/<domain id>'}`,
);
process.exit(anonOk && healthOk ? 0 : 1);
