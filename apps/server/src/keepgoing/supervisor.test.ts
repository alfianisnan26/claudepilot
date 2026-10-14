// T-257 items 2 and 3 in docs/dev-sessions/supervisor.mjs (the dev workspace's watchdog until Keep going replaces it): the start cap is per
// root cause and the start-again path works for a harness-caused ending. The script runs its real `watch` round against a fake portal (fetch
// is replaced) and a state folder of its own; times are relative to now, never a fixed date.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'supervisor-test-'));
const PORTAL = 'http://portal.test';
Object.assign(process.env, {
  PORTAL_URL: PORTAL,
  // A sign-in code made at runtime: the fake portal takes any.
  PORTAL_SERVER_CODE: `t${Math.random().toString(36).slice(2, 10)}`,
  STATE_DIR: dir,
  MAIN_FOLDER: dir,
  ROUND_S: '0',
  STAGGER_S: '0',
  DRY_RUN: '0',
});
// Only the orchestrator track is looked at: the other two are paused by their files.
for (const k of ['konfersi', 'event']) writeFileSync(join(dir, `PAUSE-${k}`), '');

const logs: string[] = [];
mock.method(console, 'log', (...a: unknown[]) => void logs.push(a.join(' ')));

/** The fake portal: the one chat of the track, how `/recover` answers, and every call it got. */
const portal = { session: {} as Record<string, unknown>, recover: { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such route' } } } as { status: number; body: unknown }, calls: [] as { method: string; path: string; body: unknown }[] };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const path = url.pathname;
  portal.calls.push({ method, path, body });
  if (path === '/api/login') return json(200, { data: {} }, { 'set-cookie': `s=${Math.random().toString(36).slice(2)}; Path=/` });
  if (path === '/mcp') return json(200, { jsonrpc: '2.0', id: body?.id, result: { content: [] } });
  if (path === '/api/portal-mcp' && method === 'GET') return json(200, { data: { tokens: [] } });
  if (path === '/api/portal-mcp/tokens' && method === 'POST') return json(200, { data: { secret: `fake-${Math.random().toString(36).slice(2)}`, token: { id: 'tok1' } } });
  if (path.startsWith('/api/portal-mcp/tokens/')) return json(200, { data: {} });
  if (path === '/api/chat/trust/scan') return json(200, { data: { trusted: true } });
  if (path === '/api/keepgoing') return json(200, { data: { pauses: [] } });
  if (path === '/api/chat/claudes') return json(200, { data: [{ name: 'hasyim', id: 'c-hasyim' }] });
  if (path === '/api/claude-usage') return json(200, { data: { claudes: [] } });
  if (path === '/api/chat/sessions' && method === 'GET') return json(200, { data: [portal.session] });
  if (path === '/api/chat/sessions' && method === 'POST') return json(200, { data: { id: 'new-1', cwd: dir } });
  if (path === '/api/chat/sessions/new-1') return json(200, { data: { id: 'new-1', state: 'idle', mode: 'bypassPermissions' } });
  if (path === '/api/chat/reauth' || path.endsWith('/bypass')) return json(200, { data: {} });
  if (path.endsWith('/recover')) return json(portal.recover.status, portal.recover.body);
  if (path === '/api/tickets' && method === 'POST') return json(200, { data: { id: 'T-900' } });
  return json(404, { error: { code: 'NOT_FOUND', message: `fake portal: no ${method} ${path}` } });
}) as typeof fetch;

const sup = (await import(pathToFileURL(resolve(import.meta.dirname, '../../../../docs/dev-sessions/supervisor.mjs')).href)) as {
  harmlessEnding: (s: unknown) => boolean;
  watch: (o: { rounds: number }) => Promise<void>;
  STATE_FILE: string;
};

const H = 3_600_000;
const TITLE = 'Orchestrator: ClaudePilot dev';
/** The track's chat, ended for integrity. `endedFor` absent: a portal before T-136 slice 2 (the classification is not live). */
const ended = (reason: string, endedFor?: { classified: 'harmless' | 'suspicious'; case: string }) => ({
  id: 'old-1',
  title: TITLE,
  state: 'ended',
  endedReason: `integrity: ${reason}`,
  ...(endedFor ? { endedFor: { reason, origin: 'x', ...endedFor } } : {}),
  createdAt: new Date(Date.now() - 2 * H).toISOString(),
  lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
  archivedAt: null,
  cwd: dir,
  claudeId: 'c-hasyim',
});
const DUPLICATE = 'a second control response for request r-1a2b3c';
const PEER = 'a message this portal didn’t send reached Claude Code (u-1a2b, origin peer)';
/** Starts already made in the last 24 h, `harmless` of them after harmless endings. */
const seed = (starts: number, harmless = 0) => {
  const at = Array.from({ length: starts }, (_, i) => Date.now() - (starts - i) * H); // oldest first, as the script keeps them
  writeFileSync(sup.STATE_FILE, JSON.stringify({ tracks: { orchestrator: { key: 'orchestrator', sessionId: 'old-1', starts: at, harmless: at.slice(0, harmless), nudges: [], wakes: [] } } }));
};
const track = () => JSON.parse(readFileSync(sup.STATE_FILE, 'utf8')).tracks.orchestrator;
const created = () => portal.calls.filter((c) => c.method === 'POST' && c.path === '/api/chat/sessions');
const tickets = () => portal.calls.filter((c) => c.method === 'POST' && c.path === '/api/tickets');
const recovers = () => portal.calls.filter((c) => c.path.endsWith('/recover'));

