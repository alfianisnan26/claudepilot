// The agent's tunnel client (docs/prd/targets-connect.md §9, §10): enroll if there is a token and no identity, connect, serve the portal's
// streams, and come back whatever happens. `runAgent(opts)` runs the real agent in-process against any portal URL and any fake upstreams:
// the program (`main.ts`) is a thin caller, and T1's, T3's and T6's integration tests call it directly.
//
// Reconnect: full-jitter exponential backoff from 1 s to 60 s, reset after a connection held 30 s, `retryAfterS` honoured. After a fatal
// rejection (`unknown_node`, `revoked`, `target_removed`, `upgrade_required`, `portal_mismatch`) the agent logs loudly, waits an hour, and
// tries again: it never exits (a restart policy would only loop). A drop closes every stream; nothing is replayed.
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONNECT_AGENT_VERSION,
  CONNECT_LIMITS,
  CONNECT_REJECT_FATAL,
  connectTunnelUrl,
  type ConnectAgentHello,
  type ConnectByeMessage,
  type ConnectConfigMessage,
  type ConnectRekeyAnswer,
  type ConnectStatusMessage,
} from '@portal/contracts';
import { generateNodeKeyPair, signRekey } from '../tunnel/auth.js';
import { acceptService, dialTunnel, TunnelConnectError, TunnelRejected, type MuxSession, type MuxStream, type OpenDecision } from '../tunnel/index.js';
import { defaultDataDir, MODE_SERVICES, type AgentConfig } from './config.js';
import { ControlChannel } from './control.js';
import { EnrollError, enroll } from './enroll.js';
import { FileIdentityStore, IdentityError, fingerprintOf, type Identity, type IdentityStore } from './identity.js';
import { KubeSecretIdentityStore } from './identity.kube.js';
import { createLogger, type Logger } from './log.js';
import { transportAgent, type NetConfig } from './net.js';
import { buildHello } from './hello.js';
import { createServices, type ServiceDeps } from './services/index.js';
import type { AgentService, ServiceName } from './services/types.js';

export type AgentState = 'starting' | 'enrolling' | 'connecting' | 'connected' | 'waiting' | 'stopped';

export interface AgentClock {
  /** Resolves after `ms`, or rejects (AbortError) when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  /** In [0, 1). */
  random(): number;
}

export const realClock: AgentClock = {
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'));
      const timer = setTimeout(() => (signal.removeEventListener('abort', onAbort), resolve()), ms);
      const onAbort = () => (clearTimeout(timer), reject(new Error('aborted')));
      signal.addEventListener('abort', onAbort, { once: true });
    }),
  now: () => Date.now(),
  random: () => Math.random(),
};

export interface AgentEvents {
  /** The tunnel is up: the welcome came and the control stream is open. */
  connected: [{ node: string; build: string | null }];
  disconnected: [{ heldMs: number; code: number | null; reason: string }];
  enrolled: [Identity];
  /** The portal refused the connection (or an enrollment): `code` is a reject code or an enroll failure. */
  refused: [{ code: string; message: string; fatal: boolean; waitMs: number }];
  rekeyed: [{ fingerprint: string }];
  /** The portal told the agent it was revoked. */
  revoked: [{ reason: string }];
  state: [AgentState];
}

export interface RunAgentOptions {
  config: AgentConfig;
  log?: Logger;
  identityStore?: IdentityStore;
  /** The agent's build id (first 12 hex of its bundle's sha256) and version. */
  build?: string;
  version?: string;
  net?: NetConfig;
  hostname?: string;
  clock?: AgentClock;
  /** Services made by the caller (a fake upstream), the rest built from `config`. */
  services?: Partial<Record<ServiceName, AgentService>>;
  /** Kubernetes and host overrides for the service factory (a test's fake API server, a temporary home). */
  serviceDeps?: Pick<ServiceDeps, 'kube' | 'host'>;
  /** The reconnect and wait parameters; tests shrink them. */
  timing?: { fatalMs?: number; notEnrolledPollMs?: number; rekeyWaitMs?: number };
  /** Called at each step of a key rotation; throwing simulates a crash right there (the agent dies without cleanup). */
  rotationHook?: (step: 'saved-next' | 'rekey-sent' | 'answered' | 'promoted') => void | Promise<void>;
}

