/**
 * A FAKE GitHub for tests and scratch portals (docs/prd/codespaces-poc.md §14): the OAuth device flow and the Codespaces REST endpoints the
 * provider uses, with a small codespace state machine and the documented permission checks, so nothing ever needs a real account. Pattern:
 * apps/server/src/mcp/builtin/testkit (one small node:http server, in-memory state, a request log that never keeps a secret).
 *
 *   Device flow   POST /login/device/code (client_id, scope) and POST /login/oauth/access_token (client_id, device_code, grant_type):
 *                 authorization_pending, slow_down (+5 s when polled faster than the interval), expired_token, access_denied,
 *                 device_flow_disabled, incorrect_client_credentials, unsupported_grant_type, incorrect_device_code; a client_secret
 *                 sent to it is REFUSED (the portal must never send one). `approve(userCode, login)` / `deny(userCode)` play the person.
 *   REST          GET /user (X-OAuth-Scopes for OAuth and classic tokens, none for fine-grained), GET /user/repos, GET /repos/:o/:r,
 *                 GET /repos/:o/:r/codespaces/{devcontainers,machines,new}, GET|POST /user/codespaces, GET|DELETE /user/codespaces/:name,
 *                 POST /user/codespaces/:name/{start,stop}.
 *   Permissions   as GitHub documents them (permissions-required-for-fine-grained-personal-access-tokens, read 2026-10-12): fine-grained
 *                 tokens need Codespaces read (list, get) or write (create, delete, pre-flight), Codespaces lifecycle admin write (start,
 *                 stop), Codespaces metadata read (devcontainers, machines), each on the repository; OAuth and classic tokens need the
 *                 `codespace` scope. Missing: 403. Unknown token: 401.
 *   States        create: Queued -> Provisioning (1 s) -> Available (3 s); stop: ShuttingDown -> Shutdown (1 s); start: Starting -> Available
 *                 (2 s); delete: gone (404). Time moves with `advance(ms)` or the wall clock.
 *   Quirks        `rateLimitAfter` (403 + x-ratelimit-remaining: 0 after n API calls), `spendingLimit` (start answers 402 and the codespace
 *                 carries GitHub's stop notice), `deviceDisabled`.
 *   Control       in process, or over HTTP with `control: true`: POST /__standin/{approve,deny,advance,token}, GET /__standin/state.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakePermission = 'codespaces:read' | 'codespaces:write' | 'lifecycle:write' | 'metadata:read';

export interface FakeToken {
  login: string;
  /** github_pat_ (fine-grained: permissions), gho_/ghu_ (OAuth or App user: scopes), ghp_ (classic: scopes). */
  kind: 'fine-grained' | 'oauth' | 'classic';
  scopes?: string[];
  permissions?: FakePermission[];
  /** Repositories the token reaches (fine-grained: the selected repositories). Default: every repo of the fake. */
  repos?: string[];
}

export interface FakeRepo {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  devcontainers: string[];
}

export interface StandInOptions {
  clientIds?: string[];
  deviceDisabled?: boolean;
  interval?: number;
  expiresIn?: number;
  tokens?: Record<string, FakeToken>;
  repos?: FakeRepo[];
  rateLimitAfter?: number | null;
  spendingLimit?: boolean;
  control?: boolean;
  /** Listen on this port (127.0.0.1); default a free one. */
  port?: number;
}

export interface LoggedCall {
  method: string;
  path: string;
  auth: 'none' | 'bearer' | 'other';
  /** Form or JSON keys only: never a value. */
  keys: string[];
  status: number;
}

interface DeviceRecord {
  clientId: string;
  deviceCode: string;
  userCode: string;
  scope: string;
  expiresAt: number;
  interval: number;
  lastPoll: number;
  state: 'pending' | 'approved' | 'denied' | 'used';
  login: string | null;
}

interface FakeCodespace {
  name: string;
  owner: string;
  repo: FakeRepo;
  ref: string;
  machine: string;
  devcontainerPath: string | null;
  idle: number;
  retention: number | null;
  displayName: string | null;
  state: string;
  next: { state: string; at: number }[];
  createdAt: string;
  stopNotice: string | null;
}

