// Robustness fuzz over EVERY mutating /api route the app registers: hostile and malformed JSON bodies and path parameters, signed in.
// Looks for what must never happen: a 5xx, a stack trace or an internal path in an answer, a non-JSON answer, a hang.
//   cd apps/server && npx tsx ../../tools/qa/fuzz-api.mts          (QA_PORT / QA_CODE as in lib.mjs; QA portal running)
// Skips what would change the portal itself (sign-in, server code, key setup) and uses made-up ids for workspaces, so nothing real is touched;
// objects it creates are named "qa-fuzz-*" and removed at the end.
import { request } from 'node:http';
import { createApp } from '../../apps/server/src/app.ts';
import { api, login } from './lib.mjs';

const stub: object = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
  set: () => true,
});
const make = createApp as unknown as (...a: unknown[]) => { routes: { method: string; path: string }[] };
// Every optional module is stubbed too, so the route list is the whole API (a module added later is fuzzed without anyone editing this).
const app = make({ session: () => undefined, enabled: true }, stub, stub, stub, stub, stub, stub, stub, {
  serveWeb: false, poolService: stub, mcp: stub, skills: stub, personas: stub, settings: stub, portalMcp: stub, tickets: stub, ci: stub, knowledge: stub, browser: stub, claudeUsage: stub,
});

const call = api(await login());
const SKIP = [/^\/api\/admin\//, /^\/api\/login$/, /^\/api\/logout$/];
const routes: { method: string; path: string }[] = [];
const seen = new Set<string>();
for (const r of app.routes) {
  const key = `${r.method} ${r.path}`;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) || r.path.includes('*') || seen.has(key) || SKIP.some((s) => s.test(r.path))) continue;
  seen.add(key);
  routes.push(r);
}

// Leftovers of an earlier run (it may have been stopped half way).
{
  const overview = (await call('GET', '/api/accounts')).data as { endpoints: { id: string; name: string }[]; accounts: { id: string; name: string }[] };
  for (const p of ((await call('GET', '/api/account-pools')).data ?? []) as { id: string; name: string }[]) if (p.name.startsWith('qa-fuzz-')) await call('DELETE', `/api/account-pools/${p.id}`);
  for (const a of overview?.accounts ?? []) if (a.name.startsWith('qa-fuzz-')) await call('DELETE', `/api/accounts/${a.id}`);
  for (const e of overview?.endpoints ?? []) if (e.name.startsWith('qa-fuzz-')) await call('DELETE', `/api/endpoints/${e.id}`);
  for (const p of ((await call('GET', '/api/pools/secrets')).data ?? []) as { id: string; name: string }[]) if (p.name.startsWith('qa-fuzz-')) await call('DELETE', `/api/pools/secrets/${p.id}`);
}

/** Real scratch objects, so validation that runs after the existence check gets exercised. */
const made: Record<string, string> = {};
const create = async (what: string, path: string, body: unknown, pick = (d: any) => d?.id) => {
  const r = await call('POST', path, body);
  if (r.status < 300) made[what] = pick(r.data);
  else console.log(`(no scratch ${what}: ${r.status} ${r.body?.error?.message ?? ''})`);
};
await create('endpoint', '/api/endpoints', { name: 'qa-fuzz-ep', baseUrl: 'http://127.0.0.1:4599', allowPrivateNetwork: true });
if (made.endpoint) {
  await create('account', '/api/accounts', { name: 'qa-fuzz-acct', endpointId: made.endpoint, key: 'sk-ant-qa-fuzz-key-00000000000000000001', confirmOwned: true });
  if (made.account) await create('pool', '/api/account-pools', { name: 'qa-fuzz-pool', endpointId: made.endpoint, members: [made.account] });
}
await create('secrets', '/api/pools/secrets', { name: 'qa-fuzz-secrets', content: { entries: [{ kind: 'variable', name: 'QA_FUZZ', value: 'x' }] } });
const sessions = (await call('GET', '/api/chat/sessions')).data as { id: string; title: string }[];
made.session = sessions.find((s) => s.title.startsWith('QA bulk'))?.id ?? sessions[0]?.id ?? 'x';

