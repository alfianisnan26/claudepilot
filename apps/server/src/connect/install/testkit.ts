// Test helpers for the installers: a fake enrollment registry, a fake portal (the real install routes plus a stand-in for T1's health
// and enroll/status), a fake agent bundle that enrolls and "connects" by calling the fake portal, and a fake npm registry for the pty
// package. Nothing here talks to a real portal, a real registry or a real cluster.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGzip, gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { AppError, isAppError } from '@isnanme/core';
import type { ConnectEnrollment, ConnectEnrollStatus, ConnectInstallOptions, ConnectKind, ConnectPlatform } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { pack } from 'tar-stream';
import type { ConnectTargetRecord, EnrollmentLookup, InstallDeps } from '../seams.js';
import { NODE_MANIFEST, type NodeManifest } from './plan.js';
import { createInstallRoutes } from './routes.js';

export const newToken = () => `cpen_${randomBytes(32).toString('base64url')}`;
export const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
export const integrity = (b: Buffer) => `sha512-${createHash('sha512').update(b).digest('base64')}`;

export function enrollment(over: Partial<ConnectEnrollment> = {}): ConnectEnrollment {
  return {
    id: 'en_test',
    targetId: 'cx4-lab',
    last4: 'abcd',
    platform: 'linux',
    state: 'waiting',
    uses: 0,
    maxUses: 1,
    expiresAt: '2026-10-12T09:15:00.000Z',
    createdAt: '2026-10-12T09:00:00.000Z',
    createdBy: 'u_owner',
    ...over,
  };
}

export function targetRecord(kind: ConnectKind, over: Partial<ConnectTargetRecord> = {}): ConnectTargetRecord {
  return { id: 'cx4-lab', label: 'Lab', kind, portalUrl: 'https://pilot.example.com', settings: {}, active: false, isDefault: false, ...over };
}

export const BUNDLE_FIXTURE = { build: '3f9a1c07be52', sha256: 'a'.repeat(64), version: '0.1.0', source: 'export {};\n' };
export const CONFIG_FIXTURE: InstallDeps['config'] = {
  baseImage: 'node:22-bookworm-slim',
  workspaceImage: 'ghcr.io/alfianisnan26/claudepilot-workspace:latest',
  caPem: null,
  allowHttp: false,
};

/** One enrollment in a map, the way T1's registry answers: `usable` false once used, expired or revoked. */
export class FakeEnrollments implements EnrollmentLookup {
  readonly rows = new Map<string, { enrollment: ConnectEnrollment; target: ConnectTargetRecord; options: ConnectInstallOptions; status: ConnectEnrollStatus }>();
  add(token: string, kind: ConnectKind, opts: { options?: ConnectInstallOptions; target?: Partial<ConnectTargetRecord>; enrollment?: Partial<ConnectEnrollment>; platform?: ConnectPlatform } = {}) {
    const target = targetRecord(kind, opts.target);
    this.rows.set(token, {
      enrollment: enrollment({ targetId: target.id, platform: opts.platform ?? 'linux', ...opts.enrollment }),
      target,
      options: opts.options ?? {},
      status: { state: 'waiting' },
    });
    return this;
  }
  lookup(token: string) {
    const r = this.rows.get(token);
    return r ? { enrollment: r.enrollment, target: r.target, options: r.options, usable: r.enrollment.state === 'waiting' } : null;
  }
  status(token: string) {
    return this.rows.get(token)?.status ?? null;
  }
  /** What enroll/status answers, without touching the token's state (a flow whose agent is a stub). */
  setStatus(token: string, state: ConnectEnrollStatus['state']) {
    const r = this.rows.get(token)!;
    r.status = { state, node: 'nd_fake', target: r.target.id };
  }
  /** What the fake agent's enroll and run do. */
  mark(token: string, state: ConnectEnrollStatus['state']) {
    const r = this.rows.get(token);
    if (!r) return false;
    r.status = { state, node: 'nd_fake', target: r.target.id };
    if (state !== 'waiting') r.enrollment.state = 'used';
    return true;
  }
}

