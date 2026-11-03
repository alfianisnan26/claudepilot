// T-3542: the dispatcher's pure rules (admission, budget, egress, request signing). Runs in workerd (vitest-pool-workers).
import { describe, expect, it } from 'vitest';
import { sha256Hex, sign, verify } from '../src/auth';
import {
  type Active,
  admit,
  costUsd,
  DEFAULT_ALLOW,
  gitReadWithCredential,
  hostAllowed,
  type Ledger,
  type Limits,
  sizeOfId,
  spent,
  utcDay,
} from '../src/policy';

const LIM: Limits = { max: 3, perChat: 2, perProgram: 3, budgetUsdDay: 5, programUsdDay: 3 };
const T0 = Date.parse('2026-11-03T10:00:00Z');
const ledger = (total = 0, byProgram: Record<string, number> = {}): Ledger => ({ day: utcDay(T0), total, byProgram });
const act = (id: string, chat = 'c1', program = 'memorid', since = T0): Active => ({ id, chat, program, size: 'std', since });

describe('cost', () => {
  it('prices a std (standard-3) second at about $0.000041 and a big one higher; never negative', () => {
    expect(costUsd('std', 1)).toBeCloseTo(0.0000411, 7);
    expect(costUsd('big', 1)).toBeGreaterThan(costUsd('std', 1));
    expect(costUsd('std', -5)).toBe(0);
    // A 60-minute std job, the per-job cap: about $0.15 (plan §4.6).
    expect(costUsd('std', 3600)).toBeGreaterThan(0.14);
    expect(costUsd('std', 3600)).toBeLessThan(0.16);
  });
  it('counts running jobs from their start (or midnight UTC) and resets the ledger on a new day', () => {
    const a = [act('cp-cf-s00000001', 'c1', 'memorid', T0 - 600_000)];
    expect(spent(ledger(1), a, T0)).toBeCloseTo(1 + costUsd('std', 600), 9);
    const tomorrow = Date.parse('2026-11-04T00:10:00Z');
    expect(spent(ledger(4.9), a, tomorrow)).toBeCloseTo(costUsd('std', 600), 9); // yesterday's 4.9 is gone; the job counts from 00:00
  });
});

describe('admit', () => {
  const req = { id: 'cp-cf-s0000000a', chat: 'c9', program: 'memorid' };
  it('goes when there is room', () => {
    expect(admit(req, [], [], ledger(), LIM, T0)).toEqual({ kind: 'go' });
  });
  it('refuses (never waits) over the daily budget, total or per program', () => {
    expect(admit(req, [], [], ledger(5), LIM, T0)).toMatchObject({ kind: 'budget', scope: 'total' });
    expect(admit(req, [], [], ledger(3, { memorid: 3 }), LIM, T0)).toMatchObject({ kind: 'budget', scope: 'program' });
    expect(admit({ ...req, program: 'other' }, [], [], ledger(3, { memorid: 3 }), LIM, T0)).toEqual({ kind: 'go' });
  });
  it('a running job that burns money counts against the budget while it runs', () => {
    const long = [act('cp-cf-s00000001', 'c1', 'memorid', T0 - 20 * 3600_000)];
    // started yesterday: counted from midnight, 10 h of std is about $1.48
    expect(spent(ledger(), long, T0)).toBeGreaterThan(1.4);
    expect(admit(req, long, [], ledger(3.6), LIM, T0)).toMatchObject({ kind: 'budget' });
  });
  it('waits at each cap and says which', () => {
    const three = [act('cp-cf-s00000001', 'a'), act('cp-cf-s00000002', 'b'), act('cp-cf-s00000003', 'c')];
    expect(admit(req, three, [], ledger(), LIM, T0)).toMatchObject({ kind: 'wait', reason: 'at most 3 at once', ahead: 3 });
    const chat = [act('cp-cf-s00000001', 'c9'), act('cp-cf-s00000002', 'c9')];
    expect(admit(req, chat, [], ledger(), LIM, T0)).toMatchObject({ kind: 'wait', reason: 'at most 2 per chat' });
    const prog = [act('cp-cf-s00000001', 'a'), act('cp-cf-s00000002', 'b')];
    expect(admit(req, prog, [], ledger(), { ...LIM, perProgram: 2 }, T0)).toMatchObject({ kind: 'wait', reason: 'at most 2 per program' });
  });
  it('an older live waiter that fits goes first; one that stopped asking (30 s) does not hold the queue', () => {
    const older = [{ id: 'cp-cf-s000000ff', chat: 'c2', program: 'memorid', first: T0 - 5000, seen: T0 - 1000 }];
    expect(admit(req, [], older, ledger(), LIM, T0)).toMatchObject({ kind: 'wait', reason: 'older jobs first' });
    const gone = [{ ...older[0]!, seen: T0 - 31_000 }];
    expect(admit(req, [], gone, ledger(), LIM, T0)).toEqual({ kind: 'go' });
    // an older waiter blocked by its own chat cap does not block another chat
    const blocked = [{ ...older[0]!, chat: 'c1' }];
    const c1full = [act('cp-cf-s00000001', 'c1'), act('cp-cf-s00000002', 'c1')];
    expect(admit(req, c1full, blocked, ledger(), LIM, T0)).toEqual({ kind: 'go' });
  });
});

