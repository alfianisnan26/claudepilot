// T-3542: the dispatcher Worker and its Scheduler Durable Object in workerd: auth on every route, the spec check, queue (429), budget
// (402), release into the ledger. The test configuration has no container application, so a job that is let in fails to start (503)
// and its slot is given back: that path is checked too. The container side is covered by the live smoke (README.md).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sha256Hex, sign } from '../src/auth';
import worker, { type Env, parseSpec } from '../src/index';

const E = env as unknown as Env;
const KEY = 'a'.repeat(64); // the test binding in vitest.config.ts
let seq = 0;
const jobId = (size: 's' | 'b' = 's') => `cp-cf-${size}${(0x10000000 + ++seq).toString(16)}`;
const spec = (over: Record<string, unknown> = {}) => ({
  id: jobId(),
  repoUrl: 'https://gitlab.com/memorid/platforms/root.git',
  ref: 'stg',
  subs: [{ path: 'apps/api', ref: 'wave/x' }],
  steps: 'npm-ci',
  cmd: btoa('echo hi'),
  artifacts: 'reports',
  timeout: 600,
  chat: 'chat-a',
  role: 'lane',
  program: 'memorid',
  ...over,
});

async function call(method: string, path: string, body?: unknown, opts: { key?: string; ws?: string; ts?: number } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = await sign(opts.key ?? KEY, method, path, ts, await sha256Hex(raw));
  const req = new Request(`https://cp-jobrun-dispatcher.test${path}`, {
    method,
    body: body === undefined ? undefined : raw,
    headers: { 'x-jobrun-key': opts.ws ?? 'kohilabs', 'x-jobrun-ts': ts, 'x-jobrun-sig': sig },
  });
  return worker.fetch(req, E);
}

describe('auth', () => {
  it('every route but /health needs a good signature (401 otherwise)', async () => {
    expect((await worker.fetch(new Request('https://d.test/health'), E)).status).toBe(200);
    expect((await worker.fetch(new Request('https://d.test/jobs', { method: 'POST', body: '{}' }), E)).status).toBe(401);
    expect((await call('POST', '/jobs', spec(), { key: 'b'.repeat(64) })).status).toBe(401);
    expect((await call('POST', '/jobs', spec(), { ws: 'konfersi' })).status).toBe(401);
    expect((await call('GET', '/jobs?chat=x', undefined, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await call('GET', '/jobs?chat=x')).status).toBe(200);
  });
});

describe('spec', () => {
  it('refuses anything outside the GitLab group, an odd ref, path or label, and a timeout over the 60-minute cap', () => {
    const bad = [
      { repoUrl: 'https://gitlab.com/other/root.git' },
      { repoUrl: 'https://github.com/memorid/root.git' },
      { repoUrl: 'https://gitlab.com/memorid/../x.git' },
      { ref: '-x' },
      { ref: 'a..b' },
      { subs: [{ path: '../etc', ref: 'stg' }] },
      { steps: 'yarn' },
      { cmd: 'not base64!' },
      { artifacts: '../x' },
      { timeout: 3601 },
      { timeout: 30 },
      { chat: 'Chat A' },
      { id: 'claudepilot-job-01234567' },
      { creds: { user: 'oauth2', token: 'short' } },
    ];
    for (const b of bad) expect(typeof parseSpec(spec(b), E, 'kohilabs'), JSON.stringify(b)).toBe('string');
    const ok = parseSpec(spec({ creds: { user: 'oauth2', token: 'x'.repeat(30) } }), E, 'kohilabs');
    expect(typeof ok).toBe('object');
  });
  it('a bad spec is a 400 and starts nothing', async () => {
    const r = await call('POST', '/jobs', spec({ repoUrl: 'https://gitlab.com/other/x.git' }));
    expect(r.status).toBe(400);
  });
});

describe('scheduler', () => {
  const sch = () => E.SCHEDULER.get(E.SCHEDULER.idFromName(`t-${++seq}`));
  it('queue: the cap holds (429 with the reason), a release lets the next in', async () => {
    const s = sch();
    const now = Date.parse('2026-11-03T10:00:00Z');
    await s.setClock(now);
    const a = { workspace: 'kohilabs', program: 'memorid', size: 'std' as const };
    expect((await s.admit({ ...a, id: 'cp-cf-s00000001', chat: 'c1' })).kind).toBe('go');
    // MAX_PER_CHAT is 1 in wrangler.test.jsonc
    expect(await s.admit({ ...a, id: 'cp-cf-s00000002', chat: 'c1' })).toMatchObject({ kind: 'wait', reason: 'at most 1 per chat' });
    // c2 goes past the older c1 waiter, which its own chat cap holds (no head-of-line blocking)
    expect((await s.admit({ ...a, id: 'cp-cf-s00000003', chat: 'c2' })).kind).toBe('go');
    // MAX_AT_ONCE is 2: a third chat waits for a slot
    expect(await s.admit({ ...a, id: 'cp-cf-s00000004', chat: 'c3' })).toMatchObject({ kind: 'wait', reason: 'at most 2 at once' });
    expect(await s.release('cp-cf-s00000001', 0.01, 'memorid')).toBe(true);
    expect(await s.release('cp-cf-s00000001', 0.01, 'memorid')).toBe(false); // idempotent
    // c1's waiter is older than c3's: it takes the freed slot first
    expect(await s.admit({ ...a, id: 'cp-cf-s00000004', chat: 'c3' })).toMatchObject({ kind: 'wait', reason: 'older jobs first' });
    expect((await s.admit({ ...a, id: 'cp-cf-s00000002', chat: 'c1' })).kind).toBe('go');
    expect((await s.snapshot()).ledger.total).toBeCloseTo(0.01, 9);
  });
  it('budget: over $5 today new jobs are refused (402 kind), the next UTC day starts at zero', async () => {
    const s = sch();
    const now = Date.parse('2026-11-03T23:00:00Z');
    await s.setClock(now);
    const a = { workspace: 'kohilabs', chat: 'c1', program: 'memorid', size: 'std' as const };
    expect((await s.admit({ ...a, id: 'cp-cf-s00000011' })).kind).toBe('go');
    await s.release('cp-cf-s00000011', 5.2, 'memorid');
    expect(await s.admit({ ...a, id: 'cp-cf-s00000012' })).toMatchObject({ kind: 'budget', scope: 'total', limitUsd: 5 });
    await s.setClock(Date.parse('2026-11-04T00:00:05Z'));
    expect((await s.admit({ ...a, id: 'cp-cf-s00000012' })).kind).toBe('go');
  });
});

describe('POST /jobs', () => {
  it('no container in the test config: the start fails (503) and the slot is given back, so the next job is not held', async () => {
    const r = await call('POST', '/jobs', spec({ chat: 'c-start' }));
    expect(r.status).toBe(503);
    const r2 = await call('POST', '/jobs', spec({ chat: 'c-start' }));
    expect(r2.status).toBe(503); // not 429: the first one's slot was released
    const snap = await E.SCHEDULER.get(E.SCHEDULER.idFromName('global')).snapshot();
    expect(snap.active.length).toBe(0);
  });
  it('a job of another workspace is not found (404), never shown', async () => {
    expect((await call('GET', `/jobs/${jobId()}`)).status).toBe(404);
    expect((await call('GET', '/jobs/not-a-job')).status).toBe(404);
  });
});