export interface AgentHandle {
  readonly events: EventEmitter<AgentEvents>;
  state(): AgentState;
  connected(): boolean;
  identity(): Identity | null;
  services(): Map<ServiceName, AgentService>;
  /** Resolves when the tunnel is up (now, or the next time); rejects after `ms`. */
  whenConnected(ms?: number): Promise<void>;
  /** A graceful stop: `bye`, GO_AWAY, close, services closed. */
  stop(reason?: ConnectByeMessage['reason']): Promise<void>;
  /** Dies at once, like a crash: no bye, no cleanup. */
  kill(): void;
  /** Resolves when the agent has stopped (stop or kill). */
  readonly done: Promise<void>;
}

class Crash extends Error {}

export function runAgent(options: RunAgentOptions): AgentHandle {
  const runtime = new AgentRuntime(options);
  return runtime.start();
}

class AgentRuntime {
  readonly #opts: RunAgentOptions;
  readonly #config: AgentConfig;
  readonly #log: Logger;
  readonly #clock: AgentClock;
  readonly #abort = new AbortController();
  readonly #events = new EventEmitter<AgentEvents>();
  readonly #startedAt = new Date().toISOString();
  readonly #build: string;
  readonly #version: string;
  readonly #net: NetConfig;
  readonly #open: Record<ServiceName, number> = { docker: 0, kube: 0, host: 0 };
  readonly #fatalMs: number;

  #state: AgentState = 'starting';
  #identity: Identity | null = null;
  #store!: IdentityStore;
  #services = new Map<ServiceName, AgentService>();
  #session: MuxSession | null = null;
  #control: ControlChannel | null = null;
  #portalConfig: ConnectConfigMessage | null = null;
  #statusTimer: ReturnType<typeof setInterval> | null = null;
  #rekeyWaiter: ((a: ConnectRekeyAnswer) => void) | null = null;
  #rotating = false;
  #byeReason: ConnectByeMessage['reason'] | null = null;
  #remote: ((level: 'warn' | 'error', message: string) => void) | null = null;
  #connectedWaiters: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | undefined }[] = [];
  #loop: Promise<void> = Promise.resolve();
  #resolveDone!: () => void;
  readonly #done = new Promise<void>((r) => (this.#resolveDone = r));
  #stopping = false;

