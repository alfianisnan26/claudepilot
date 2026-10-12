// A minimal agent for server-side tests and QA scenarios (docs/prd/targets-connect.md §19.5): it enrolls through the real route, connects with the
// real tunnel library, keeps a control stream, sends a status, answers a rotation request, reconnects, and accepts the portal's streams with a
// handler of the caller's choice (an echo by default). It is NOT the product's agent (connect/agent/, T2): it has no services and no policy.
// Tests that need the real agent use `runAgent`; this one is for tests of the portal that want a connection without the agent's weight.

import { CONNECT_AGENT_VERSION, CONNECT_PROTOCOL, connectTunnelUrl, type ConnectAgentHello, type ConnectEnrollResult, type ConnectKind, type ConnectStatusMessage } from '@portal/contracts';
import { acceptService, dialTunnel, generateNodeKeyPair, openService, readJsonLines, signRekey, TunnelRejected, writeLine, type Dialled, type MuxStream, type NodeKeyPair } from '../tunnel/index.js';

export interface StubAgentOptions {
  /** The portal's origin (`http://127.0.0.1:3211`). */
  origin: string;
  /** The enrollment token; not needed once the agent has enrolled (a restart with `identity`). */
  token?: string;
  kind?: ConnectKind;
  hostname?: string;
  /** What it was enrolled as before (a restart). */
  identity?: { node: string; keys: NodeKeyPair };
  /** What the portal's streams get: the default echoes bytes back. `host` and `docker` streams both come here. */
  onStream?: (stream: MuxStream, service: string) => void;
  /** Extra headers on the upgrade (an address for a test rig behind a proxy). */
  headers?: Record<string, string>;
  /** Reconnect after a drop (default true), with a short wait: this agent is for tests. */
  reconnect?: boolean;
  /** The wait before a reconnect, a random value in this range (default 100 to 300 ms). */
  reconnectMs?: [number, number];
  statusEveryMs?: number;
  log?: (line: string) => void;
}

export interface StubAgent {
  readonly node: string | null;
  readonly keys: NodeKeyPair | null;
  /** Resolves when a tunnel is up (now, or after the next connect). */
  connected(timeoutMs?: number): Promise<void>;
  isConnected(): boolean;
  /** What the portal last told it (`revoked`, `notice`). */
  readonly told: { revoked: string | null; notices: string[] };
  /** The last refusal from the portal (`revoked`, `unknown_node`, ...). */
  readonly refused: string | null;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startStubAgent(opts: StubAgentOptions): Promise<StubAgent> {
  const kind = opts.kind ?? 'host';
  const log = opts.log ?? (() => undefined);
  let keys = opts.identity?.keys ?? null;
  let node = opts.identity?.node ?? null;
  let current: Dialled | null = null;
  let stopped = false;
  const told: StubAgent['told'] = { revoked: null, notices: [] };
  let refused: string | null = null;
  const waiters: (() => void)[] = [];

  const hello = (): ConnectAgentHello => ({
    agentVersion: CONNECT_AGENT_VERSION,
    agentBuild: 'stub00000000',
    protocol: CONNECT_PROTOCOL,
    os: 'linux',
    arch: 'x64',
    hostname: opts.hostname ?? 'stub-agent',
    mode: kind,
    runtime: kind === 'kubernetes' ? 'pod' : kind === 'host' ? 'host' : 'container',
    services: [{ name: kind === 'host' || kind === 'container' ? 'host' : kind === 'kubernetes' ? 'kube' : 'docker', ok: true }],
    clock: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  });

  if (!keys || !node) {
    if (!opts.token) throw new Error('A stub agent that has not enrolled needs a token.');
    keys = generateNodeKeyPair();
    const res = await fetch(`${opts.origin}/connect/v1/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}`, ...(opts.headers ?? {}) },
      body: JSON.stringify({ publicKey: keys.publicKey, hello: hello() }),
    });
    const body = (await res.json()) as { data?: ConnectEnrollResult; error?: { details?: { reason?: string } } };
    if (!res.ok || !body.data) throw new Error(`enroll refused: ${res.status} ${body.error?.details?.reason ?? ''}`);
    node = body.data.node;
  }

  const handle = (stream: MuxStream) => {
    void acceptService(stream, () => ({ ok: true })).then((req) => {
      if (!req) return;
      if (opts.onStream) opts.onStream(stream, req.service);
      else stream.pipe(stream); // echo
    });
  };

  const control = async (d: Dialled) => {
    const stream = await openService(d.session, { service: 'control' });
    const send = (m: unknown) => writeLine(stream, m).catch(() => undefined);
    const status = (): ConnectStatusMessage => ({ t: 'status', at: new Date().toISOString(), services: hello().services });
    await send(status());
    const timer = setInterval(() => void send(status()), opts.statusEveryMs ?? 30_000);
    timer.unref();
    d.session.onClose(() => clearInterval(timer));
    void (async () => {
      try {
        for await (const raw of readJsonLines(stream, 1_000_000)) {
          const m = raw as { t?: string; reason?: string; action?: string; message?: string };
          if (m.t === 'revoked') told.revoked = m.reason ?? '';
          else if (m.t === 'notice') {
            told.notices.push(m.message ?? '');
            if (m.action === 'rotate' && keys && node) {
              const next = generateNodeKeyPair();
              await send({ t: 'rekey', publicKey: next.publicKey, sig: signRekey(keys.privateKey, node, next.publicKey) });
              pendingKey = next;
            }
          } else if (m.t === 'rekey-answer' && (m as { ok?: boolean }).ok && pendingKey) {
            keys = pendingKey;
            pendingKey = null;
          }
        }
      } catch {
        // the connection ended
      }
    })();
  };
  let pendingKey: NodeKeyPair | null = null;

  const loop = (async () => {
    while (!stopped) {
      try {
        const d = await dialTunnel({ url: connectTunnelUrl(opts.origin), nodeId: node!, privateKey: keys!.privateKey, hello: hello, ws: { headers: opts.headers }, onStream: handle });
        current = d;
        refused = null;
        log(`stub agent ${node} connected`);
        for (const w of waiters.splice(0)) w();
        await control(d);
        await new Promise<void>((resolve) => d.session.onClose(() => resolve()));
        current = null;
      } catch (e) {
        refused = e instanceof TunnelRejected ? e.code : String((e as Error).message);
        log(`stub agent ${node} refused: ${refused}`);
        if (e instanceof TunnelRejected && ['revoked', 'unknown_node', 'target_removed'].includes(e.code)) return; // a real agent waits an hour: this one stops
      }
      if (stopped || opts.reconnect === false) return;
      const [lo, hi] = opts.reconnectMs ?? [100, 300];
      await sleep(lo + Math.random() * (hi - lo));
    }
  })();

  return {
    get node() {
      return node;
    },
    get keys() {
      return keys;
    },
    connected: (timeoutMs = 5_000) =>
      current && !current.session.closed
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('the stub agent did not connect in time')), timeoutMs);
            waiters.push(() => (clearTimeout(t), resolve()));
          }),
    isConnected: () => !!current && !current.session.closed,
    told,
    get refused() {
      return refused;
    },
    stop: async () => {
      stopped = true;
      current?.session.close(1000, 'stub agent stopped');
      await Promise.race([loop, sleep(1_000)]);
    },
  };
}