export interface GitHubStandIn {
  url: string;
  calls: LoggedCall[];
  approve(userCode: string, login?: string, extra?: Partial<FakeToken>): void;
  deny(userCode: string): void;
  advance(ms: number): void;
  addToken(token: string, t: FakeToken): void;
  /** Tokens the fake issued through the device flow (the test may plant them as canaries). */
  issued(): string[];
  codespaces(): { name: string; state: string; owner: string }[];
  set(opts: Partial<Pick<StandInOptions, 'rateLimitAfter' | 'spendingLimit' | 'deviceDisabled'>>): void;
  close(): Promise<void>;
}

export const DEFAULT_REPOS: FakeRepo[] = [
  { id: 1001, fullName: 'octo/app', private: true, defaultBranch: 'main', devcontainers: ['.devcontainer/devcontainer.json', '.devcontainer/claudepilot/devcontainer.json'] },
  { id: 1002, fullName: 'octo/docs', private: false, defaultBranch: 'main', devcontainers: [] },
];

const MACHINES = [
  { name: 'basicLinux32gb', display_name: '2 cores, 8 GB RAM, 32 GB storage', operating_system: 'linux', storage_in_bytes: 34359738368, memory_in_bytes: 8589934592, cpus: 2, prebuild_availability: null },
  { name: 'standardLinux32gb', display_name: '4 cores, 16 GB RAM, 32 GB storage', operating_system: 'linux', storage_in_bytes: 34359738368, memory_in_bytes: 17179869184, cpus: 4, prebuild_availability: 'none' },
];

const rand = (n: number) => randomBytes(n).toString('hex');
const userCode = () => {
  const A = 'BCDFGHJKLMNPQRSTVWXZ0123456789';
  const pick = () => A.charAt(randomBytes(1)[0]! % A.length);
  return `${Array.from({ length: 4 }, pick).join('')}-${Array.from({ length: 4 }, pick).join('')}`;
};

