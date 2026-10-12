// The in-container stand-in for api.anthropic.com (docs/prd/claude-version-pinning.md §11), run here with the machine's own Node: what it answers,
// what it logs (header NAMES only), the proxy that lets one host through, and the steps a canary check scripts. Needs `openssl`.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CANARY_STANDIN } from './standin.js';

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const opts = { skip: hasOpenssl ? false : 'needs the openssl command' };

let dir: string;
let child: ChildProcess;
let http: string;
let proxy: { host: string; port: number };
let ca: string;
const script = (s: Record<string, unknown>) => writeFileSync(join(dir, 'state', 'script.json'), JSON.stringify(s));
const logged = () => readFileSync(join(dir, 'state', 'requests.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${http}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

before(async () => {
  if (!hasOpenssl) return;
  dir = mkdtempSync(join(tmpdir(), 'cp-standin-'));
  writeFileSync(join(dir, 'standin.cjs'), CANARY_STANDIN);
  execFileSync('mkdir', ['-p', join(dir, 'state')]);
  writeFileSync(join(dir, 'state', 'script.json'), '{}');
  child = spawn(process.execPath, [join(dir, 'standin.cjs'), join(dir, 'state')], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync(join(dir, 'state', 'ready.json')); i++) await new Promise((r) => setTimeout(r, 100));
  const ready = JSON.parse(readFileSync(join(dir, 'state', 'ready.json'), 'utf8')) as { proxy: string; http: string; ca: string };
  http = ready.http;
  ca = ready.ca;
  const u = new URL(ready.proxy);
  proxy = { host: u.hostname, port: Number(u.port) };
});
after(() => {
  child?.kill('SIGKILL');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('it listens on the loopback only and writes where; the throwaway CA exists', opts, () => {
  assert.match(http, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(existsSync(ca) && ca.endsWith('ca.pem'));
});

test('usage and unscripted paths: scripted answers, 404 when not scripted, `{}` otherwise; request logs hold header NAMES only', opts, async () => {
  assert.equal((await fetch(`${http}/api/oauth/usage`)).status, 404);
  script({ usage: { body: { five_hour: { utilization: 41 } }, headers: { 'x-test': '1' } } });
  const r = await fetch(`${http}/api/oauth/usage`, { headers: { authorization: 'Bearer FAKE-secret-value' } });
  assert.deepEqual(await r.json(), { five_hour: { utilization: 41 } });
  assert.equal(r.headers.get('x-test'), '1');
  assert.deepEqual(await (await fetch(`${http}/api/oauth/profile`)).json(), {});
  const seen = logged().filter((l) => String(l.path).startsWith('/api/oauth/usage'));
  assert.ok((seen.at(-1)!.headers as string[]).includes('authorization'));
  assert.ok(!JSON.stringify(logged()).includes('FAKE-secret-value'), 'a header value is never logged');
  script({ routes: [{ prefix: '/v1/mcp_servers', status: 201, body: { data: [] } }] });
  const route = await fetch(`${http}/v1/mcp_servers?limit=1`);
  assert.deepEqual([route.status, await route.json()], [201, { data: [] }]);
});

test('messages: a text reply streams as the Messages API does, and JSON when the request is not a stream', opts, async () => {
  script({ messages: { text: 'hello canary', headers: { 'anthropic-ratelimit-unified-status': 'allowed' } } });
  const stream = await post('/v1/messages?beta=true', { model: 'm', stream: true, tools: [{ name: 'Bash' }], messages: [] });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  assert.equal(stream.headers.get('anthropic-ratelimit-unified-status'), 'allowed');
  const events = (await stream.text()).split('\n\n').filter(Boolean).map((e) => /^event: (\S+)/.exec(e)![1]);
  assert.deepEqual(events, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  const json = await (await post('/v1/messages', { model: 'm', messages: [] })).json() as { content: { text: string }[]; usage: { input_tokens: number } };
  assert.equal(json.usage.input_tokens, 12, 'a non-streaming request gets JSON with usage (the model switch reads it)');
  assert.equal(json.content[0]!.text, 'ok', 'a request that offers no tools gets "ok" unless the script says always');
  script({ messages: { text: 'always this', always: true } });
  assert.equal(((await (await post('/v1/messages', { model: 'm', messages: [] })).json()) as { content: { text: string }[] }).content[0]!.text, 'always this');
});

test('steps: consumed in order by requests that offer tools; a changed list starts over; a 429 is an error body with its headers', opts, async () => {
  const ask = async (tools = true) => (await (await post('/v1/messages', { model: 'm', stream: false, tools: tools ? [{ name: 'Bash' }] : [], messages: [] })).json()) as { content: { type: string; text?: string; name?: string; input?: unknown }[]; stop_reason: string };
  script({ id: 'a', steps: [{ tool: 'Bash', input: { command: 'ls' } }, { text: 'second' }] });
  const first = await ask();
  assert.deepEqual([first.stop_reason, first.content[0]!.name, first.content[0]!.input], ['tool_use', 'Bash', { command: 'ls' }]);
  assert.equal((await ask(false)).content[0]!.text, 'ok', 'a request with no tools does not use up a step');
  assert.equal((await ask()).content[0]!.text, 'second');
  assert.equal((await ask()).content[0]!.text, 'done', 'past the end: done');
  script({ id: 'b', steps: [{ tool: 'Bash', input: { command: 'pwd' } }] });
  assert.equal((await ask()).content[0]!.input && (await ask()).content[0]!.text, 'done', 'a new id starts the list from its first step');
  script({ id: 'c', messages: { status: 429, headers: { 'retry-after': '3600' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } } });
  const limited = await post('/v1/messages', { model: 'm', stream: true, tools: [{ name: 'Bash' }], messages: [] });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '3600');
  assert.equal(((await limited.json()) as { error: { message: string } }).error.message, 'slow down');
});

test('the tool results the CLI sends back are logged for assertions, clipped', opts, async () => {
  script({ messages: { text: 'x' } });
  await post('/v1/messages', { model: 'claude-sonnet-4-5', stream: false, tools: [{ name: 'Bash' }], messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'File is in a directory that is denied' }] }] });
  const last = logged().filter((l) => String(l.path).startsWith('/v1/messages')).at(-1)!;
  assert.deepEqual(last.toolResults, [{ error: true, content: '"File is in a directory that is denied"' }]);
  assert.deepEqual([last.model, last.tools, last.stream], ['claude-sonnet-4-5', ['Bash'], false]);
});

test('the proxy lets api.anthropic.com through to the stand-in and refuses every other host (and says so in the log)', opts, async () => {
  const connectTo = (target: string) =>
    new Promise<string>((resolve) => {
      const socket = connect(proxy.port, proxy.host, () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      socket.once('data', (d) => (socket.destroy(), resolve(d.toString('utf8').split('\r\n')[0]!)));
      socket.on('error', () => resolve('error'));
    });
  assert.equal(await connectTo('api.anthropic.com:443'), 'HTTP/1.1 200 Connection Established');
  assert.equal(await connectTo('example.com:443'), 'HTTP/1.1 403 Forbidden');
  assert.equal(await connectTo('169.254.169.254:80'), 'HTTP/1.1 403 Forbidden');
  const refused = logged().filter((l) => l.method === 'CONNECT-REFUSED').map((l) => l.path);
  assert.deepEqual(refused, ['example.com:443', '169.254.169.254:80']);
});