describe('egress', () => {
  it('allow-list: exact names and *. subdomains only', () => {
    expect(hostAllowed('registry.npmjs.org', DEFAULT_ALLOW)).toBe(true);
    expect(hostAllowed('GitLab.com.', DEFAULT_ALLOW)).toBe(true);
    expect(hostAllowed('evil.example', DEFAULT_ALLOW)).toBe(false);
    expect(hostAllowed('gitlab.com.evil.example', DEFAULT_ALLOW)).toBe(false);
    expect(hostAllowed('a.cdn.test', ['*.cdn.test'])).toBe(true);
    expect(hostAllowed('cdn.test', ['*.cdn.test'])).toBe(false);
  });
  it('the git credential goes to a clone of the group on gitlab.com and to nothing else', () => {
    const u = (s: string) => new URL(s);
    expect(gitReadWithCredential('GET', u('https://gitlab.com/memorid/platforms/root.git/info/refs?service=git-upload-pack'), 'memorid')).toBe(true);
    expect(gitReadWithCredential('POST', u('https://gitlab.com/memorid/platforms/api.git/git-upload-pack'), 'memorid')).toBe(true);
    // a push, the API, another group, another host, plain http, another query: no credential
    expect(gitReadWithCredential('GET', u('https://gitlab.com/memorid/platforms/root.git/info/refs?service=git-receive-pack'), 'memorid')).toBe(false);
    expect(gitReadWithCredential('POST', u('https://gitlab.com/memorid/platforms/root.git/git-receive-pack'), 'memorid')).toBe(false);
    expect(gitReadWithCredential('GET', u('https://gitlab.com/api/v4/projects'), 'memorid')).toBe(false);
    expect(gitReadWithCredential('POST', u('https://gitlab.com/other/x.git/git-upload-pack'), 'memorid')).toBe(false);
    expect(gitReadWithCredential('POST', u('https://gitlab.com.evil.example/memorid/x.git/git-upload-pack'), 'memorid')).toBe(false);
    expect(gitReadWithCredential('POST', u('http://gitlab.com/memorid/x.git/git-upload-pack'), 'memorid')).toBe(false);
    expect(gitReadWithCredential('GET', u('https://gitlab.com/memorid/x.git/info/refs?service=git-upload-pack&x=1'), 'memorid')).toBe(false);
    expect(gitReadWithCredential('POST', u('https://gitlab.com/memorid/x.git/git-upload-pack'), '')).toBe(false);
  });
  it('job ids name their size', () => {
    expect(sizeOfId('cp-cf-s0123abcd')).toBe('std');
    expect(sizeOfId('cp-cf-b0123abcd')).toBe('big');
    expect(sizeOfId('cp-cf-x0123abcd')).toBeNull();
    expect(sizeOfId('claudepilot-job-0123abcd')).toBeNull();
  });
});

describe('signing', () => {
  const key = 'k'.repeat(64).replace(/k/g, 'b');
  const keys = { kohilabs: key };
  const now = 1_790_000_000;
  const req = async (over: { ws?: string; ts?: number; sig?: string; body?: string; path?: string; method?: string } = {}) => {
    const body = over.body ?? '';
    const path = over.path ?? '/jobs?chat=c1';
    const method = over.method ?? 'POST';
    const ts = String(over.ts ?? now);
    const sig = over.sig ?? (await sign(key, method, path, ts, await sha256Hex(body)));
    const r = new Request(`https://d.test${path}`, {
      method,
      headers: { 'x-jobrun-key': over.ws ?? 'kohilabs', 'x-jobrun-ts': ts, 'x-jobrun-sig': sig },
    });
    return verify(r, new TextEncoder().encode(body).buffer as ArrayBuffer, keys, now);
  };
  it('accepts a good signature', async () => {
    expect(await req({ body: '{"a":1}' })).toEqual({ ok: true, workspace: 'kohilabs' });
  });
  it('refuses an unknown workspace, a stale time, a changed body, path or method, and a malformed signature', async () => {
    expect((await req({ ws: 'konfersi' })).ok).toBe(false);
    expect((await req({ ts: now - 301 })).ok).toBe(false);
    const good = await sign(key, 'POST', '/jobs?chat=c1', String(now), await sha256Hex('{"a":1}'));
    expect((await req({ sig: good, body: '{"a":2}' })).ok).toBe(false);
    expect((await req({ sig: good, body: '{"a":1}', path: '/jobs?chat=c2' })).ok).toBe(false);
    expect((await req({ sig: good, body: '{"a":1}', method: 'DELETE' })).ok).toBe(false);
    expect((await req({ sig: 'zz' })).ok).toBe(false);
  });
});
