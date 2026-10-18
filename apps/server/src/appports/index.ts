import { AppError } from '@isnanme/core';
import {
  APP_PORT_AUTH_PATH,
  APP_PORT_MAX,
  APP_PORT_MIN,
  appHostSlug,
  appPortHost,
  isAppPortNext,
  type AppPortItem,
  type AppPortList,
  type OpenAppPortResult,
} from '@portal/contracts';
import type { Actor, Workspace } from '@portal/contracts';
import { CDP_PORT, SUPERVISOR_PORT } from '../browser/spec.js';
import type { ExecSession, Runtime } from '../workspaces/runtime.js';
import { createDialer, type Dial } from './dial.js';
import { AppPortGrants } from './grants.js';
import { AppPortProxy, type ProxyLimits } from './proxy.js';

export { AppPortProxy, routeAppHostUpgrades } from './proxy.js';
export { AppPortGrants, APP_COOKIE } from './grants.js';

/**
 * App ports (docs/prd/app-ports.md): the listening ports of a workspace, the open (a one-time code for an app host) and the proxy that serves
 * the app hosts. Off when `suffix` is unset.
 */

/** Reads the workspace's listening TCP ports from /proc (no `ss` needed in the image) with the process that holds each, as JSON on stdout. */
export const LIST_SCRIPT =
  "const fs=require('fs');const L=new Map();" +
  "for(const f of['/proc/net/tcp','/proc/net/tcp6']){let t='';try{t=fs.readFileSync(f,'utf8')}catch{continue}" +
  "for(const l of t.split('\\n').slice(1)){const c=l.trim().split(/\\s+/);if(c[3]!=='0A')continue;const p=parseInt(c[1].split(':').pop(),16);if(!L.has(p))L.set(p,c[9])}}" +
  'const I=new Map([...L].map(([p,i])=>[i,p]));const N=new Map();' +
  "for(const d of fs.readdirSync('/proc')){if(!/^\\d+$/.test(d))continue;let fds=[];try{fds=fs.readdirSync('/proc/'+d+'/fd')}catch{continue}" +
  "for(const fd of fds){let k;try{k=fs.readlinkSync('/proc/'+d+'/fd/'+fd)}catch{continue}const m=/^socket:\\[(\\d+)\\]$/.exec(k);" +
  "if(m&&I.has(m[1])&&!N.has(I.get(m[1]))){let n='';try{n=fs.readFileSync('/proc/'+d+'/comm','utf8').trim()}catch{}N.set(I.get(m[1]),n)}}}" +
  'process.stdout.write(JSON.stringify([...L.keys()].sort((a,b)=>a-b).map(p=>({port:p,process:N.get(p)||undefined}))))';

export interface AppPortsDeps {
  suffix: string | undefined;
  /** The portal's own port, and any more never to be opened. */
  portalPort: number;
  denyPorts?: number[];
  workspaces: {
    runtimeFor(target: string): Runtime | undefined;
    exec(target: string, name: string, command: string[]): Promise<ExecSession>;
    list(): Promise<Workspace[]>;
    hooks: {
      audit?: (e: {
        kind: string;
        actor: string;
        userId: string | null;
        subject?: string | null;
        detail?: Record<string, unknown>;
      }) => void;
    };
    resolve(ref: string): { id: string } | null;
  };
  sessionValid: (token: string) => boolean;
  /** Tests: another way into the workspace. */
  dial?: Dial;
  grants?: AppPortGrants;
  /** Tests: a shorter bound on an upgrade's dial and first answer. */
  upgradeTimeoutMs?: number;
  /** Idle timeouts and bridge caps (config.portProxy; defaults in proxy.ts). */
  limits?: ProxyLimits;
}

/**
 * Runs a command in the workspace and collects its output (bounded in time and size). The runtimes report the exit after the last output
 * (local: the child's `close`; Docker: the stream's end, then an inspect; Kubernetes: the socket's close after its frames; Connect: the result
 * frame after the data frames), but output already on its way may still be a tick behind (a PassThrough), so the exit is acted on one turn
 * later, as chat/files.ts does.
 */
async function collect(session: ExecSession, ms = 5000, max = 256 * 1024): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => (session.close(), resolve({ code: null, out: '' })), ms);
    session.onData((d) => {
      size += d.length;
      if (size <= max) chunks.push(d);
    });
    session.onExit((code) => {
      clearTimeout(timer);
      setImmediate(() => resolve({ code, out: Buffer.concat(chunks).toString('utf8') }));
    });
  });
}

export class AppPorts {
  readonly grants: AppPortGrants;
  readonly proxy: AppPortProxy;
  readonly denied: ReadonlySet<number>;

  constructor(private readonly d: AppPortsDeps) {
    this.grants = d.grants ?? new AppPortGrants();
    this.denied = new Set([d.portalPort, CDP_PORT, SUPERVISOR_PORT, ...(d.denyPorts ?? [])]);
    this.proxy = new AppPortProxy({
      suffix: d.suffix,
      grants: this.grants,
      dial: d.dial ?? createDialer(d.workspaces),
      sessionValid: d.sessionValid,
      deniedPorts: this.denied,
      upgradeTimeoutMs: d.upgradeTimeoutMs,
      limits: d.limits,
    });
    // A removed workspace's cookies are gone: its open sockets and requests go with them.
    this.grants.onForget = () => this.proxy.sweep();
  }