const FAKE = 'qa-fuzz-nothing';
function fill(path: string): string {
  return path.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    if (name === 'target') return 'docker';
    if (path.startsWith('/api/workspaces')) return FAKE;
    if (path.startsWith('/api/accounts') && name === 'id') return made.account ?? FAKE;
    if (path.startsWith('/api/endpoints') && name === 'id') return made.endpoint ?? FAKE;
    if (path.startsWith('/api/account-pools') && name === 'id') return made.pool ?? FAKE;
    if (path.startsWith('/api/pools/') && name === 'type') return 'secrets';
    if (path.startsWith('/api/pools/') && name === 'id') return made.secrets ?? FAKE;
    if (path.startsWith('/api/chat/sessions') && name === 'id') return made.session ?? FAKE;
    if (name === 'rev') return '1';
    return FAKE;
  });
}

const deep = (n: number) => '['.repeat(n) + ']'.repeat(n);
const PAYLOADS: [string, string][] = [
  ['empty object', '{}'],
  ['array', '[]'],
  ['null', 'null'],
  ['string', '"x"'],
  ['number', '123'],
  ['broken json', '{"name":'],
  ['empty body', ''],
  ['nulls', '{"name":null,"id":null,"key":null,"title":null,"content":null,"entries":null,"members":null}'],
  ['numbers as text', '{"name":12345,"title":99,"key":true,"description":{},"members":"abc","content":"x","entries":5}'],
  ['operators', '{"name":{"$ne":1},"title":{"$gt":""},"key":["a"],"members":{"0":"x"}}'],
  ['proto', '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"name":"x"}'],
  ['nul and controls', '{"name":"a\\u0000b\\u0007c\\u202e","title":"\\u0000","description":"\\ud800"}'],
  ['long strings', JSON.stringify({ name: 'A'.repeat(200_000), title: 'B'.repeat(200_000), description: 'C'.repeat(200_000), key: 'D'.repeat(200_000) })],
  ['html', '{"name":"<img src=x onerror=alert(1)>","title":"<script>x</script>","description":"\\"><svg onload=1>"}'],
  ['big numbers', '{"cpus":1e999,"memoryMb":-1,"count":9007199254740993,"limit":-1e308,"afterSeq":"NaN","budgetUsd":1e400}'],
  ['arrays', JSON.stringify({ members: Array.from({ length: 5000 }, (_, i) => `m${i}`), entries: Array.from({ length: 3000 }, (_, i) => ({ kind: 'variable', name: `V${i}`, value: 'x' })), workspaceIds: Array.from({ length: 3000 }, (_, i) => `docker/w${i}`), items: Array.from({ length: 3000 }, () => ({})) })],
  ['deep nesting', `{"content":${deep(3000)},"entries":${deep(3000)}}`],
  ['unicode', JSON.stringify({ name: '😀'.repeat(10), title: 'กำ', description: 'é', rtl: '\u202eabc', zw: 'a\u200bb' })],
  ['path-like', '{"name":"../../etc/passwd","path":"/etc/passwd","cwd":"../../..","folder":"/proc/self/environ","workspaceId":"docker/../../x","claudeId":"../../x","poolId":"../x"}'],
  ['urls', '{"baseUrl":"file:///etc/passwd","url":"http://169.254.169.254/latest/meta-data/","spec":{"url":"gopher://x"}}'],
  ['sql-ish', '{"name":"x\' OR 1=1; DROP TABLE accounts;--","title":"\\"; DROP TABLE chat_sessions;--"}'],
];
// A workspace id that arrives in a body or a query ends up in Docker API URLs, tmux names and the database like one from a path does (QA-029).
// A route that answers 2xx and gives the value back has accepted it.
const HOSTILE_IDS = ['docker/x%2f..%2f..%2fcontainers', '../x', 'docker/a%00b', "docker/x'--", `docker/${'x'.repeat(100)}`, 'docker/a%3Fb', 'docker/a b'];
// (A segment that is exactly `..` is resolved by the client before it is sent, so it is not a parameter value.)
const PARAMS = [FAKE, 'a%00b', 'x'.repeat(4000), '😀', '%', '..%2f..%2fetc%2fpasswd', "x'--"];

interface Finding { route: string; case: string; status: number; why: string; sample: string }
const findings: Finding[] = [];
let sent = 0;
const t0 = Date.now();

