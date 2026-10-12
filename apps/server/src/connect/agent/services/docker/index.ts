// The `docker` service (docs/prd/targets-connect.md §11.4): every stream is the server side of an HTTP connection to the Docker Engine
// API, filtered by the policy of appendix A. This file is the agent's side of it: one proxy, the daemon's health (`status()`), what
// the daemon says about itself for the status message, and the counters of what the policy refused.
import type { ConnectDockerInfo, ConnectServiceStatus, ConnectStatusMessage } from '@portal/contracts';
import type { TunnelStream } from '../../../seams.js';
import type { Logger } from '../../log.js';
import type { AgentService, StreamRefusal } from '../types.js';
import { DockerProxy } from './proxy.js';
import { ImageAllow } from './rules.js';

export interface DockerServiceOptions {
  /** The Docker daemon's unix socket (PILOT_DOCKER_SOCKET). */
  socket: string;
  /** The references containers may be created from (PILOT_IMAGES plus `docker.allowImages`). */
  images: string[];
  /** Host path prefixes allowed as bind sources: the host operator's local widening (`docker.allowBinds`), empty by default. */
  allowBinds?: string[];
  /** The portal's id as the agent pinned it (null before the first welcome). */
  portalId: () => string | null;
  log: Logger;
  idleMs?: number;
  resolveTtlMs?: number;
  now?: () => number;
}

export type DockerService = AgentService & { readonly proxy: DockerProxy };

const unreachable = new Set(['ENOENT', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTSOCK']);

/** A daemon error as the status line puts it: short, with what to do. */
function explain(e: unknown, socket: string): { text: string; code: string } {
  const code = (e as NodeJS.ErrnoException).code ?? 'ERR';
  if (code === 'ENOENT') return { code, text: `The Docker socket ${socket} was not found.` };
  if (code === 'EACCES') return { code, text: `No permission to use ${socket}: use the docker group, or run the command with sudo.` };
  if (code === 'ECONNREFUSED') return { code, text: `Docker is not accepting connections on ${socket}.` };
  return { code, text: `Docker did not answer on ${socket} (${code}).` };
}

export function createService(opts: DockerServiceOptions): DockerService {
  const allowed = new ImageAllow(opts.images);
  let changed: (() => void) | undefined;
  const proxy = new DockerProxy({
    socket: opts.socket,
    images: allowed,
    allowBinds: opts.allowBinds ?? [],
    portalId: opts.portalId,
    log: opts.log,
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
    ...(opts.resolveTtlMs !== undefined ? { resolveTtlMs: opts.resolveTtlMs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    onChange: (why) => {
      // A refusal changes the counters; a daemon that stopped answering changes the health: look again before saying so.
      if (why === 'upstream') void refresh().then(() => changed?.());
      else changed?.();
    },
  });

  let status: ConnectServiceStatus = { name: 'docker', ok: false, error: 'Not checked yet.' };
  let last: { code: string } | null = null;
  /** When the daemon last answered a probe: a stream is only accepted on an answer less than 3 s old. */
  let probedAt = 0;
  let info: ConnectDockerInfo | undefined;
  let swarm: ConnectStatusMessage['swarm'];

  const refresh = async () => {
    try {
      const [v, i] = await Promise.all([proxy.daemon('/version', 4000), proxy.daemon('/info', 4000)]);
      if (v.status !== 200 || i.status !== 200) throw Object.assign(new Error('unexpected answer'), { code: `HTTP${v.status}` });
      const version = JSON.parse(v.body.toString('utf8')) as { Version?: string; ApiVersion?: string };
      const engine = JSON.parse(i.body.toString('utf8')) as Record<string, unknown> & { Swarm?: { LocalNodeState?: string; NodeID?: string; ControlAvailable?: boolean } };
      const str = (x: unknown, d = '') => (typeof x === 'string' ? x : d);
      const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
      info = {
        engine: str(version.Version, str(engine.ServerVersion)),
        apiVersion: str(version.ApiVersion),
        os: str(engine.OSType, 'linux'),
        arch: str(engine.Architecture),
        ncpu: num(engine.NCPU),
        memTotal: num(engine.MemTotal),
        containers: num(engine.Containers),
        running: num(engine.ContainersRunning),
        desktop: /docker desktop/i.test(str(engine.OperatingSystem)) || str(engine.Name) === 'docker-desktop',
        images: allowed.list(),
      };
      swarm = engine.Swarm?.LocalNodeState === 'active' && engine.Swarm.NodeID ? { nodeId: engine.Swarm.NodeID, role: engine.Swarm.ControlAvailable ? 'manager' : 'worker' } : undefined;
      status = { name: 'docker', ok: true, version: info.engine };
      last = null;
      probedAt = Date.now();
    } catch (e) {
      const why = explain(e, opts.socket);
      if (last?.code !== why.code) opts.log.warn('docker.unavailable', { code: why.code });
      last = { code: why.code };
      status = { name: 'docker', ok: false, error: why.text };
    }
  };

  return {
    name: 'docker',
    proxy,

    async accept(): Promise<StreamRefusal | null> {
      // A daemon that died since the last status is found here, not by the first request that fails on a stream that was accepted.
      if (!status.ok || Date.now() - probedAt > 3000) await refresh();
      if (status.ok) return null;
      return { code: last && unreachable.has(last.code) ? 'upstream_unreachable' : 'service_unavailable', message: status.error ?? 'Docker is not available.' };
    },

    handle(stream: TunnelStream, trace: string) {
      proxy.serve(stream, trace);
    },

    status: () => status,
    refresh,
    onChange: (fn) => void (changed = fn),

    report() {
      const denied = proxy.takeDenied();
      return { ...(info ? { docker: info } : {}), ...(swarm ? { swarm } : {}), ...(denied.length ? { denied } : {}) };
    },

    close() {
      proxy.close();
    },
  };
}