export async function startGitHubStandIn(options: StandInOptions = {}): Promise<GitHubStandIn> {
  const opts = { clientIds: ['Iv1.standin'], interval: 5, expiresIn: 900, rateLimitAfter: null as number | null, spendingLimit: false, deviceDisabled: false, ...options };
  const tokens = new Map<string, FakeToken>(Object.entries(opts.tokens ?? {}));
  const repos = opts.repos ?? DEFAULT_REPOS;
  const devices = new Map<string, DeviceRecord>();
  const codespaces = new Map<string, FakeCodespace>();
  const issued: string[] = [];
  const calls: LoggedCall[] = [];
  let skew = 0;
  let apiCalls = 0;
  const now = () => Date.now() + skew;

  const tick = () => {
    for (const c of codespaces.values()) {
      while (c.next.length && c.next[0]!.at <= now()) c.state = c.next.shift()!.state;
    }
  };

  const issue = (login: string, scope: string, extra: Partial<FakeToken> = {}) => {
    const t = `gho_${rand(18)}`;
    tokens.set(t, { login, kind: 'oauth', scopes: scope.split(/[ ,]+/).filter(Boolean), ...extra });
    issued.push(t);
    return t;
  };

  const csJson = (c: FakeCodespace, base: string) => ({
    id: Math.abs(hash(c.name)),
    name: c.name,
    display_name: c.displayName,
    environment_id: `env-${c.name}`,
    owner: { login: c.owner },
    billable_owner: { login: c.owner },
    repository: { id: c.repo.id, full_name: c.repo.fullName, private: c.repo.private },
    machine: MACHINES.find((m) => m.name === c.machine) ?? MACHINES[0],
    devcontainer_path: c.devcontainerPath,
    prebuild: false,
    created_at: c.createdAt,
    updated_at: new Date(now()).toISOString(),
    last_used_at: new Date(now()).toISOString(),
    state: c.state,
    url: `${base}/user/codespaces/${c.name}`,
    git_status: { ahead: 0, behind: 0, has_unpushed_changes: false, has_uncommitted_changes: c.state === 'Available', ref: c.ref },
    location: 'WestEurope',
    idle_timeout_minutes: c.idle,
    retention_period_minutes: c.retention,
    retention_expires_at: c.state === 'Shutdown' && c.retention !== null ? new Date(now() + c.retention * 60_000).toISOString() : null,
    last_known_stop_notice: c.stopNotice,
    web_url: `https://${c.name}.github.dev`,
    machines_url: `${base}/user/codespaces/${c.name}/machines`,
    start_url: `${base}/user/codespaces/${c.name}/start`,
    stop_url: `${base}/user/codespaces/${c.name}/stop`,
    pulls_url: null,
    recent_folders: [],
    pending_operation: false,
  });

  const server: Server = createServer((req, res) => void handle(req, res));
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://standin');
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const ctype = req.headers['content-type'] ?? '';
    let form: Record<string, string> = {};
    let json: Record<string, unknown> = {};
    if (ctype.includes('x-www-form-urlencoded')) form = Object.fromEntries(new URLSearchParams(raw));
    else if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        json = {};
      }
    }
    const authz = req.headers.authorization ?? '';
    const entry: LoggedCall = { method: req.method ?? '', path: url.pathname, auth: !authz ? 'none' : /^(Bearer|token) /.test(authz) ? 'bearer' : 'other', keys: [...Object.keys(form), ...Object.keys(json)].slice(0, 20), status: 0 };
    calls.push(entry);
    if (calls.length > 1000) calls.shift();
    const reply = (status: number, body?: unknown, headers?: Record<string, string>) => {
      entry.status = status;
      send(res, status, body, headers);
    };
    tick();
    const base = `http://${req.headers.host}`;

    /* control */
    if (url.pathname.startsWith('/__standin/')) {
      if (!opts.control) return reply(404, { message: 'Not Found' });
      const what = url.pathname.slice('/__standin/'.length);
      if (what === 'state' && req.method === 'GET') return reply(200, { codespaces: api.codespaces(), devices: [...devices.values()].map((d) => ({ userCode: d.userCode, state: d.state })) });
      if (req.method !== 'POST') return reply(405, {});
      if (what === 'approve') return api.approve(String(json.userCode), String(json.login ?? 'octocat')), reply(200, {});
      if (what === 'deny') return api.deny(String(json.userCode)), reply(200, {});
      if (what === 'advance') return api.advance(Number(json.ms) || 0), reply(200, {});
      if (what === 'token') return api.addToken(String(json.token), json.spec as FakeToken), reply(200, {});
      return reply(404, {});
    }

    /* device flow */
    if (req.method === 'POST' && url.pathname === '/login/device/code') {
      if ('client_secret' in form) return reply(400, { error: 'standin_refuses_client_secret' });
      if (!opts.clientIds.includes(form.client_id ?? '')) return reply(200, { error: 'incorrect_client_credentials' });
      if (opts.deviceDisabled) return reply(200, { error: 'device_flow_disabled' });
      const d: DeviceRecord = { clientId: form.client_id ?? '', deviceCode: rand(20), userCode: userCode(), scope: form.scope ?? '', expiresAt: now() + opts.expiresIn * 1000, interval: opts.interval, lastPoll: 0, state: 'pending', login: null };
      devices.set(d.deviceCode, d);
      return reply(200, { device_code: d.deviceCode, user_code: d.userCode, verification_uri: `${base}/login/device`, expires_in: opts.expiresIn, interval: opts.interval });
    }
    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      if ('client_secret' in form) return reply(400, { error: 'standin_refuses_client_secret' });
      if (form.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') return reply(200, { error: 'unsupported_grant_type' });
      if (!opts.clientIds.includes(form.client_id ?? '')) return reply(200, { error: 'incorrect_client_credentials' });
      const d = devices.get(form.device_code ?? '');
      if (!d || d.clientId !== form.client_id || d.state === 'used') return reply(200, { error: 'incorrect_device_code' });
      if (now() >= d.expiresAt) return reply(200, { error: 'expired_token' });
      const since = now() - d.lastPoll;
      d.lastPoll = now();
      if (since < d.interval * 1000 && d.state === 'pending') {
        d.interval += 5;
        return reply(200, { error: 'slow_down', interval: d.interval });
      }
      if (d.state === 'denied') return reply(200, { error: 'access_denied' });
      if (d.state === 'pending') return reply(200, { error: 'authorization_pending' });
      d.state = 'used';
      return reply(200, { access_token: issue(d.login!, d.scope), token_type: 'bearer', scope: d.scope });
    }

    /* REST */
    if (url.pathname === '/login/device') return reply(200, { page: 'Enter the code' });
    const token = /^(?:Bearer|token) (.+)$/.exec(authz)?.[1] ?? null;
    const who = token ? tokens.get(token) : undefined;
    if (!who) return reply(401, { message: 'Bad credentials' });
    apiCalls++;
    if (opts.rateLimitAfter !== null && apiCalls > opts.rateLimitAfter)
      return reply(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil((now() + 60_000) / 1000)) });
    const scopeHeader: Record<string, string> = who.kind === 'fine-grained' ? {} : { 'x-oauth-scopes': (who.scopes ?? []).join(', ') };
    const reach = (r: FakeRepo) => !who.repos || who.repos.includes(r.fullName);
    const allowed = (p: FakePermission, repo?: FakeRepo) => {
      if (repo && !reach(repo)) return false;
      if (who.kind === 'fine-grained') return (who.permissions ?? []).includes(p) || (p === 'codespaces:read' && (who.permissions ?? []).includes('codespaces:write'));
      return (who.scopes ?? []).includes('codespace');
    };
    const deny = () => reply(403, { message: 'Resource not accessible by personal access token' });
    const path = url.pathname;
    let m: RegExpExecArray | null;

    if (req.method === 'GET' && path === '/user') return reply(200, { login: who.login, id: Math.abs(hash(who.login)), type: 'User' }, scopeHeader);
    if (req.method === 'GET' && path === '/user/repos') {
      const visible = repos.filter((r) => reach(r) && (r.private ? who.kind === 'fine-grained' || (who.scopes ?? []).includes('repo') : true));
      return reply(200, visible.map((r) => ({ id: r.id, full_name: r.fullName, private: r.private, default_branch: r.defaultBranch })), scopeHeader);
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path))) {
      const repo = repos.find((r) => r.fullName === m![1]);
      if (!repo || !reach(repo)) return reply(404, { message: 'Not Found' });
      const rest = m[2] ?? '';
      if (req.method === 'GET' && rest === '') return reply(200, { id: repo.id, full_name: repo.fullName, private: repo.private, default_branch: repo.defaultBranch });
      if (req.method === 'GET' && rest === '/codespaces/devcontainers') {
        if (!allowed('metadata:read', repo) && !allowed('codespaces:read', repo)) return deny();
        return reply(200, { total_count: repo.devcontainers.length, devcontainers: repo.devcontainers.map((p) => ({ path: p, name: p.split('/').slice(-2, -1)[0] ?? null })) });
      }
      if (req.method === 'GET' && rest === '/codespaces/machines') {
        if (!allowed('metadata:read', repo) && !allowed('codespaces:read', repo)) return deny();
        return reply(200, { total_count: MACHINES.length, machines: MACHINES });
      }
      if (req.method === 'GET' && rest === '/codespaces/new') {
        if (!allowed('codespaces:write', repo)) return deny();
        return reply(200, { billable_owner: { login: who.login }, defaults: { location: 'WestEurope', devcontainer_path: repo.devcontainers[0] ?? null } });
      }
      return reply(404, { message: 'Not Found' });
    }
    if (path === '/user/codespaces' && req.method === 'GET') {
      if (who.kind === 'fine-grained' ? !(who.permissions ?? []).some((p) => p.startsWith('codespaces:')) : !allowed('codespaces:read')) return deny();
      const mine = [...codespaces.values()].filter((c) => c.owner === who.login && reach(c.repo));
      const per = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? 30)));
      return reply(200, { total_count: mine.length, codespaces: mine.slice(0, per).map((c) => csJson(c, base)) });
    }
    if (path === '/user/codespaces' && req.method === 'POST') {
      const repo = repos.find((r) => r.id === json.repository_id);
      if (!repo || !reach(repo)) return reply(404, { message: 'Not Found' });
      if (!allowed('codespaces:write', repo)) return deny();
      const machine = typeof json.machine === 'string' ? json.machine : MACHINES[0]!.name;
      if (!MACHINES.some((x) => x.name === machine)) return reply(400, { message: 'Invalid machine' });
      const dc = typeof json.devcontainer_path === 'string' ? json.devcontainer_path : (repo.devcontainers[0] ?? null);
      if (dc && !repo.devcontainers.includes(dc)) return reply(400, { message: 'devcontainer not found' });
      const t = now();
      const c: FakeCodespace = {
        name: `${who.login}-${repo.fullName.split('/')[1]}-${rand(4)}`.toLowerCase(),
        owner: who.login,
        repo,
        ref: typeof json.ref === 'string' ? json.ref : repo.defaultBranch,
        machine,
        devcontainerPath: dc,
        idle: typeof json.idle_timeout_minutes === 'number' ? json.idle_timeout_minutes : 30,
        retention: typeof json.retention_period_minutes === 'number' ? json.retention_period_minutes : 43200,
        displayName: typeof json.display_name === 'string' ? json.display_name : null,
        state: 'Queued',
        next: [
          { state: 'Provisioning', at: t + 1000 },
          { state: 'Available', at: t + 3000 },
        ],
        createdAt: new Date(t).toISOString(),
        stopNotice: null,
      };
      codespaces.set(c.name, c);
      return reply(201, csJson(c, base));
    }
    if ((m = /^\/user\/codespaces\/([A-Za-z0-9-]+)(\/start|\/stop)?$/.exec(path))) {
      const c = codespaces.get(m[1]!);
      if (!c || c.owner !== who.login || !reach(c.repo)) return reply(404, { message: 'Not Found' });
      const action = m[2];
      if (!action && req.method === 'GET') return allowed('codespaces:read', c.repo) ? reply(200, csJson(c, base)) : deny();
      if (!action && req.method === 'DELETE') {
        if (!allowed('codespaces:write', c.repo)) return deny();
        codespaces.delete(c.name);
        return reply(202, {});
      }
      if (req.method === 'POST' && (action === '/start' || action === '/stop')) {
        if (!allowed('lifecycle:write', c.repo) && !(who.kind !== 'fine-grained' && allowed('codespaces:write', c.repo))) return deny();
        const t = now();
        if (action === '/start') {
          if (opts.spendingLimit) {
            c.stopNotice = 'you’ve used 100% of your spending limit for Codespaces';
            return reply(402, { message: 'Payment required' });
          }
          if (c.state === 'Available') return reply(304);
          if (c.next.length) return reply(409, { message: 'Conflict' });
          c.state = 'Starting';
          c.next = [{ state: 'Available', at: t + 2000 }];
        } else {
          c.state = 'ShuttingDown';
          c.next = [{ state: 'Shutdown', at: t + 1000 }];
        }
        return reply(200, csJson(c, base));
      }
      return reply(404, { message: 'Not Found' });
    }
    return reply(404, { message: 'Not Found' });
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const api: GitHubStandIn = {
    url: `http://127.0.0.1:${port}`,
    calls,
    approve(code, login = 'octocat', extra = {}) {
      const d = [...devices.values()].find((x) => x.userCode === code);
      if (!d) throw new Error(`no device code ${code}`);
      d.state = 'approved';
      d.login = login;
      if (Object.keys(extra).length) (d as DeviceRecord & { extra?: Partial<FakeToken> }).extra = extra;
    },
    deny(code) {
      const d = [...devices.values()].find((x) => x.userCode === code);
      if (d) d.state = 'denied';
    },
    advance(ms) {
      skew += ms;
      tick();
    },
    addToken(token, t) {
      tokens.set(token, t);
    },
    issued: () => [...issued],
    codespaces: () => [...codespaces.values()].map((c) => (tick(), { name: c.name, state: c.state, owner: c.owner })),
    set(o) {
      Object.assign(opts, o);
      if (o.rateLimitAfter !== undefined) apiCalls = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  return api;
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}