beforeEach(() => {
  portal.calls.length = 0;
  logs.length = 0;
  portal.recover = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such route' } } };
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('the classification: the portal’s endedFor decides; a legacy row is harmless only for the duplicate control response', () => {
  assert.equal(sup.harmlessEnding(ended(DUPLICATE)), true);
  assert.equal(sup.harmlessEnding(ended(PEER, { classified: 'harmless', case: 'replay-peer' })), true);
  // A peer line no task of the process sent ends with the same words and is suspicious (replay-peer-unknown): never harmless.
  assert.equal(sup.harmlessEnding(ended(PEER, { classified: 'suspicious', case: 'replay-peer-unknown' })), false);
  assert.equal(sup.harmlessEnding(ended(PEER)), false);
  assert.equal(sup.harmlessEnding(ended('a second, different control response for request r-1')), false);
  assert.equal(sup.harmlessEnding(ended(DUPLICATE, { classified: 'suspicious', case: 'unknown' })), false, 'the portal’s word beats the reason');
  assert.equal(sup.harmlessEnding({ ...ended(DUPLICATE), endedReason: 'process exited (code 1)' }), false);
  assert.equal(sup.harmlessEnding(undefined), false);
});

test('a harmless ending is recovered in place first: no new chat, no start counted, no report', async () => {
  seed(3);
  portal.session = ended(DUPLICATE, { classified: 'harmless', case: 'control-duplicate' });
  portal.recover = { status: 200, body: { data: { id: 'old-1' } } };
  await sup.watch({ rounds: 1 });
  assert.equal(recovers().length, 1);
  assert.deepEqual(recovers()[0]?.body, { by: 'agent' });
  assert.equal(created().length, 0);
  assert.equal(tickets().length, 0);
  assert.equal(track().starts.length, 3);
});

test('item 3: T-136 not live (no recover route, no classification) and the integrity cap reached: a harness-caused ending still starts again, counted apart', async () => {
  seed(3); // three starts after real integrity endings: the cap of 3 for the chat's own causes
  portal.session = ended(DUPLICATE);
  await sup.watch({ rounds: 1 });
  assert.equal(recovers().length, 1, 'recover in place is tried first');
  assert.equal(created().length, 1, 'then a new session continues it');
  assert.equal((created()[0]?.body as { continuedFrom?: string }).continuedFrom, 'old-1');
  assert.equal(tickets().length, 0, 'nothing is reported: the track is not down');
  const ts = track();
  assert.equal(ts.sessionId, 'new-1');
  assert.equal(ts.starts.length, 4);
  assert.deepEqual(ts.harmless, [ts.starts[3]], 'the start is counted after a harmless ending, not against the cap');
});

test('negative twin: the same cap reached for a real root cause still stops AND raises the report, once', async () => {
  seed(3);
  // The words of a harmless peer ending, but the portal says no task of this process sent it: a real cause.
  portal.session = ended(PEER, { classified: 'suspicious', case: 'replay-peer-unknown' });
  portal.recover = { status: 409, body: { error: { code: 'RECOVER_SUSPICIOUS', message: 'a person must look' } } };
  await sup.watch({ rounds: 1 });
  assert.equal(created().length, 0, 'no new chat past the cap');
  assert.equal(tickets().length, 1);
  const t = tickets()[0]?.body as { priority: string; tags: string[]; summary: string; description: string };
  assert.equal(t.priority, 'high');
  assert.deepEqual(t.tags, ['watchdog']);
  assert.match(t.summary, /left down \(start_cap\)/);
  assert.doesNotMatch(t.description, new RegExp(process.env.PORTAL_SERVER_CODE ?? '\u0000'), 'the code is never in the ticket');
  assert.ok(logs.some((l) => /too many starts in 24 h \(3, 0 after harmless endings\)/.test(l)));
  assert.equal(track().starts.length, 3);

  portal.calls.length = 0;
  await sup.watch({ rounds: 1 });
  assert.equal(created().length, 0);
  assert.equal(tickets().length, 0, 'the same cause is not reported again while it stands');
  assert.equal(recovers().length, 0, 'a refused recover of the same ending is not asked again');
});

test('harmless starts do not count against the chat’s cap, but have a ceiling of their own that stops and reports', async () => {
  // Five starts in 24 h, all after harmless endings: under the old count (all five) a real cause would be capped; per root cause it is 0.
  seed(5, 5);
  portal.session = ended('a tool request id arrived twice (r-1)', { classified: 'suspicious', case: 'request-duplicate' });
  await sup.watch({ rounds: 1 });
  assert.equal(created().length, 1, 'a real cause with no starts of its own is started again');
  assert.equal(tickets().length, 0);

  portal.calls.length = 0;
  seed(12, 12); // MAX_HARMLESS_STARTS (12) after harmless endings: a loop of them
  portal.session = ended(DUPLICATE);
  await sup.watch({ rounds: 1 });
  assert.equal(created().length, 0, 'the harmless loop stops');
  assert.equal(tickets().length, 1, 'and is reported');
});