  /** Stops the proxy's sweep timer (tests, shutdown). */
  close(): void {
    this.proxy.close();
  }

  get enabled(): boolean {
    return !!this.d.suffix;
  }

  openable(port: number): boolean {
    return Number.isInteger(port) && port >= APP_PORT_MIN && port <= APP_PORT_MAX && !this.denied.has(port);
  }

  /** `GET …/ports`. Off: `{ enabled: false, ports: [] }` without touching the workspace. */
  async list(target: string, name: string): Promise<AppPortList> {
    if (!this.enabled) return { enabled: false, ports: [] };
    const { code, out } = await collect(await this.d.workspaces.exec(target, name, ['node', '-e', LIST_SCRIPT]));
    if (code !== 0) throw new AppError('CONFLICT', 'The workspace didn’t say which ports it listens on.');
    let rows: unknown;
    try {
      rows = JSON.parse(out);
    } catch {
      throw new AppError('CONFLICT', 'The workspace didn’t say which ports it listens on.');
    }
    const ports: AppPortItem[] = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const port = (r as { port?: unknown }).port;
      const proc = (r as { process?: unknown }).process;
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) continue;
      ports.push({ port, ...(typeof proc === 'string' && proc ? { process: proc.slice(0, 64) } : {}), openable: this.openable(port) });
    }
    return { enabled: true, ports };
  }

  /**
   * `POST …/ports/open`: a one-time code for `app-<name>-<port>.<suffix>`, audited. The seam already said `operate` (the route's guard).
   * `portalOrigin` is the page that asked (its Origin, checked same-host by the CSRF guard): the only page that may frame the app host.
   */
  async open(
    target: string,
    name: string,
    req: { port?: unknown; path?: unknown; name?: unknown },
    who: { actor: Actor; actorString: string; userId: string | null; sessionToken: string; portalOrigin: string },
  ): Promise<OpenAppPortResult> {
    if (!this.enabled) throw new AppError('NOT_FOUND', 'Not found.');
    const port = req.port;
    if (typeof port !== 'number' || !this.openable(port))
      throw new AppError('VALIDATION_FAILED', `A port from ${APP_PORT_MIN} to ${APP_PORT_MAX} that isn’t the portal’s own.`, {
        details: { port: 'Not a port that may be opened.' },
      });
    const path = req.path === undefined ? '/' : req.path;
    if (typeof path !== 'string' || !isAppPortNext(path))
      throw new AppError('VALIDATION_FAILED', 'A path on the app, starting with /.', { details: { path: 'Not a path.' } });
    if (req.name !== undefined && req.name !== null && (typeof req.name !== 'string' || req.name.length > 40))
      throw new AppError('VALIDATION_FAILED', 'A short app name.', { details: { name: 'At most 40 characters.' } });
    const app = typeof req.name === 'string' && req.name.trim() ? appHostSlug(req.name) : null;
    if (typeof req.name === 'string' && req.name.trim() && !app)
      throw new AppError('VALIDATION_FAILED', 'An app name with letters or digits.', { details: { name: 'Letters, digits and dashes.' } });
    const workspaceId = `${target}/${name}`;
    const all = await this.d.workspaces.list();
    const me = all.find((w) => w.id === workspaceId);
    if (!me) throw new AppError('NOT_FOUND', 'Not found.');
    // The host names the workspace by its label (owner, 2026-10-18: isnan-pod, not kohi-event), else by its name. Two workspaces with the
    // same slug can't both have app hosts: refused, never guessed.
    const slugOf = (w: { name: string; label?: string }) => appHostSlug(w.label) ?? appHostSlug(w.name);
    const slug = slugOf(me);
    if (!slug) throw new AppError('CONFLICT', 'This workspace’s name can’t be a host name. Give it a label with letters or digits.');
    if (all.filter((w) => slugOf(w) === slug).length > 1)
      throw new AppError('CONFLICT', `Another workspace is also called ${slug}: an app host needs a name of its own. Rename one of them.`);
    const origin = new URL(who.portalOrigin);
    const scheme = origin.protocol === 'https:' ? 'https' : 'http';
    const bare = appPortHost(slug, port, this.d.suffix!, app);
    if (!bare) throw new AppError('CONFLICT', 'The app and workspace names are too long for a host name (63 characters). Use a shorter app name.');
    const host = origin.port ? `${bare}:${origin.port}` : bare;
    const { code, expiresAt } = this.grants.mint({
      workspaceId,
      port,
      host,
      sessionToken: who.sessionToken,
      actor: who.actor,
      portalOrigin: origin.origin,
      scheme,
    });
    this.d.workspaces.hooks.audit?.({
      kind: 'workspace.port.open',
      actor: who.actorString,
      userId: who.userId,
      subject: this.d.workspaces.resolve(workspaceId)?.id ?? workspaceId,
      detail: { workspace: workspaceId, port, host: bare },
    });
    const q = new URLSearchParams({ code, next: path });
    return { url: `${scheme}://${host}${APP_PORT_AUTH_PATH}?${q.toString()}`, host, expiresAt: new Date(expiresAt).toISOString() };
  }
}
