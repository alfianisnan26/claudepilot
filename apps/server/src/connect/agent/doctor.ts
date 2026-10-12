// `pilot-agent doctor [--json]` (docs/prd/targets-connect.md §11.8): the checks of `CONNECT_DOCTOR_CHECKS`, in the vocabulary the installer
// uses too. Each says what it saw, and what to do about it in one line. `ok: null` means it does not apply here or could not be run.
import { constants, accessSync, statSync, statfsSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { delimiter, join } from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';
import {
  CONNECT_AGENT_VERSION,
  CONNECT_PROTOCOL,
  CONNECT_PUBLIC,
  CONNECT_SUBPROTOCOL,
  connectTunnelUrl,
  type ConnectDoctorCheck,
  type ConnectDoctorCheckId,
  type ConnectDoctorReport,
} from '@portal/contracts';
import { loadPty } from '../../workspaces/hostexec.js';
import { TUNNEL_WS_OPTIONS } from '../tunnel/ws.js';
import type { AgentConfig } from './config.js';
import { fingerprintOf, FileIdentityStore, IdentityError, type IdentityStore } from './identity.js';
import { describeNetError, httpRequest, proxyFor, proxyLabel, transportAgent, type NetConfig } from './net.js';
import { decide, type PolicyContext } from './services/docker/policy.js';
import { ExecIds } from './services/docker/execIds.js';
import { classify, normalizeTarget, ImageAllow, isRefusal } from './services/docker/rules.js';
import { DockerProxy } from './services/docker/proxy.js';
import { SA_DIR, inClusterServer } from './services/kube/index.js';
import { KubeProxy } from './services/kube/proxy.js';
import { silentLogger } from './log.js';

export interface DoctorOptions {
  config: AgentConfig;
  build: string;
  net: NetConfig;
  store: IdentityStore;
  now?: () => Date;
  /** Tests: where the Kubernetes API server, token and CA are. */
  kube?: { server?: string; tokenFile?: string; caFile?: string | null };
  /** Tests: the PATH to look for host tools on. */
  path?: string;
}

type Result = Omit<ConnectDoctorCheck, 'id'>;
const ok = (detail: string): Result => ({ ok: true, detail });
const bad = (detail: string, hint: string): Result => ({ ok: false, detail, hint });
const skip = (detail: string): Result => ({ ok: null, detail });

export async function runDoctor(opts: DoctorOptions): Promise<ConnectDoctorReport> {
  const { config } = opts;
  const checks: Record<ConnectDoctorCheckId, () => Promise<Result>> = {
    'portal.dns': () => portalDns(opts),
    'portal.tcp': () => portalTcp(opts),
    'portal.tls': () => portalTls(opts),
    'portal.health': () => portalHealth(opts),
    'portal.websocket': () => portalWebsocket(opts),
    'portal.proxy': async () => portalProxy(opts),
    clock: () => clockCheck(opts),
    identity: () => identityCheck(opts),
    'docker.socket': async () => dockerSocket(config),
    'docker.api': () => dockerApi(config),
    'docker.policy': async () => dockerPolicy(config),
    'kube.api': () => kubeApi(opts),
    'kube.rbac': () => kubeRbac(opts),
    'host.tools': async () => hostTools(opts),
    'host.pty': () => hostPty(config),
    disk: async () => diskCheck(config),
  };
  const out: ConnectDoctorCheck[] = [];
  for (const id of Object.keys(checks) as ConnectDoctorCheckId[]) {
    let r: Result;
    try {
      r = await checks[id]();
    } catch (e) {
      r = { ok: false, detail: `The check itself failed: ${(e as Error).message.slice(0, 120)}` };
    }
    out.push({ id, ...r });
  }
  return { agentVersion: CONNECT_AGENT_VERSION, agentBuild: opts.build, protocol: CONNECT_PROTOCOL, at: (opts.now ?? (() => new Date()))().toISOString(), checks: out };
}

/** The report as plain lines, one per check. */
export function formatReport(report: ConnectDoctorReport): string {
  const lines = [`pilot-agent ${report.agentVersion} (build ${report.agentBuild}, protocol ${report.protocol})`];
  for (const c of report.checks) {
    const mark = c.ok === true ? 'ok  ' : c.ok === false ? 'FAIL' : 'skip';
    lines.push(`${mark} ${c.id.padEnd(16)} ${c.detail}`);
    if (c.ok === false && c.hint) lines.push(`     -> ${c.hint}`);
  }
  return `${lines.join('\n')}\n`;
}

export const reportFailed = (report: ConnectDoctorReport): boolean => report.checks.some((c) => c.ok === false);

/* ---------------------------------------------------------------------------------------------------------------------------- *
 * The portal
 * ------------------------------------------------------------------------------------------------------------------------------- */

const portalUrl = (o: DoctorOptions): URL | null => {
  const raw = o.config.url;
  try {
    return raw ? new URL(raw) : null;
  } catch {
    return null;
  }
};

async function portalDns(o: DoctorOptions): Promise<Result> {
  const url = portalUrl(o);
  if (!url) return bad('No portal address is set.', 'Set PILOT_URL, or run the installer again.');
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) return ok(`${url.hostname} is an address`);
  if (proxyFor(url, o.net)) return skip('the proxy resolves it');
  try {
    const found = await lookup(url.hostname);
    return ok(`${url.hostname} is ${found.address}`);
  } catch (e) {
    return bad(`${url.hostname} does not resolve (${describeNetError(e).code}).`, 'Check the address and this machine’s DNS.');
  }
}

