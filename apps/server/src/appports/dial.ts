import { Duplex } from 'node:stream';
import { APP_PORT_MAX, APP_PORT_MIN } from '@portal/contracts';
import type { ExecSession, Runtime } from '../workspaces/runtime.js';

/**
 * App ports (docs/prd/app-ports.md §5): how the portal reaches `127.0.0.1:<port>` INSIDE a workspace. It reuses the channel every runtime
 * already has, `exec` (Kubernetes: the pod's exec API; Docker: docker exec; This machine: a child process): one small Node bridge per TCP
 * connection, stdin to the socket and the socket to stdout. The address is a literal in the bridge; only the port is an argument, and only an
 * integer in range gets that far. There is no host or IP parameter anywhere, so nothing here can reach another machine (no SSRF).
 *
 * The bridge writes nothing but the socket's bytes (exec merges stderr into stdout on some runtimes); a failed connect exits 1 silently.
 */
export const BRIDGE =
  "const s=require('net').connect(Number(process.argv[1]),'127.0.0.1');" +
  "s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0));" +
  "process.stdin.on('end',()=>s.end());process.stdin.pipe(s);s.pipe(process.stdout);";

/** The argv that runs the bridge for one port. Throws for anything that is not an integer port in range. */
export function bridgeCommand(port: number): string[] {
  if (!Number.isInteger(port) || port < APP_PORT_MIN || port > APP_PORT_MAX) throw new RangeError('Not a port that may be opened.');
  return ['node', '-e', BRIDGE, String(port)];
}

/** A runtime that has no bridge yet in this slice: the proxy answers 501 for it (Connect targets, PRD §5). */
export class NotOnThisTarget extends Error {
  constructor() {
    super('App ports are not available on this target yet.');
    this.name = 'NotOnThisTarget';
  }
}

/**
 * An exec session as a socket, for `http.request({ createConnection })` and raw WebSocket piping. Bytes stream as they come (no buffering of a
 * whole body); the process's end is the socket's end. The exec channels have no half-close, so `end()` from our side waits for the app to close.
 */
export class ExecDuplex extends Duplex {
  readonly #s: ExecSession;
  #timer: NodeJS.Timeout | undefined;
  #idleMs = 0;

  constructor(session: ExecSession) {
    super({ allowHalfOpen: false });
    this.#s = session;
    session.onData((d) => {
      this.#touch();
      this.push(d);
    });
    session.onExit(() => {
      this.push(null);
      // After the readable side drained: nothing more will ever come.
      setImmediate(() => this.destroy());
    });
  }

  override _read(): void {
    /* data is pushed as the exec delivers it */
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.#touch();
    try {
      this.#s.write(chunk);
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }

  override _final(cb: (e?: Error | null) => void): void {
    cb();
  }

  override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    clearTimeout(this.#timer);
    try {
      this.#s.close();
    } catch {
      /* already gone */
    }
    cb(err);
  }

  // What http's client calls on a socket: harmless here.
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  setTimeout(ms: number, cb?: () => void): this {
    this.#idleMs = ms;
    if (cb) this.once('timeout', cb);
    this.#touch();
    return this;
  }

  #touch() {
    clearTimeout(this.#timer);
    if (this.#idleMs > 0 && !this.destroyed) this.#timer = setTimeout(() => this.emit('timeout'), this.#idleMs).unref();
  }
}

/** Opens one connection to `127.0.0.1:<port>` inside a workspace. */
export type Dial = (workspaceId: string, port: number) => Promise<Duplex>;

/** The kinds of target the bridge runs on in this slice. Enrolled targets (Connect) answer 501. */
const BRIDGED = new Set(['kubernetes', 'docker', 'local']);

/** The dialer over the manager's runtimes. */
export function createDialer(workspaces: { runtimeFor(target: string): Runtime | undefined; exec(target: string, name: string, command: string[]): Promise<ExecSession> }): Dial {
  return async (workspaceId, port) => {
    const command = bridgeCommand(port);
    const slash = workspaceId.indexOf('/');
    const [target, name] = [workspaceId.slice(0, slash), workspaceId.slice(slash + 1)];
    const runtime = workspaces.runtimeFor(target);
    if (!runtime) throw new Error('No such target.');
    if (runtime.target.source === 'enrolled' || !BRIDGED.has(runtime.target.kind)) throw new NotOnThisTarget();
    return new ExecDuplex(await workspaces.exec(target, name, command));
  };
}