  constructor(opts: RunAgentOptions) {
    this.#opts = opts;
    this.#config = opts.config;
    this.#clock = opts.clock ?? realClock;
    this.#build = opts.build ?? '000000000000';
    this.#version = opts.version ?? CONNECT_AGENT_VERSION;
    this.#fatalMs = opts.timing?.fatalMs ?? CONNECT_LIMITS.reconnect.fatalMs;
    this.#log =
      opts.log ??
      createLogger({
        level: this.#config.logLevel,
        ...(this.#config.mode === 'host' ? { file: { path: join(this.#config.dataDir, 'logs', 'agent.log') } } : {}),
      });
    // Warnings and errors also go to the portal while connected, whatever logger the caller gave: `setRemote` is on every logger `createLogger` makes.
    this.#net = { headers: this.#config.headers, ...(opts.net ?? {}) };
    for (const v of Object.values(this.#config.headers)) this.#log.addSecret(v);
    if (this.#config.enrollToken) this.#log.addSecret(this.#config.enrollToken);
  }

  /* ------------------------------------------------------------------------------------------------------------------------ *
   * Public handle
   * ------------------------------------------------------------------------------------------------------------------------ */

  start(): AgentHandle {
    const self = this;
    this.#loop = this.#run().catch((e) => {
      if (!(e instanceof Crash)) this.#log.error('agent.crashed', { code: (e as NodeJS.ErrnoException).code ?? 'ERR' });
    }).finally(() => {
      this.#setState('stopped');
      this.#resolveDone();
    });
    return {
      events: this.#events,
      state: () => this.#state,
      connected: () => this.#state === 'connected',
      identity: () => this.#identity,
      services: () => this.#services,
      whenConnected: (ms = 15_000) => this.#whenConnected(ms),
      stop: (reason) => this.#stop(reason ?? this.#detectReason()),
      kill: () => self.#kill(),
      done: this.#done,
    };
  }

  #setState(state: AgentState) {
    if (this.#state === state) return;
    this.#state = state;
    this.#events.emit('state', state);
    if (state === 'connected') for (const w of this.#connectedWaiters.splice(0)) (clearTimeout(w.timer), w.resolve());
  }

  #whenConnected(ms: number): Promise<void> {
    if (this.#state === 'connected') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      waiter.timer = setTimeout(() => {
        this.#connectedWaiters = this.#connectedWaiters.filter((w) => w !== waiter);
        reject(new Error(`The agent did not connect within ${ms} ms (state: ${this.#state}).`));
      }, ms);
      waiter.timer.unref();
      this.#connectedWaiters.push(waiter);
    });
  }

  /** The installer leaves a marker file before it stops the agent for an upgrade or an uninstall; the agent then says so in `bye`. */
  #detectReason(): ConnectByeMessage['reason'] {
    for (const [file, reason] of [['uninstalling', 'uninstall'], ['upgrading', 'upgrade']] as const) {
      if (existsSync(join(this.#config.dataDir, file))) return reason;
    }
    return 'shutdown';
  }

  async #stop(reason: ConnectByeMessage['reason']): Promise<void> {
    if (this.#stopping) return this.#done;
    this.#stopping = true;
    this.#byeReason = reason;
    const control = this.#control;
    if (control?.open) {
      await Promise.race([control.bye(reason), new Promise((r) => setTimeout(r, 1000).unref())]);
    }
    this.#session?.goAway();
    this.#session?.close(1000, 'agent stopping');
    // The abort ends a wait, gives up a dial in flight, and closes the session a dial returns after this point (`#serve` listens).
    this.#abort.abort();
    return this.#done;
  }

  #kill() {
    this.#stopping = true;
    this.#session?.destroy('killed');
    this.#abort.abort();
    this.#closeServices();
  }

  #closeServices() {
    for (const s of this.#services.values()) {
      try {
        s.close();
      } catch {
        // already closed
      }
    }
  }

  /* ------------------------------------------------------------------------------------------------------------------------ *
   * The loop
   * ------------------------------------------------------------------------------------------------------------------------ */

  async #sleep(ms: number): Promise<boolean> {
    try {
      await this.#clock.sleep(ms, this.#abort.signal);
      return true;
    } catch {
      return false;
    }
  }

  async #run(): Promise<void> {
    const cfg = this.#config;
    const log = this.#log;
    this.#services = createServices({
      config: cfg,
      log,
      portalId: () => this.#identity?.portalId ?? null,
      kubeLocalToken: () => this.#portalConfig?.kubeLocalToken ?? null,
      provided: this.#opts.services,
      ...(this.#opts.serviceDeps ?? {}),
    });
    for (const service of this.#services.values()) service.onChange?.(() => this.#control?.status(() => this.#buildStatus()));
    this.#store = this.#opts.identityStore ?? this.#makeStore();
    await this.#probe();

    // 1. An identity, or an enrollment, or a wait.
    while (!this.#abort.signal.aborted && !(await this.#ensureIdentity())) {
      if (!(await this.#sleep(this.#opts.timing?.notEnrolledPollMs ?? 30_000))) return this.#finish();
    }
    if (this.#abort.signal.aborted) return this.#finish();

    // 2. Connect, serve, come back.
    let attempt = 0;
    while (!this.#abort.signal.aborted) {
      this.#setState('connecting');
      const started = this.#clock.now();
      const outcome = await this.#connectOnce();
      if (this.#abort.signal.aborted) break;
      const held = this.#clock.now() - started;
      if (outcome.kind === 'fatal') {
        log.error('connect.fatal', { code: outcome.code, message: outcome.message, retryInS: Math.round(this.#fatalMs / 1000) });
        this.#events.emit('refused', { code: outcome.code, message: outcome.message, fatal: true, waitMs: this.#fatalMs });
        this.#setState('waiting');
        if (!(await this.#sleep(this.#fatalMs))) break;
        attempt = 0;
        continue;
      }
      if (held >= CONNECT_LIMITS.reconnect.healthyAfterMs) attempt = 0;
      else attempt++;
      const cap = Math.min(CONNECT_LIMITS.reconnect.maxMs, CONNECT_LIMITS.reconnect.minMs * 2 ** Math.min(attempt, 10));
      let wait = Math.max(100, Math.floor(this.#clock.random() * cap));
      if (outcome.kind === 'refused' && outcome.retryAfterS) wait = Math.max(wait, outcome.retryAfterS * 1000);
      if (outcome.kind === 'refused') this.#events.emit('refused', { code: outcome.code, message: outcome.message, fatal: false, waitMs: wait });
      this.#setState('waiting');
      log.info('connect.retry', { inMs: wait, attempt });
      if (!(await this.#sleep(wait))) break;
    }
    return this.#finish();
  }

  async #finish(): Promise<void> {
    this.#stopTimers();
    this.#closeServices();
  }

  #makeStore(): IdentityStore {
    const cfg = this.#config;
    if (cfg.mode === 'kubernetes' && cfg.identitySecret && cfg.kubeNamespace) {
      const kube = this.#services.get('kube') as (AgentService & { proxy: { api: ConstructorParameters<typeof KubeSecretIdentityStore>[0] } }) | undefined;
      if (!kube) throw new Error('The kubernetes mode needs the kube service.');
      return new KubeSecretIdentityStore((m, p, o) => kube.proxy.api(m, p, o), cfg.kubeNamespace, cfg.identitySecret);
    }
    return new FileIdentityStore(cfg.dataDir || defaultDataDir(cfg.mode));
  }

  /** Looks at every service once, quickly, so the hello says what works. */
  async #probe(): Promise<void> {
    await Promise.race([
      Promise.allSettled([...this.#services.values()].map((s) => s.refresh?.())),
      new Promise((r) => setTimeout(r, 4000).unref()),
    ]);
  }

  /**
   * Loads the identity, or enrolls with the token this agent was given. True when it has one now. A damaged identity file is never
   * overwritten: that would be throwing away the key the portal knows; the agent says so and waits.
   */
  async #ensureIdentity(): Promise<boolean> {
    const log = this.#log;
    try {
      this.#identity = await this.#store.load();
    } catch (e) {
      if (e instanceof IdentityError) {
        log.error('identity.damaged', { where: this.#store.describe() });
        this.#events.emit('refused', { code: 'identity_damaged', message: e.message, fatal: true, waitMs: this.#opts.timing?.notEnrolledPollMs ?? 30_000 });
        this.#setState('waiting');
        return false;
      }
      log.error('identity.unreadable', { code: (e as NodeJS.ErrnoException).code ?? 'ERR' });
      this.#setState('waiting');
      return false;
    }
    if (this.#identity) {
      if (this.#config.enrollToken) log.info('enroll.skipped', { reason: 'already enrolled' });
      log.info('identity.loaded', { node: this.#identity.node, target: this.#identity.target, fingerprint: fingerprintOf(this.#identity) });
      return true;
    }
    const token = this.#config.enrollToken;
    if (!token) {
      log.error('identity.missing', { hint: 'run `pilot-agent enroll` or set PILOT_ENROLL_TOKEN', where: this.#store.describe() });
      this.#setState('waiting');
      return false;
    }
    if (!this.#config.url) {
      log.error('config.url_missing', { hint: 'set PILOT_URL' });
      this.#setState('waiting');
      return false;
    }
    this.#setState('enrolling');
    try {
      this.#identity = await enroll({
        url: this.#config.url,
        token,
        hello: this.#hello(),
        nodeName: this.#config.nodeName,
        net: this.#net,
        store: this.#store,
        log,
        allowHttp: this.#config.allowHttp,
      });
      this.#events.emit('enrolled', this.#identity);
      return true;
    } catch (e) {
      if (!(e instanceof EnrollError)) throw e;
      // Network trouble and a busy portal are worth trying again soon; a refused token is not (a restart policy would only loop).
      const retry = ['unreachable', 'server_error', 'rate_limited', 'store_locked'].includes(e.reason);
      log.error('enroll.failed', { reason: e.reason, message: e.message, hint: e.hint });
      this.#events.emit('refused', { code: e.reason, message: e.message, fatal: !retry, waitMs: retry ? (this.#opts.timing?.notEnrolledPollMs ?? 30_000) : this.#fatalMs });
      this.#setState('waiting');
      if (!retry && !(await this.#sleep(this.#fatalMs))) return false;
      return false;
    }
  }

  /** What this agent says about itself (in `auth` and in `POST enroll`). */
  #hello(): ConnectAgentHello {
    const swarm = [...this.#services.values()].map((s) => s.report?.().swarm).find(Boolean);
    return buildHello(this.#config, {
      build: this.#build,
      version: this.#version,
      startedAt: this.#startedAt,
      services: [...this.#services.values()].map((s) => s.status()),
      portalId: this.#identity?.portalId ?? null,
      ...(this.#opts.hostname ? { hostname: this.#opts.hostname } : {}),
      ...(swarm ? { swarm } : {}),
    });
  }

  /* ------------------------------------------------------------------------------------------------------------------------ *
   * One connection
   * ------------------------------------------------------------------------------------------------------------------------ */

  async #connectOnce(): Promise<{ kind: 'dropped' } | { kind: 'refused'; code: string; message: string; retryAfterS?: number } | { kind: 'fatal'; code: string; message: string }> {
    const log = this.#log;
    const url = this.#config.url ?? this.#identity!.portalUrl;
    const tunnel = connectTunnelUrl(url);
    const target = new URL(tunnel);
    await this.#probe();

    // A rotation that did not finish: try the new key first (the portal may have it); if it does not, go back to the old one.
    let next = await this.#store.loadNext();
    for (let tries = 0; tries < 2; tries++) {
      const using = next ?? this.#identity!;
      try {
        const dialled = await dialTunnel({
          url: tunnel,
          nodeId: using.node,
          privateKey: using.privateKey,
          hello: () => ({ ...this.#hello(), portalId: this.#identity?.portalId ?? null }),
          ws: { agent: transportAgent(target, this.#net), headers: this.#net.headers ?? {} },
          signal: this.#abort.signal,
          onStream: (stream) => void this.#dispatch(stream),
          log: (line) => log.debug('mux', { line: line.slice(0, 160) }),
        });
        if (next) {
          // The portal knows the new key: it is the identity now.
          this.#identity = (await this.#store.promoteNext()) ?? this.#identity;
          log.info('rekey.completed_after_restart', { fingerprint: fingerprintOf(this.#identity!) });
          next = null;
        }
        return await this.#serve(dialled.session, dialled.welcome);
      } catch (e) {
        if (e instanceof Crash) throw e;
        if (e instanceof TunnelRejected) {
          if (next && e.code === 'bad_signature') {
            log.warn('rekey.abandoned', { reason: 'the portal does not know the new key' });
            await this.#store.dropNext();
            next = null;
            continue;
          }
          log.warn('connect.rejected', { code: e.code, message: e.message });
          return CONNECT_REJECT_FATAL.includes(e.code) ? { kind: 'fatal', code: e.code, message: e.message } : { kind: 'refused', code: e.code, message: e.message, ...(e.retryAfterS ? { retryAfterS: e.retryAfterS } : {}) };
        }
        const why = e instanceof TunnelConnectError ? e.message : (e as Error).message;
        log.warn('connect.failed', { message: why.slice(0, 160), status: e instanceof TunnelConnectError ? (e.status ?? null) : null });
        return { kind: 'refused', code: 'connect_failed', message: why };
      }
    }
    return { kind: 'dropped' };
  }

  async #serve(session: MuxSession, welcome: { node: string; portalId: string | null; agentBuild: string }): Promise<{ kind: 'dropped' }> {
    const log = this.#log;
    const identity = this.#identity!;
    this.#session = session;
    // A stop or a kill that landed while the dial was in flight found no session to close; this one is closed now, or the moment it comes.
    // Without this the agent served a tunnel nobody would ever close, and `stop()` waited for ever (rekey.test.ts hung the release gate twice).
    const onAbort = () => session.close(1000, 'agent stopping');
    if (this.#abort.signal.aborted) onAbort();
    else this.#abort.signal.addEventListener('abort', onAbort, { once: true });

    // The portal's id is pinned at the first welcome; another one later means this is not the portal that enrolled the agent.
    if (welcome.portalId) {
      if (!identity.portalId) {
        this.#identity = { ...identity, portalId: welcome.portalId };
        await this.#store.save(this.#identity).catch(() => log.warn('identity.pin_failed', {}));
        log.info('portal.pinned', { portalId: welcome.portalId });
      } else if (identity.portalId !== welcome.portalId) {
        session.close(4403, 'portal mismatch');
        return Promise.reject(Object.assign(new TunnelRejected('portal_mismatch', 'This is a different portal from the one that enrolled this agent.'), {}));
      }
    }
    if (welcome.agentBuild && welcome.agentBuild !== this.#build) log.info('agent.update_available', { portalBuild: welcome.agentBuild });

    let heldFrom = this.#clock.now();
    const closed = new Promise<{ code: number; reason: string }>((resolve) => session.onClose((info) => resolve({ code: info.code, reason: info.reason })));
    const control = await ControlChannel.open({
      session,
      log,
      handlers: {
        onConfig: (c) => this.#onConfig(c),
        onNotice: (n) => {
          log.info('notice', { level: n.level, action: n.action ?? null });
          if (n.action === 'rotate') void this.#rotate().catch((e) => e instanceof Crash && this.#kill());
        },
        onRevoked: (r) => {
          log.error('revoked', { reason: r.reason.slice(0, 120) });
          this.#events.emit('revoked', { reason: r.reason });
        },
        onRekeyAnswer: (a) => this.#rekeyWaiter?.(a),
        onFatal: (reason) => {
          log.error('control.protocol_error', { reason: reason.slice(0, 120) });
          session.close(1002, 'control protocol error');
        },
      },
    });
    this.#control = control;
    this.#remote = (level, message) => control.logLine(level, message);
    log.setRemote?.(this.#remote);
    heldFrom = this.#clock.now();
    this.#setState('connected');
    log.info('connected', { node: identity.node, target: identity.target, build: this.#build });
    this.#events.emit('connected', { node: identity.node, build: welcome.agentBuild ?? null });
    control.status(() => this.#buildStatus());

    const info = await closed;
    this.#abort.signal.removeEventListener('abort', onAbort);
    this.#stopTimers();
    log.setRemote?.(null);
    this.#remote = null;
    this.#control = null;
    this.#session = null;
    control.close();
    const heldMs = this.#clock.now() - heldFrom;
    log.info('disconnected', { code: info.code, heldMs });
    this.#events.emit('disconnected', { heldMs, code: info.code, reason: info.reason });
    return { kind: 'dropped' };
  }

  #stopTimers() {
    if (this.#statusTimer) clearInterval(this.#statusTimer);
    this.#statusTimer = null;
  }

  #onConfig(cfg: ConnectConfigMessage) {
    this.#portalConfig = cfg;
    if (cfg.kubeLocalToken) this.#log.addSecret(cfg.kubeLocalToken);
    // The status cadence follows the portal's `config`; the first status went out when the stream opened.
    this.#stopTimers();
    const every = Math.max(1, Math.min(300, cfg.statusEveryS || CONNECT_LIMITS.statusEveryS)) * 1000;
    this.#statusTimer = setInterval(() => this.#control?.status(() => this.#buildStatus()), every);
    this.#statusTimer.unref();
    this.#control?.status(() => this.#buildStatus());
  }

  async #buildStatus(): Promise<ConnectStatusMessage> {
    const list = [...this.#services.values()];
    await Promise.race([Promise.allSettled(list.map((s) => s.refresh?.())), new Promise((r) => setTimeout(r, 4000).unref())]);
    const merged: Partial<Pick<ConnectStatusMessage, 'usage' | 'docker' | 'swarm'>> = {};
    const denied = new Map<string, number>();
    for (const s of list) {
      const r = s.report?.() ?? {};
      if (r.usage) merged.usage = r.usage;
      if (r.docker) merged.docker = r.docker;
      if (r.swarm) merged.swarm = r.swarm;
      for (const d of r.denied ?? []) denied.set(d.rule, (denied.get(d.rule) ?? 0) + d.count);
    }
    return {
      t: 'status',
      at: new Date().toISOString(),
      services: list.map((s) => s.status()),
      ...merged,
      ...(denied.size ? { denied: [...denied].map(([rule, count]) => ({ rule, count })) } : {}),
      streams: { ...this.#open },
    };
  }

  /* ------------------------------------------------------------------------------------------------------------------------ *
   * Streams the portal opens
   * ------------------------------------------------------------------------------------------------------------------------ */

  async #dispatch(stream: MuxStream): Promise<void> {
    let reserved: ServiceName | null = null;
    const release = () => {
      if (reserved) this.#open[reserved] = Math.max(0, this.#open[reserved] - 1);
      reserved = null;
    };
    const decide = async (request: { service: string; args?: unknown }): Promise<OpenDecision> => {
      // The agent opens `control`; the portal never does.
      if (request.service === 'control') return { ok: false, code: 'bad_open', message: 'The portal does not open the control stream.' };
      const name = request.service as ServiceName;
      const service = this.#services.get(name);
      if (!service) return { ok: false, code: 'service_unavailable', message: `This agent does not offer ${name}.` };
      const cap = Math.min(CONNECT_LIMITS.serviceStreams[name], this.#portalConfig?.limits?.[name] ?? Infinity);
      if (this.#open[name] >= cap) return { ok: false, code: 'busy', message: `${cap} ${name} streams are open.` };
      this.#open[name]++;
      reserved = name;
      stream.once('close', release);
      const refusal = await service.accept?.(request.args as never);
      if (refusal) {
        release();
        return { ok: false, code: refusal.code, message: refusal.message };
      }
      return { ok: true };
    };
    try {
      const request = await acceptService(stream, decide as never);
      if (!request) return release();
      const service = this.#services.get(request.service as ServiceName);
      if (!service) {
        stream.destroy();
        return;
      }
      service.handle(stream, request.trace ?? '--------', request.args);
    } catch (e) {
      this.#log.error('stream.failed', { code: (e as NodeJS.ErrnoException).code ?? 'ERR' });
      release();
      stream.destroy();
    }
  }

  /* ------------------------------------------------------------------------------------------------------------------------ *
   * Key rotation (§10.4): a new key made here, proven with the old one, saved only after the portal said yes
   * ------------------------------------------------------------------------------------------------------------------------ */

  async #rotate(): Promise<void> {
    if (this.#rotating || !this.#control?.open || !this.#identity) return;
    this.#rotating = true;
    const log = this.#log;
    const control = this.#control;
    const current = this.#identity;
    const hook = async (step: Parameters<NonNullable<RunAgentOptions['rotationHook']>>[0]) => {
      try {
        await this.#opts.rotationHook?.(step);
      } catch {
        throw new Crash(`crash at ${step}`);
      }
    };
    try {
      const keys = generateNodeKeyPair();
      this.#log.addSecret(keys.privateKey);
      const nextIdentity: Identity = { ...current, privateKey: keys.privateKey, publicKey: keys.publicKey };
      await this.#store.saveNext(nextIdentity);
      await hook('saved-next');
      const answer = new Promise<ConnectRekeyAnswer>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), this.#opts.timing?.rekeyWaitMs ?? 30_000);
        timer.unref();
        this.#rekeyWaiter = (a) => (clearTimeout(timer), resolve(a));
      });
      await control.rekey(keys.publicKey, signRekey(current.privateKey, current.node, keys.publicKey));
      await hook('rekey-sent');
      const got = await answer;
      await hook('answered');
      if (got.ok && got.publicKey === keys.publicKey) {
        this.#identity = (await this.#store.promoteNext()) ?? this.#identity;
        await hook('promoted');
        log.info('rekey.done', { fingerprint: fingerprintOf(this.#identity!) });
        this.#events.emit('rekeyed', { fingerprint: fingerprintOf(this.#identity!) });
      } else {
        await this.#store.dropNext();
        log.warn('rekey.refused', { reason: got.ok ? 'the portal stored another key' : got.reason.slice(0, 120) });
      }
    } catch (e) {
      if (e instanceof Crash) throw e;
      await this.#store.dropNext().catch(() => undefined);
      log.warn('rekey.failed', { message: (e as Error).message.slice(0, 120) });
    } finally {
      this.#rekeyWaiter = null;
      this.#rotating = false;
    }
  }
}
