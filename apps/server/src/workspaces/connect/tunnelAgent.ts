// Docker over the tunnel (docs/prd/targets-connect.md §12.3): an http.Agent whose connections are `docker` streams to a node's agent,
// so dockerode (and DockerRuntime above it) speaks the Docker Engine API through the tunnel exactly as through a unix socket. Each HTTP
// connection is one stream; the stream is shaped like a socket (the net.Socket stubs http calls on a pooled connection), and hijacked
// exec and attach (`Upgrade: tcp`) keep the stream as their raw byte pipe. Nothing listens anywhere.
import http from 'node:http';
import type { Duplex } from 'node:stream';
import Docker from 'dockerode';
import { ConnectError, type NodeLink } from '../../connect/seams.js';

/** How long an idle pooled connection is kept before its stream is closed (the agent caps streams per service). */
const FREE_SOCKET_MS = 15_000;

export class TunnelAgent extends http.Agent {
  constructor(
    private readonly link: Pick<NodeLink, 'open' | 'connected'>,
    private readonly service: 'docker' | 'kube' = 'docker',
  ) {
    // A few kept-alive connections: list, inspect and stats calls come in bursts; hijacked ones leave the pool for good.
    super({ keepAlive: true, maxFreeSockets: 4 });
  }

  // An idle pooled stream is closed after a while (a socket timeout would add a listener per request on a reused stream).
  readonly #idle = new WeakMap<object, NodeJS.Timeout>();

  override keepSocketAlive(socket: Duplex): boolean {
    // Node's own returns whether it kept the socket (its typings say void).
    const kept = (super.keepSocketAlive as (s: unknown) => unknown)(socket) !== false;
    if (kept) this.#idle.set(socket, setTimeout(() => socket.destroy(), FREE_SOCKET_MS).unref());
    return kept;
  }

  override reuseSocket(socket: Duplex, req: http.ClientRequest): void {
    clearTimeout(this.#idle.get(socket));
    this.#idle.delete(socket);
    super.reuseSocket(socket as never, req);
  }

  override createConnection(_options: unknown, cb: (err: Error | null, socket?: Duplex) => void): undefined {
    if (!this.link.connected()) {
      queueMicrotask(() => cb(new ConnectError('agent_offline', 'The node is offline.')));
      return undefined;
    }
    this.link.open(this.service).then(
      (stream) => cb(null, stream),
      (e: unknown) => cb(e instanceof Error ? e : new Error(String(e))),
    );
    return undefined;
  }
}

/** A dockerode client whose every connection is a `docker` stream to `link`'s agent. */
export function tunnelDocker(link: Pick<NodeLink, 'open' | 'connected'>): Docker {
  // docker-modem takes `agent` (its own SSH transport uses it the same way); dockerode's types leave it out.
  return new Docker({ protocol: 'http', host: 'tunnel.invalid', port: 2375, agent: new TunnelAgent(link) } as Docker.DockerOptions);
}