function portalTcp(o: DoctorOptions): Promise<Result> {
  const url = portalUrl(o);
  if (!url) return Promise.resolve(skip('no portal address'));
  const proxy = proxyFor(url, o.net);
  const host = (proxy ?? url).hostname.replace(/^\[|\]$/g, '');
  const port = Number((proxy ?? url).port) || ((proxy ?? url).protocol === 'https:' ? 443 : 80);
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 6000 });
    s.once('connect', () => (s.destroy(), resolve(ok(`${host}:${port} accepts connections${proxy ? ' (the proxy)' : ''}`))));
    s.once('timeout', () => (s.destroy(), resolve(bad(`${host}:${port} did not answer.`, 'Check the firewall, and the proxy (HTTPS_PROXY).'))));
    s.once('error', (e) => resolve(bad(`${host}:${port}: ${describeNetError(e).message}`, describeNetError(e).hint ?? 'Check the address and port.')));
  });
}

async function portalTls(o: DoctorOptions): Promise<Result> {
  const url = portalUrl(o);
  if (!url) return skip('no portal address');
  if (url.protocol !== 'https:') return skip('the portal address is plain http (loopback or a lab portal)');
  try {
    await httpRequest(new URL(CONNECT_PUBLIC.health, url), { timeoutMs: 8000 }, o.net);
    return ok(o.net.ca ? 'the certificate verifies against the private CA' : 'the certificate verifies');
  } catch (e) {
    const d = describeNetError(e);
    return bad(d.message, d.hint ?? 'Check the portal’s certificate.');
  }
}

async function portalHealth(o: DoctorOptions): Promise<Result> {
  const url = portalUrl(o);
  if (!url) return skip('no portal address');
  try {
    const res = await httpRequest(new URL(CONNECT_PUBLIC.health, url), { timeoutMs: 8000 }, o.net);
    if (res.status === 404) return bad('The portal answered 404: Connect is off or this is not a portal.', 'Check the address; an admin may have turned Connect off.');
    if (res.status !== 200) return bad(`The portal answered ${res.status}.`, 'Is something in front of it (an access proxy) blocking /connect/?');
    const body = JSON.parse(res.body.toString('utf8')) as { ok?: boolean; protocol?: number; version?: string };
    if (!body.ok) return bad('The portal says it is not ready.', 'Try again in a minute.');
    return ok(`portal ${body.version ?? '?'}, protocol ${body.protocol ?? '?'}${body.protocol && body.protocol > CONNECT_PROTOCOL ? ' (newer than this agent: update it)' : ''}`);
  } catch (e) {
    const d = describeNetError(e);
    return bad(d.message, d.hint ?? 'Run the installer’s doctor again.');
  }
}

/** A WebSocket upgrade, as far as the portal's challenge: proves a proxy in between lets the tunnel through. */
function portalWebsocket(o: DoctorOptions): Promise<Result> {
  const url = portalUrl(o);
  if (!url) return Promise.resolve(skip('no portal address'));
  const tunnel = connectTunnelUrl(url.origin);
  return new Promise((resolve) => {
    const ws = new WebSocket(tunnel, [CONNECT_SUBPROTOCOL], { ...TUNNEL_WS_OPTIONS, agent: transportAgent(new URL(tunnel), o.net), headers: o.net.headers ?? {}, handshakeTimeout: 8000 });
    const done = (r: Result) => {
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      ws.terminate();
      resolve(r);
    };
    ws.once('message', () => done(ok('the portal answered the upgrade with its challenge')));
    ws.once('unexpected-response', (_req, res) => done(bad(`The upgrade was answered with HTTP ${res.statusCode}.`, 'A proxy may be blocking WebSockets (Cloudflare Access: bypass /connect/; nginx: pass the Upgrade headers).')));
    ws.once('error', (e) => done(bad(describeNetError(e).message, 'WebSockets must reach the portal: check proxies and idle timeouts.')));
    ws.once('close', () => done(bad('The connection closed before the portal’s challenge.', 'A proxy may be cutting WebSockets.')));
  });
}

