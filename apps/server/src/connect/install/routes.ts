// The installers' agent-facing routes (docs/prd/targets-connect.md §13, §15, FR45 to FR47): the two static scripts, the plan and the
// Kubernetes manifest (bearer: the enrollment token, looked up without being used), the agent bundle and `latest.json`, and the workspace
// image's build context. No cookie, none of `/api`'s machinery; T1 mounts this under `/connect/` only while Connect is enabled (FR61).
// Wrong tokens count against the client address with the same limiter as `enroll` (10 in 10 minutes, then 429).
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { AppError } from '@isnanme/core';
import {
  CONNECT_AGENT_VERSION,
  CONNECT_LIMITS,
  CONNECT_PROTOCOL,
  CONNECT_PUBLIC,
  type ConnectEnrollReason,
  type ConnectEnrollment,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { pack } from 'tar-stream';
import { declarePolicies } from '../../authz/seam.js';
import { config as portalConfig } from '../../config.js';
import { RateLimiter } from '../../rateLimit.js';
import type { InstallDeps } from '../seams.js';
import { INSTALL_PS1, INSTALL_SH } from './installers.generated.js';
import { buildManifest } from './manifest.js';
import { buildPlan, type NodeManifest } from './plan.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The scripts as this portal serves them, and their sha256 (the wizard shows it; the `ETag` is it). */
export const INSTALLERS = {
  sh: { text: INSTALL_SH, sha256: sha256(INSTALL_SH) },
  ps1: { text: INSTALL_PS1, sha256: sha256(INSTALL_PS1) },
} as const;
export const installerDigests = () => ({ sh: INSTALLERS.sh.sha256, ps1: INSTALLERS.ps1.sha256 });

export type HonoEnv = { Bindings: { incoming?: { socket: { remoteAddress?: string } } } };

export interface InstallRouteOptions {
  /** Shared with `enroll`, so wrong tokens count once per address across the agent-facing routes. */
  limiter?: Pick<RateLimiter, 'blocked' | 'fail'>;
  /** The client address (the same rule as sign-in: `X-Forwarded-For` only behind a trusted proxy). */
  clientIp?: (c: Context<HonoEnv>) => string;
  /** Tests: another Node and pty pin than node-manifest.json. */
  node?: NodeManifest;
}


/** Declared once: these routes are the agents' door, not a person's; the token or nothing authorizes them (PRD §17). */
export function declareInstallPolicies(): void {
  declarePolicies('connect-install', {
    [`GET ${CONNECT_PUBLIC.installSh}`]: { kind: 'public', why: 'The static installer: the same bytes for everyone, no secret.' },
    [`GET ${CONNECT_PUBLIC.installPs1}`]: { kind: 'public', why: 'The static installer: the same bytes for everyone, no secret.' },
    [`GET ${CONNECT_PUBLIC.latest}`]: { kind: 'public', why: 'Which agent bundle this portal serves (build and sha256); no secret.' },
    ['GET /connect/v1/agent/:build/agent.mjs']: { kind: 'public', why: 'The agent bundle; installers check it against the sha256 of the plan.' },
    [`GET ${CONNECT_PUBLIC.workspaceContext}`]: { kind: 'public', why: 'The workspace image build context (Dockerfile and helpers); no secret.' },
    [`GET ${CONNECT_PUBLIC.plan}`]: { kind: 'bearer', why: 'The enrollment token, looked up without being used.' },
    [`GET ${CONNECT_PUBLIC.manifest}`]: { kind: 'bearer', why: 'The enrollment token, looked up without being used; the manifest carries it back.' },
  } as Parameters<typeof declarePolicies>[1]);
}

const REASON_OF: Record<ConnectEnrollment['state'], ConnectEnrollReason> = {
  waiting: 'token_invalid',
  used: 'token_used',
  expired: 'token_expired',
  revoked: 'token_revoked',
};
const MESSAGE_OF: Record<ConnectEnrollReason, string> = {
  token_invalid: 'That token isn’t valid.',
  token_used: 'That token was used already.',
  token_expired: 'That token has expired.',
  token_revoked: 'That token was revoked.',
  target_enrolled: 'That target has a node already.',
  name_taken: 'That name is taken.',
  bad_key: 'Bad key.',
  insecure_url: 'Insecure address.',
  store_locked: 'The portal’s store is locked.',
};
const refuse = (reason: ConnectEnrollReason, status = 401) =>
  new AppError(status === 401 ? 'UNAUTHORIZED' : 'NOT_FOUND', MESSAGE_OF[reason], { status, details: { reason } });

export function createInstallRoutes(deps: InstallDeps, opts: InstallRouteOptions = {}): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  const limiter = opts.limiter ?? new RateLimiter(CONNECT_LIMITS.enrollFailures.attempts, CONNECT_LIMITS.enrollFailures.windowMs);
  const clientIp: (c: Context<HonoEnv>) => string =
    opts.clientIp ??
    ((c: Context<HonoEnv>) => {
      const forwarded = portalConfig.trustProxy ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined;
      return forwarded || (c.env?.incoming?.socket.remoteAddress ?? 'unknown');
    });

  // The token, or a refusal. A browser never acts as an installer: a request with an Origin is refused like a wrong token, uncounted.
  const lookup = (c: Context<HonoEnv>) => {
    if (c.req.header('origin') !== undefined) throw new AppError('FORBIDDEN', 'Not from a browser.');
    const ip = clientIp(c);
    if (limiter.blocked(ip)) throw new AppError('RATE_LIMITED', 'Too many wrong tokens. Wait a few minutes.');
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    const token = m?.[1] ?? '';
    const found = token ? deps.enrollments.lookup(token) : null;
    if (!found) {
      limiter.fail(ip);
      throw refuse('token_invalid');
    }
    if (!found.usable) throw refuse(REASON_OF[found.enrollment.state] ?? 'token_invalid');
    return { ...found, token };
  };
  const planInput = (f: ReturnType<typeof lookup>) => ({
    enrollment: f.enrollment,
    target: f.target,
    options: f.options,
    bundle: deps.bundle,
    config: deps.config,
    ...(opts.node ? { node: opts.node } : {}),
  });
  const text = (c: Context, body: string, type: string, extra: Record<string, string> = {}) =>
    c.body(body, 200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...extra });

  for (const [path, s] of [
    [CONNECT_PUBLIC.installSh, INSTALLERS.sh],
    [CONNECT_PUBLIC.installPs1, INSTALLERS.ps1],
  ] as const) {
    app.get(path, (c) => {
      const etag = `"${s.sha256}"`;
      if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ETag: etag });
      return text(c, s.text, 'text/plain; charset=utf-8', { ETag: etag, 'Cache-Control': 'no-cache' });
    });
  }

  app.get(CONNECT_PUBLIC.plan, (c) => {
    const f = lookup(c);
    deps.log(`connect: plan for ${f.target.id} (${f.enrollment.id}) from ${clientIp(c)}`);
    return text(c, buildPlan(planInput(f)), 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });
  });

  app.get(CONNECT_PUBLIC.manifest, (c) => {
    const f = lookup(c);
    if (f.target.kind !== 'kubernetes') throw new AppError('NOT_FOUND', 'This enrollment isn’t for Kubernetes.');
    deps.log(`connect: manifest for ${f.target.id} (${f.enrollment.id}) from ${clientIp(c)}`);
    return text(c, buildManifest({ ...planInput(f), token: f.token }), 'application/yaml; charset=utf-8', { 'Cache-Control': 'no-store' });
  });

  app.get(CONNECT_PUBLIC.latest, (c) =>
    c.json(
      {
        build: deps.bundle.build,
        sha256: deps.bundle.sha256,
        version: deps.bundle.version || CONNECT_AGENT_VERSION,
        protocol: CONNECT_PROTOCOL,
        url: CONNECT_PUBLIC.bundle(deps.bundle.build),
      },
      200,
      { 'Cache-Control': 'no-cache' },
    ),
  );

  app.get('/connect/v1/agent/:build/agent.mjs', (c) => {
    // Only the build this portal serves now; an older one is gone with the portal's previous version.
    if (c.req.param('build') !== deps.bundle.build) throw new AppError('NOT_FOUND', 'No such agent build here.');
    return text(c, deps.bundle.source, 'text/javascript; charset=utf-8', {
      ETag: `"${deps.bundle.sha256}"`,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });

  app.get(CONNECT_PUBLIC.workspaceContext, (c) => {
    const stream = Readable.from(deps.workspaceContext() as AsyncIterable<Buffer>);
    return c.body(Readable.toWeb(stream) as ReadableStream, 200, { 'Content-Type': 'application/gzip', 'Cache-Control': 'no-cache' });
  });

  return app;
}

/** `InstallDeps.workspaceContext`: a folder (images/workspace) as a tar.gz, files with their modes, for `docker build -`. */
export function workspaceContextTgz(dir: string = portalConfig.workspaces.imageContext): NodeJS.ReadableStream {
  const tar = pack();
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) files.push(p);
    }
  };
  walk(dir);
  (async () => {
    for (const p of files) {
      const st = statSync(p);
      const entry = tar.entry({ name: relative(dir, p), size: st.size, mode: st.mode & 0o777, mtime: new Date(0) });
      await new Promise<void>((resolve, reject) => {
        createReadStream(p).on('error', reject).pipe(entry).on('finish', resolve).on('error', reject);
      });
    }
    tar.finalize();
  })().catch((e: unknown) => tar.destroy(e as Error));
  return tar.pipe(createGzip());
}
