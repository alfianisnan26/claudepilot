// Fetches every GET API endpoint it can fill in (real ids from the lists) and reports which responses contain a needle.
// usage: node tools/qa/crawl-get.mjs <needle> [--skip-events]   (QA_PORT / QA_CODE as in lib.mjs)
import { api, login } from './lib.mjs';
const needle = process.argv[2];
const cookie = await login();
const call = api(cookie);
const urls = new Set(['/api/session', '/api/admin/state', '/api/admin/system', '/api/workspaces', '/api/workspaces/targets', '/api/workspaces/usage', '/api/accounts', '/api/account-pools', '/api/pools', '/api/mcp/catalog', '/api/skills/library', '/api/chat/sessions', '/api/chat/usage', '/api/chat/usage?range=30d']);
const ws = (await call('GET', '/api/workspaces')).data ?? [];
for (const w of ws) {
  for (const s of ['', '/claudes', '/terminals', '/pools', '/secrets', '/preflight', '/claude-login', '/account']) urls.add(`/api/workspaces/${w.id}${s}`);
  urls.add(`/api/mcp/workspaces/${w.id}`);
  urls.add(`/api/mcp/workspaces/${w.id}/matchers`);
  urls.add(`/api/skills/workspaces/${w.id}`);
  urls.add(`/api/chat/claudes?workspaceId=${w.id}`);
  urls.add(`/api/chat/trust/scan?workspaceId=${w.id}&folder=/home/node`);
}
const types = (await call('GET', '/api/pools')).data?.types ?? [];
for (const t of types) {
  const type = t.type ?? t;
  urls.add(`/api/pools/${type}`);
  for (const p of (await call('GET', `/api/pools/${type}`)).data ?? []) urls.add(`/api/pools/${type}/${p.id}`);
}
for (const s of (await call('GET', '/api/chat/sessions')).data ?? []) {
  urls.add(`/api/chat/sessions/${s.id}`);
  if (!process.argv.includes('--skip-events')) urls.add(`/api/chat/sessions/${s.id}/events?after=0`);
  for (const p of ['tasks', 'files', 'diff']) urls.add(`/api/chat/sessions/${s.id}/${p}`);
}
for (const e of (await call('GET', '/api/mcp/catalog')).data ?? []) urls.add(`/api/mcp/catalog/${e.id}`);
let hits = 0;
for (const u of urls) {
  const r = await call('GET', u);
  const hit = needle && r.text.includes(needle);
  if (hit) hits++;
  console.log(String(r.status).padEnd(4), hit ? 'HIT ' : '    ', u);
}
console.log(`${urls.size} endpoints, ${hits} contained the needle`);