function portalProxy(o: DoctorOptions): Result {
  const url = portalUrl(o);
  const proxy = url ? proxyFor(url, o.net) : null;
  return ok(proxy ? `through ${proxyLabel(proxy)} (CONNECT)` : 'direct, no proxy');
}

async function clockCheck(o: DoctorOptions): Promise<Result> {
  const url = portalUrl(o);
  if (!url) return skip('no portal address');
  try {
    const res = await httpRequest(new URL(CONNECT_PUBLIC.health, url), { timeoutMs: 8000 }, o.net);
    const date = res.headers.date ? Date.parse(res.headers.date) : NaN;
    if (!Number.isFinite(date)) return skip('the portal sent no Date header');
    const skew = Math.round((Date.now() - date) / 1000);
    return Math.abs(skew) > 120 ? bad(`This machine’s clock is ${Math.abs(skew)} s ${skew > 0 ? 'ahead of' : 'behind'} the portal’s.`, 'Fix the time (NTP). Nothing depends on it, but the portal shows the skew.') : ok(`${Math.abs(skew)} s apart`);
  } catch {
    return skip('the portal could not be asked');
  }
}

/* ---------------------------------------------------------------------------------------------------------------------------- *
 * Identity
 * ------------------------------------------------------------------------------------------------------------------------------- */

async function identityCheck(o: DoctorOptions): Promise<Result> {
  try {
    const identity = await o.store.load();
    if (!identity) return bad(`No identity at ${o.store.describe()}.`, 'Enroll: run the command from the portal’s Targets page.');
    const detail = `node ${identity.node}, fingerprint ${fingerprintOf(identity)}`;
    if (o.store instanceof FileIdentityStore) {
      const mode = await o.store.mode();
      if (mode !== null && (mode & 0o077) !== 0) return bad(`${detail}; the file is readable by others (mode ${mode.toString(8)}).`, `chmod 600 ${o.store.describe()}`);
    }
    return ok(detail);
  } catch (e) {
    if (e instanceof IdentityError) return bad(e.message, 'Restore the file from a backup, or revoke the node and enroll again.');
    return bad(`The identity could not be read (${(e as NodeJS.ErrnoException).code ?? 'ERR'}).`, 'Check the data folder’s permissions.');
  }
}

/* ---------------------------------------------------------------------------------------------------------------------------- *
 * Docker
 * ------------------------------------------------------------------------------------------------------------------------------- */

const offers = (c: AgentConfig, s: 'docker' | 'kube' | 'host') => c.services.includes(s);

