// scripts/konfersi-release-remotes.sh (T-1079 S4): the Konfersi remotes and their Release reports, set up by a script. Run against a fake
// portal on localhost (never a real one): a dry run only reads; --apply creates, follows, syncs and only then sets the report; a second run
// changes nothing; a missing secret stops before any change; the session goes only in the Cookie header, never in the script's output.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO, 'scripts/konfersi-release-remotes.sh');
const WS = 'kubernetes/kohi-event';
const SECRET = 'KONFERSI_GITEA_READ';
const sha = (s: string) => createHash('sha1').update(s).digest('hex');

const dir = mkdtempSync(join(tmpdir(), 'konfersi-remotes-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// The manifest's layout is not assumed: URLs nested at any depth, an ssh form, a duplicate, and hosts or orgs that are not modules.
const MANIFEST = join(dir, 'manifest.json');
writeFileSync(
  MANIFEST,
  JSON.stringify({
    name: 'konfersi-universe',
    modules: [
      { path: 'svc-auth', repo: 'https://git.konfersi.com/platform/Svc-Auth.git' },
      { path: 'svc-pay', git: { url: 'git@git.konfersi.com:platform/svc-pay.git' } },
    ],
    links: ['https://github.com/other/x', 'https://git.konfersi.com/platform/svc-auth/', 'https://git.konfersi.com/elsewhere/y'],
  }),
);

interface FakeRepo {
  id: string;
  workspaceId: string;
  name: string;
  upstream: { url: string; secret: string | null; error: string | null } | null;
  branches: { name: string; sha: string }[];
  report: unknown;
}
interface Hit {
  method: string;
  path: string;
  body: unknown;
  cookie: string | undefined;
}
interface State {
  files: string[];
  needsValue: string[];
  hosts: string;
  repos: FakeRepo[];
  /** Remotes whose sync brings no `stg`. */
  noBranch: string[];
  /** `METHOD path` answered 500. */
  fail: string[];
  hits: Hit[];
}

const fresh = (o: Partial<State> = {}): State => ({ files: [SECRET], needsValue: [], hosts: 'github.com', repos: [], noBranch: [], fail: [], hits: [], ...o });

async function portal(st: State): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const method = req.method ?? 'GET';
      const body: unknown = raw ? JSON.parse(raw) : undefined;
      st.hits.push({ method, path: u.pathname + u.search, body, cookie: req.headers.cookie });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const ok = (data: unknown) => send(200, { success: true, data });
      if (st.fail.includes(`${method} ${u.pathname}`)) return send(500, { success: false, error: { code: 'INTERNAL', message: 'boom' } });
      const p = u.pathname;
      const b = (body ?? {}) as Record<string, unknown>;
      if (method === 'GET' && p === `/api/workspaces/${WS}/secrets`)
        return ok({ workspaceId: WS, sets: [{ poolId: 'p1', files: st.files, needsValue: st.needsValue, variables: [], exposed: [], pointers: [] }] });
      if (method === 'GET' && p === '/api/settings') return ok({ groups: [], settings: [{ key: 'ci.upstreamHosts', value: st.hosts }] });
      if (method === 'PUT' && p === '/api/settings/ci.upstreamHosts') {
        st.hosts = String(b.value);
        return ok({});
      }
      if (method === 'GET' && p === '/api/ci/repos') return ok(st.repos.filter((r) => r.workspaceId === u.searchParams.get('workspace')));
      if (method === 'POST' && p === '/api/ci/repos') {
        const r: FakeRepo = { id: `r${st.repos.length + 1}`, workspaceId: String(b.workspaceId), name: String(b.name), upstream: null, branches: [], report: null };
        st.repos.push(r);
        return ok(r);
      }
      const m = /^\/api\/ci\/repos\/([^/]+)(\/[a-z/-]+)?$/.exec(p);
      const r = m ? st.repos.find((x) => x.id === decodeURIComponent(m[1] ?? '')) : undefined;
      if (!m || !r) return send(404, { success: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
      const rest = m[2] ?? '';
      if (method === 'PATCH' && rest === '') {
        const up = b.upstream as { url: string; secret: string };
        r.upstream = { url: up.url, secret: up.secret, error: null };
        return ok(r);
      }
      if (method === 'POST' && rest === '/sync') {
        if (!st.noBranch.includes(r.name)) r.branches = [{ name: 'stg', sha: sha(r.name) }];
        return ok({ repo: r });
      }
      if (method === 'GET' && rest === '/branches') return ok(r.branches);
      if (method === 'GET' && rest === '/release-report') return ok(r.report);
      if (method === 'PUT' && rest === '/release-report') {
        r.report = b.setting;
        return ok(r.report);
      }
      return send(404, { success: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function run(args: string[], stdin: string): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn('bash', [SCRIPT, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => (out += c.toString()));
  child.stderr.on('data', (c: Buffer) => (err += c.toString()));
  child.stdin.end(stdin);
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { code, out, err };
}

const session = () => randomBytes(24).toString('base64url');
const writes = (st: State) => st.hits.filter((h) => h.method !== 'GET');
const WANT = { kind: 'branch', branch: 'stg', vaultId: '98af7d16def1', folder: 'Releases' };

async function withPortal(st: State, fn: (url: string, s: string) => Promise<void>) {
  const p = await portal(st);
  try {
    await fn(p.url, session());
  } finally {
    await p.close();
  }
}

test('a dry run only reads, plans every module of the manifest, and sends the session only as the cookie', async () => {
  const st = fresh();
  await withPortal(st, async (url, s) => {
    const r = await run(['--portal', url, '--manifest', MANIFEST], `${s}\n`);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /mode: dry run/);
    assert.match(r.out, /modules: 2 \(svc-auth svc-pay\)/);
    assert.match(r.out, /module svc-auth remote \(new\): would create, follow https:\/\/git\.konfersi\.com\/platform\/Svc-Auth,/);
    assert.match(r.out, /module svc-pay remote \(new\): would create, follow https:\/\/git\.konfersi\.com\/platform\/svc-pay,/);
    assert.match(r.out, /hosts: would add git\.konfersi\.com/);
    assert.deepEqual(writes(st), []);
    assert.ok(st.hits.length > 0);
    for (const h of st.hits) assert.equal(h.cookie, `portal_session=${s}`);
    assert.ok(!r.out.includes(s) && !r.err.includes(s), 'the session is never in the output');
  });
});

test('--apply creates, follows and syncs each remote before its report is set; a second run changes nothing', async () => {
  const st = fresh();
  await withPortal(st, async (url, s) => {
    const r = await run(['--portal', url, '--manifest', MANIFEST, '--apply'], `${s}\n`);
    assert.equal(r.code, 0, r.err + r.out);
    assert.equal(st.hosts, 'github.com, git.konfersi.com');
    assert.deepEqual(
      st.repos.map((x) => [x.name, x.upstream?.url, x.upstream?.secret, x.report]),
      [
        ['svc-auth', 'https://git.konfersi.com/platform/Svc-Auth', SECRET, WANT],
        ['svc-pay', 'https://git.konfersi.com/platform/svc-pay', SECRET, WANT],
      ],
    );
    const w = writes(st).map((h) => `${h.method} ${h.path}`);
    assert.deepEqual(w, [
      'PUT /api/settings/ci.upstreamHosts',
      'POST /api/ci/repos',
      'PATCH /api/ci/repos/r1',
      'POST /api/ci/repos/r1/sync',
      'PUT /api/ci/repos/r1/release-report',
      'POST /api/ci/repos',
      'PATCH /api/ci/repos/r2',
      'POST /api/ci/repos/r2/sync',
      'PUT /api/ci/repos/r2/release-report',
    ]);
    assert.deepEqual(writes(st)[1]?.body, { workspaceId: WS, name: 'svc-auth', defaultBranch: 'stg' });
    assert.deepEqual(writes(st)[4]?.body, { setting: WANT });
    assert.match(r.out, new RegExp(`module svc-auth remote r1: created follows synced report; stg ${sha('svc-auth').slice(0, 7)} \\(baseline\\)`));
    assert.ok(!r.out.includes(s) && !r.err.includes(s));

    st.hits = [];
    const again = await run(['--portal', url, '--manifest', MANIFEST, '--apply'], `${s}\n`);
    assert.equal(again.code, 0, again.err);
    assert.deepEqual(writes(st), [], 'idempotent');
    assert.match(again.out, /hosts: git\.konfersi\.com is listed/);
    assert.match(again.out, new RegExp(`module svc-pay remote r2: as it is; stg ${sha('svc-pay').slice(0, 7)}\\n`));
  });
});

test('a remote that follows another URL is re-pointed and synced; an empty host list is left as it is', async () => {
  const st = fresh({ hosts: '' });
  st.repos.push({
    id: 'r1',
    workspaceId: WS,
    name: 'svc-auth',
    upstream: { url: 'https://git.konfersi.com/platform/old', secret: SECRET, error: null },
    branches: [{ name: 'stg', sha: sha('old') }],
    report: WANT,
  });
  await withPortal(st, async (url, s) => {
    const r = await run(['--portal', url, '--manifest', MANIFEST, '--apply'], `${s}\n`);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /hosts: ci\.upstreamHosts is empty \(any public host\): left as it is/);
    assert.equal(st.hosts, '');
    const w = writes(st).map((h) => `${h.method} ${h.path}`);
    assert.ok(!w.some((x) => x.startsWith('PUT /api/settings')));
    assert.deepEqual(w.slice(0, 2), ['PATCH /api/ci/repos/r1', 'POST /api/ci/repos/r1/sync']);
    assert.ok(!w.includes('PUT /api/ci/repos/r1/release-report'), 'its report was already right');
    assert.match(r.out, /module svc-auth remote r1: follows synced; stg/);
  });
});

test('a missing secret stops before any change and names it for the coordinator', async () => {
  for (const o of [{ files: [] as string[] }, { needsValue: [SECRET] }]) {
    const st = fresh(o);
    await withPortal(st, async (url, s) => {
      const r = await run(['--portal', url, '--manifest', MANIFEST, '--apply'], `${s}\n`);
      assert.equal(r.code, 3, JSON.stringify(o));
      assert.match(r.out, new RegExp(`FOR THE COORDINATOR: .*as the secret ${SECRET}`));
      assert.deepEqual(writes(st), []);
    });
  }
});

test('a branch missing after the sync leaves that report unset and fails the run; the other module is still done', async () => {
  const st = fresh({ noBranch: ['svc-auth'] });
  await withPortal(st, async (url, s) => {
    const r = await run(['--portal', url, '--manifest', MANIFEST, '--apply'], `${s}\n`);
    assert.equal(r.code, 1);
    assert.match(r.out, /module svc-auth remote r1: created follows synced; FAILED: stg is not in the mirror/);
    assert.equal(st.repos[0]?.report, null);
    assert.deepEqual(st.repos[1]?.report, WANT);
  });
});

test('a portal error is shown with its message and fails that module only', async () => {
  const st = fresh({ fail: ['PATCH /api/ci/repos/r1'] });
  await withPortal(st, async (url, s) => {
    const r = await run(['--portal', url, '--manifest', MANIFEST, '--apply'], `${s}\n`);
    assert.equal(r.code, 1);
    assert.match(r.err, /PATCH \/api\/ci\/repos\/r1: HTTP 500: boom/);
    assert.equal(st.repos[0]?.report, null);
    assert.deepEqual(st.repos[1]?.report, WANT);
  });
});

test('bad input is refused before any request', async () => {
  const st = fresh();
  await withPortal(st, async (url, s) => {
    const cases: [string[], string][] = [
      [['--portal', url, '--manifest', MANIFEST], ''],
      [['--portal', url, '--manifest', MANIFEST], 'a"b\n'],
      [['--portal', `${url}/api`, '--manifest', MANIFEST], `${s}\n`],
      [['--portal', url, '--manifest', join(dir, 'none.json')], `${s}\n`],
      [['--portal', url, '--manifest', MANIFEST, '--host', 'example.org'], `${s}\n`],
      [['--portal', url, '--manifest', MANIFEST, '--bogus'], `${s}\n`],
    ];
    for (const [args, stdin] of cases) {
      const r = await run(args, stdin);
      assert.equal(r.code, 2, args.join(' '));
    }
    assert.deepEqual(st.hits, []);
  });
});