/**
 * The fake agent bundle: `enroll --token-stdin` posts the token to the fake portal's `/fake/enroll` and writes identity.json;
 * `run` posts to `/fake/run` (the fake portal then answers "connected") and stays up; `doctor` prints ok. Exit codes as T2's.
 */
export const FAKE_AGENT = `import fs from 'node:fs';
const dir = process.env.PILOT_DATA_DIR || '.';
const cfg = JSON.parse(fs.readFileSync(dir + '/agent.json', 'utf8'));
const cmd = process.argv[2] || 'run';
const post = (path, body) => fetch(cfg.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
if (cmd === 'enroll') {
  if (fs.existsSync(dir + '/identity.json')) { console.log('already enrolled'); process.exit(0); }
  const token = fs.readFileSync(0, 'utf8').split('\\n')[0].replace(/\\r$/, '');
  let r;
  try { r = await post('/fake/enroll', { token, mode: cfg.mode, nodeName: cfg.nodeName }); } catch { process.exit(11); }
  if (r.status !== 200) { console.error('refused'); process.exit(12); }
  fs.writeFileSync(dir + '/identity.json', JSON.stringify({ node: 'nd_fake', target: (await r.json()).target }), { mode: 0o600 });
  console.log('enrolled');
} else if (cmd === 'run') {
  const id = JSON.parse(fs.readFileSync(dir + '/identity.json', 'utf8'));
  await post('/fake/run', { target: id.target, build: process.env.FAKE_BUILD || '' });
  console.log('running');
  setInterval(() => {}, 1 << 30);
} else if (cmd === 'doctor') { console.log('doctor: ok'); }
`;

/** A tarball shaped like an npm package (`package/…`). */
export async function npmTarball(name: string, version: string): Promise<Buffer> {
  const tar = pack();
  const files: [string, string][] = [
    ['package/package.json', JSON.stringify({ name, version }, null, 2)],
    ['package/index.js', 'module.exports = {};\n'],
  ];
  for (const [n, body] of files) tar.entry({ name: n, mode: 0o644 }, body);
  tar.finalize();
  const chunks: Buffer[] = [];
  for await (const c of tar as unknown as AsyncIterable<Buffer>) chunks.push(c);
  return gzipSync(Buffer.concat(chunks));
}

export interface FakePortal {
  url: string;
  port: number;
  enrollments: FakeEnrollments;
  node: NodeManifest;
  calls: { path: string; auth: string | null }[];
  runs: { target: string; build: string }[];
  close(): Promise<void>;
}

/**
 * The real install routes with a fake registry behind them, T1's health and enroll/status stood in, the fake agent's two calls, and a
 * fake npm registry at `/npm/` (point `npm_config_registry` at it). Listens on `host` (0.0.0.0 when containers must reach it).
 */