function dockerSocket(c: AgentConfig): Result {
  if (!offers(c, 'docker')) return skip('this agent does not use Docker');
  try {
    const st = statSync(c.dockerSocket);
    if (!st.isSocket()) return bad(`${c.dockerSocket} is not a socket.`, 'Point PILOT_DOCKER_SOCKET at Docker’s socket.');
    accessSync(c.dockerSocket, constants.R_OK | constants.W_OK);
    return ok(`${c.dockerSocket} is usable`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return bad(`${c.dockerSocket} does not exist.`, 'Is Docker running? On Windows or macOS, start Docker Desktop (Linux containers).');
    if (code === 'EACCES') return bad(`No permission to use ${c.dockerSocket}.`, 'Add your user to the docker group, or run the command with sudo (the wizard shows the sudo line).');
    return bad(`${c.dockerSocket}: ${code ?? 'error'}.`, 'Check the socket path.');
  }
}

async function dockerApi(c: AgentConfig): Promise<Result> {
  if (!offers(c, 'docker')) return skip('this agent does not use Docker');
  const proxy = new DockerProxy({ socket: c.dockerSocket, images: new ImageAllow([]), allowBinds: [], portalId: () => null, log: silentLogger });
  try {
    const [v, i] = await Promise.all([proxy.daemon('/version', 5000), proxy.daemon('/info', 5000)]);
    const version = JSON.parse(v.body.toString('utf8')) as { Version?: string; ApiVersion?: string; Os?: string };
    const info = JSON.parse(i.body.toString('utf8')) as { OSType?: string; SecurityOptions?: string[]; OperatingSystem?: string };
    if ((info.OSType ?? version.Os) === 'windows') return bad('Docker is running Windows containers.', 'Switch Docker Desktop to Linux containers.');
    if (info.SecurityOptions?.some((s) => /rootless/.test(s))) return bad('Docker is rootless.', 'Rootless Docker is not supported in this version: use a rootful Docker.');
    if (/podman/i.test(JSON.stringify(info.OperatingSystem ?? ''))) return bad('This looks like Podman.', 'Podman is not supported in this version.');
    return ok(`Docker ${version.Version ?? '?'}, API ${version.ApiVersion ?? '?'}`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'ERR';
    return bad(`Docker did not answer (${code}).`, code === 'EACCES' ? 'No permission to use the socket: docker group or sudo.' : 'Is Docker running?');
  } finally {
    proxy.close();
  }
}

/** The policy's own self-test: a privileged create and an exec on a stranger must be refused. Runs the same code the proxy runs, with no daemon. */
async function dockerPolicy(c: AgentConfig): Promise<Result> {
  if (!offers(c, 'docker')) return skip('this agent does not use Docker');
  const ctx: PolicyContext = {
    portalId: () => 'doctor-portal',
    images: new ImageAllow(['doctor-image:latest']),
    allowBinds: [],
    resolve: async () => ({ state: 'found', id: 'a'.repeat(64), labels: {} }),
    execs: new ExecIds(),
  };
  const labels = { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'x', 'claudepilot.portal': 'doctor-portal' };
  const attempts: [string, string, string, unknown, string][] = [
    ['POST', '/containers/create?name=claudepilot-x', 'create', { Image: 'doctor-image:latest', Labels: labels, HostConfig: { Privileged: true } }, 'create.privileged'],
    ['POST', '/containers/create?name=claudepilot-x', 'create', { Image: 'doctor-image:latest', Labels: labels, HostConfig: { Binds: ['/:/host'] } }, 'create.bind'],
    ['POST', '/containers/abc/exec', 'exec', { Cmd: ['sh'] }, 'unmanaged'],
  ];
  for (const [method, target, , body, expected] of attempts) {
    const t = normalizeTarget(target);
    if (isRefusal(t)) return bad('The policy self-test could not run.', 'This is a bug: update the agent.');
    const route = classify(method, t.path);
    if (isRefusal(route)) return bad('The policy self-test could not run.', 'This is a bug: update the agent.');
    const d = await decide({ method, target: t, route, body, upgrade: false }, ctx);
    if (d.allow || d.rule !== expected) return bad(`The policy would allow ${expected}.`, 'This is a bug: stop the agent and update it.');
  }
  return ok('a privileged create, a host mount and an exec on a stranger are all refused');
}

/* ---------------------------------------------------------------------------------------------------------------------------- *
 * Kubernetes
 * ------------------------------------------------------------------------------------------------------------------------------- */

function kubeProxy(o: DoctorOptions): KubeProxy | null {
  const server = o.kube?.server ?? inClusterServer();
  if (!server) return null;
  return new KubeProxy({
    server,
    tokenFile: o.kube?.tokenFile ?? `${SA_DIR}/token`,
    caFile: o.kube?.caFile === undefined ? `${SA_DIR}/ca.crt` : o.kube.caFile,
    namespace: o.config.kubeNamespace ?? 'claudepilot-workspaces',
    localToken: () => null,
    log: silentLogger,
  });
}

async function kubeApi(o: DoctorOptions): Promise<Result> {
  if (!offers(o.config, 'kube')) return skip('this agent does not use Kubernetes');
  let proxy: KubeProxy | null = null;
  try {
    proxy = kubeProxy(o);
    if (!proxy) return bad('Not running in a cluster (no KUBERNETES_SERVICE_HOST).', 'This agent mode runs as the connector’s pod.');
    const res = await proxy.api('GET', '/version', { timeoutMs: 6000 });
    if (res.status !== 200) return bad(`The API server answered ${res.status}.`, 'Check the service account.');
    return ok(`Kubernetes ${(JSON.parse(res.body.toString('utf8')) as { gitVersion?: string }).gitVersion ?? '?'}`);
  } catch (e) {
    return bad(`The API server did not answer (${(e as NodeJS.ErrnoException).code ?? (e as Error).message.slice(0, 60)}).`, 'Check the pod’s network policy, service account token and CA.');
  } finally {
    proxy?.close();
  }
}

/** What the connector's Role grants (PRD §13.5): the verbs the proxy needs, asked of the API server with SelfSubjectAccessReview. */
export const RBAC_NEEDS: { group: string; resource: string; subresource?: string; verbs: string[] }[] = [
  { group: '', resource: 'pods', verbs: ['get', 'list', 'watch'] },
  { group: '', resource: 'pods', subresource: 'exec', verbs: ['create', 'get'] },
  { group: '', resource: 'persistentvolumeclaims', verbs: ['get', 'list', 'create', 'delete'] },
  { group: '', resource: 'secrets', verbs: ['get', 'list', 'create', 'update', 'patch', 'delete'] },
  { group: 'apps', resource: 'deployments', verbs: ['get', 'list', 'create', 'update', 'patch', 'delete'] },
  { group: 'apps', resource: 'deployments', subresource: 'scale', verbs: ['get', 'update', 'patch'] },
  { group: 'metrics.k8s.io', resource: 'pods', verbs: ['get', 'list'] },
];

async function kubeRbac(o: DoctorOptions): Promise<Result> {
  if (!offers(o.config, 'kube')) return skip('this agent does not use Kubernetes');
  const proxy = kubeProxy(o);
  if (!proxy) return skip('not running in a cluster');
  const namespace = o.config.kubeNamespace ?? 'claudepilot-workspaces';
  try {
    const missing: string[] = [];
    for (const need of RBAC_NEEDS) {
      for (const verb of need.verbs) {
        const body = JSON.stringify({ apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview', spec: { resourceAttributes: { namespace, verb, group: need.group, resource: need.resource, ...(need.subresource ? { subresource: need.subresource } : {}) } } });
        const res = await proxy.api('POST', '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', { body, headers: { 'content-type': 'application/json' } });
        if (res.status !== 201 && res.status !== 200) return bad(`The access review was refused (${res.status}).`, 'The service account may not ask what it can do; check the Role by hand with kubectl auth can-i.');
        if (!(JSON.parse(res.body.toString('utf8')) as { status?: { allowed?: boolean } }).status?.allowed) missing.push(`${verb} ${need.resource}${need.subresource ? `/${need.subresource}` : ''}`);
      }
    }
    return missing.length ? bad(`The Role is missing: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` and ${missing.length - 6} more` : ''}.`, 'Apply the connector’s manifest again (it creates the Role).') : ok(`the Role grants every verb the connector needs in ${namespace}`);
  } catch (e) {
    return bad(`The access review failed (${(e as NodeJS.ErrnoException).code ?? 'ERR'}).`, 'Check the API server and the service account.');
  } finally {
    proxy.close();
  }
}

/* ---------------------------------------------------------------------------------------------------------------------------- *
 * The host
 * ------------------------------------------------------------------------------------------------------------------------------- */

function onPath(tool: string, path: string): boolean {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, tool), constants.X_OK);
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

function hostTools(o: DoctorOptions): Result {
  if (!offers(o.config, 'host')) return skip('this agent does not run commands');
  const path = o.path ?? process.env.PATH ?? '';
  const need = ['tmux', 'git', 'bash', ...(process.platform === 'darwin' ? ['jq', 'flock', 'setsid'] : [])];
  const missing = need.filter((t) => !onPath(t, path));
  if (!missing.length) return ok(`${need.join(', ')} found`);
  const hint = process.platform === 'darwin' ? 'Install them: brew install tmux jq util-linux' : `Install ${missing.join(', ')} with the system’s package manager.`;
  return bad(`Missing: ${missing.join(', ')}.`, hint);
}

async function hostPty(c: AgentConfig): Promise<Result> {
  if (!offers(c, 'host')) return skip('this agent does not run commands');
  try {
    await loadPty();
    return ok('terminals are available');
  } catch {
    return bad('Terminal support (@lydell/node-pty) is not installed.', 'Run the installer again, or npm install @lydell/node-pty next to the agent. Commands without a terminal still work.');
  }
}

function diskCheck(c: AgentConfig): Result {
  try {
    const s = statfsSync(c.dataDir);
    const freeMb = Math.round((s.bavail * s.bsize) / 1024 / 1024);
    return freeMb < 200 ? bad(`${freeMb} MB free under ${c.dataDir}.`, 'Free some disk space: the agent keeps a log and its bundles there.') : ok(`${freeMb} MB free`);
  } catch {
    try {
      const s = statfsSync('/');
      const freeMb = Math.round((s.bavail * s.bsize) / 1024 / 1024);
      return freeMb < 200 ? bad(`${freeMb} MB free.`, 'Free some disk space.') : ok(`${freeMb} MB free (the data folder does not exist yet)`);
    } catch {
      return skip('free space is unknown here');
    }
  }
}