async function fire(method: string, route: string, url: string, label: string, body: string | undefined, hostileId?: string) {
  sent++;
  const started = Date.now();
  let status = 0;
  let text = '';
  let type = '';
  try {
    // A fresh connection per request: a server that answers before it has read a big body (every 404/401/413 does) resets the
    // connection a moment later, which is not what this tool is looking for.
    const out = await new Promise<{ status: number; type: string; text: string }>((resolve, reject) => {
      const data = method === 'DELETE' && body === undefined ? undefined : body;
      const origin = `http://localhost:${process.env.QA_PORT ?? 3101}`;
      const req = request(origin + url, { method, agent: false, timeout: 20_000, headers: { cookie: `portal_session=${cookieValue}`, origin, connection: 'close', ...(data !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end(data);
    });
    status = out.status;
    type = out.type;
    text = out.text;
  } catch (e) {
    findings.push({ route, case: label, status: 0, why: `no answer (${(e as Error).message}) after ${Date.now() - started} ms`, sample: '' });
    return;
  }
  const ms = Date.now() - started;
  const bad: string[] = [];
  if (status >= 500) bad.push(`HTTP ${status}`);
  if (/\n\s+at [^\n]+\(|\bat .*\.(ts|js):\d+|node_modules|\/workspaces\/|ERR_[A-Z_]+|SQLITE|SqliteError|TypeError|ReferenceError|RangeError|\[object Object\]|undefined/i.test(text)) {
    const m = /\n\s+at [^\n]+\(|\bat .*\.(ts|js):\d+|node_modules|\/workspaces\/|ERR_[A-Z_]+|SQLITE|SqliteError|TypeError|ReferenceError|RangeError|\[object Object\]|undefined/i.exec(text);
    bad.push(`leaks "${m?.[0].slice(0, 40)}"`);
  }
  if (!type.includes('json') && status !== 404) bad.push(`content-type ${type || 'none'}`);
  if (ms > 8000) bad.push(`slow ${ms} ms`);
  if (hostileId && status < 300 && text.includes(hostileId)) bad.push('accepted a workspace id that is not <target>/<name> of plain names');
  if (bad.length) findings.push({ route, case: label, status, why: bad.join(', '), sample: text.slice(0, 160).replace(/\s+/g, ' ') });
}

let cookieValue = await login();

for (const r of routes) {
  const route = `${r.method} ${r.path}`;
  const url = fill(r.path);
  if (r.method === 'DELETE') {
    // Only the made-up ids: a delete of a real scratch object would end the fuzz of its other routes.
    await fire(r.method, route, url.replace(/qa-fuzz-nothing|[0-9a-f]{8}-[0-9a-f-]{27}/g, FAKE), 'fake id', undefined);
    for (const p of PARAMS) await fire(r.method, route, r.path.replace(/:([A-Za-z]+)/g, (_m, n) => (n === 'target' ? 'docker' : p)), `param ${JSON.stringify(p).slice(0, 20)}`, undefined);
    continue;
  }
  for (const [label, body] of PAYLOADS) await fire(r.method, route, url, label, body);
  for (const id of HOSTILE_IDS) await fire(r.method, route, url, `workspace id ${JSON.stringify(id).slice(0, 24)}`, JSON.stringify({ workspaceId: id, workspaceIds: [id], workspace: id, workspaces: [id] }), id);
  for (const p of PARAMS) await fire(r.method, route, r.path.replace(/:([A-Za-z]+)/g, (_m, n) => (n === 'target' ? 'docker' : p)), `param ${JSON.stringify(p).slice(0, 20)}`, '{}');
}

// Clean up what it made.
for (const [path, id] of [['/api/account-pools/', made.pool], ['/api/accounts/', made.account], ['/api/pools/secrets/', made.secrets], ['/api/endpoints/', made.endpoint]] as const) if (id) await call('DELETE', path + id);
console.log(`${routes.length} mutating routes, ${sent} requests in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${findings.length} findings`);
const byRoute = new Map<string, Finding[]>();
for (const f of findings) byRoute.set(f.route, [...(byRoute.get(f.route) ?? []), f]);
for (const [route, list] of byRoute) {
  console.log(`\n${route}  (${list.length})`);
  for (const f of list.slice(0, 4)) console.log(`   [${f.case}] ${f.status} ${f.why} :: ${f.sample}`);
}