export async function fakePortal(opts: { host?: string; agent?: string; publicHost?: string; badSha?: boolean } = {}): Promise<FakePortal> {
  const enrollments = new FakeEnrollments();
  const source = opts.agent ?? FAKE_AGENT;
  const bundle = { build: sha256(source).slice(0, 12), sha256: opts.badSha ? 'b'.repeat(64) : sha256(source), version: '0.1.0', source };
  const ptyVer = NODE_MANIFEST.pty.version;
  const tarballs = new Map<string, Buffer>();
  const node: NodeManifest = { node: NODE_MANIFEST.node, pty: { ...NODE_MANIFEST.pty, integrity: { ...NODE_MANIFEST.pty.integrity } } };
  for (const plat of ['', '-linux-x64', '-linux-arm64', '-darwin-x64', '-darwin-arm64'] as const) {
    const name = `@lydell/node-pty${plat}`;
    const tgz = await npmTarball(name, ptyVer);
    tarballs.set(`/npm/${name}/-/node-pty${plat}-${ptyVer}.tgz`, tgz);
    node.pty.integrity[(plat ? plat.slice(1) : 'main') as keyof NodeManifest['pty']['integrity']] = integrity(tgz);
  }
  const calls: FakePortal['calls'] = [];
  const runs: FakePortal['runs'] = [];
  const deps: InstallDeps = {
    enrollments,
    bundle,
    config: { ...CONFIG_FIXTURE, baseImage: 'node:22-trixie-slim', workspaceImage: 'claudepilot-workspace:latest', allowHttp: true },
    workspaceContext: () => {
      const tar = pack();
      tar.entry({ name: 'Dockerfile', mode: 0o644 }, 'FROM node:22-trixie-slim\nLABEL cx4=test\n');
      tar.finalize();
      return (tar as unknown as Readable).pipe(createGzip());
    },
    log: () => {},
  };
  const app = new Hono();
  app.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', String(e));
    return c.json(err.toJSON(), err.status as ContentfulStatusCode);
  });
  app.use('*', async (c, next) => {
    calls.push({ path: new URL(c.req.url).pathname, auth: c.req.header('authorization') ?? null });
    await next();
  });
  app.get('/connect/v1/health', (c) => c.json({ ok: true, protocol: 1, version: '0.1.0' }));
  app.get('/connect/v1/enroll/status', (c) => {
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const s = enrollments.status(token);
    if (!s) throw new AppError('UNAUTHORIZED', 'That token isn’t valid.', { details: { reason: 'token_invalid' } });
    return c.json({ data: s });
  });
  app.post('/fake/enroll', async (c) => {
    const { token } = await c.req.json<{ token: string }>();
    const r = enrollments.rows.get(token);
    if (!r || r.enrollment.state !== 'waiting') return c.json({ error: 'refused' }, 401);
    enrollments.mark(token, 'enrolled');
    return c.json({ target: r.target.id });
  });
  app.post('/fake/run', async (c) => {
    const body = await c.req.json<{ target: string; build: string }>();
    runs.push(body);
    for (const [t, r] of enrollments.rows) if (r.target.id === body.target && r.status.state !== 'waiting') enrollments.mark(t, 'connected');
    return c.json({ ok: true });
  });
  app.get('/npm/*', (c) => {
    const t = tarballs.get(new URL(c.req.url).pathname);
    return t ? c.body(new Uint8Array(t), 200, { 'Content-Type': 'application/octet-stream' }) : c.notFound();
  });
  app.route('/', createInstallRoutes(deps, { node, clientIp: () => '203.0.113.9' }));
  const server = serve({ fetch: app.fetch, port: 0, hostname: opts.host ?? '127.0.0.1' });
  await new Promise<void>((ok) => server.once('listening', ok));
  const port = (server.address() as AddressInfo).port;
  const url = `http://${opts.publicHost ?? '127.0.0.1'}:${port}`;
  return {
    url,
    port,
    enrollments,
    node,
    calls,
    runs,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

/** A private HOME and a bin folder of stubs, removed by `done()`. Installer tests never see the real HOME, ~/.config or SSH agent. */
export function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'cx4-inst-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  return {
    root,
    home,
    bin,
    /** A stub program on PATH: records its arguments (and stdin, when `stdin` is set) as JSON lines in <root>/<name>.log, then runs `body`. */
    stub(name: string, body: string, stdin = false) {
      const p = join(bin, name);
      writeFileSync(
        p,
        `#!/bin/sh\nlog=${JSON.stringify(join(root, `${name}.log`))}\n` +
          `node -e 'const a=process.argv.slice(1);let s="";${stdin ? 'try{s=require("fs").readFileSync(0,"utf8")}catch{}' : ''}require("fs").appendFileSync(a.shift(),JSON.stringify({argv:a,stdin:s})+"\\n")' "$log" "$@"\n` +
          body,
      );
      chmodSync(p, 0o755);
    },
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}
