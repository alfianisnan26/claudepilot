// A minimal MCP client over stdio for tests: spawns a server (here, the gate or a fake), speaks newline-delimited
// JSON-RPC, and keeps what the server sent. Not used by the portal.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { childEnv } from '../childEnv.js';

export interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown> & { content?: { type: string; text?: string }[]; isError?: boolean; tools?: { name: string }[] };
  error?: { code: number; message: string };
}

/** Where an MCP server's JSON lines go and come from: a child process, or `exec` into a workspace. */
export interface McpTransport {
  write(line: string): void;
  onData(fn: (chunk: string) => void): void;
  onStderr?(fn: (chunk: string) => void): void;
  close(): void;
}

export class McpClient {
  readonly notifications: RpcMessage[] = [];
  /** What the server asked of this client (roots/list, sampling). */
  readonly serverRequests: RpcMessage[] = [];
  /** The folders this client offers as roots (file URIs). */
  roots: string[] = ['file:///home/node'];
  readonly stderr: string[] = [];
  /** The child process, when started with `new McpClient(command, args)`. */
  readonly child!: ChildProcessWithoutNullStreams;
  #id = 0;
  #buf = '';
  readonly #transport: McpTransport;
  readonly #pending = new Map<number | string, (m: RpcMessage) => void>();

  constructor(command: string | McpTransport, args: string[] = [], opts: { env?: Record<string, string>; cwd?: string } = {}) {
    if (typeof command === 'string') {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...childEnv(), ...opts.env }, cwd: opts.cwd });
      this.child = child;
      this.#transport = {
        write: (line) => void child.stdin.write(line),
        onData: (fn) => void child.stdout.on('data', (d: Buffer) => fn(d.toString('utf8'))),
        onStderr: (fn) => void child.stderr.on('data', (d: Buffer) => fn(d.toString('utf8'))),
        close: () => void child.kill('SIGTERM'),
      };
    } else this.#transport = command;
    this.#transport.onData((d) => {
      this.#buf += d;
      for (let i; (i = this.#buf.indexOf('\n')) >= 0; ) {
        const line = this.#buf.slice(0, i);
        this.#buf = this.#buf.slice(i + 1);
        if (!line.trim()) continue;
        let m: RpcMessage;
        try {
          m = JSON.parse(line) as RpcMessage;
        } catch {
          this.stderr.push(line); // a log line that shares the stream
          continue;
        }
        if (m.id !== undefined && !m.method) this.#pending.get(m.id)?.(m);
        else if (m.id !== undefined && m.method) this.#answer(m);
        else this.notifications.push(m);
      }
    });
    this.#transport.onStderr?.((d) => this.stderr.push(d));
  }

  /** Requests the server makes of its client: a client that advertised roots must answer `roots/list`, as Claude Code does. */
  #answer(m: RpcMessage) {
    this.serverRequests.push(m);
    const reply =
      m.method === 'roots/list'
        ? { jsonrpc: '2.0', id: m.id, result: { roots: this.roots.map((uri) => ({ uri, name: uri.split('/').at(-1) })) } }
        : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no ${m.method}` } };
    this.#transport.write(`${JSON.stringify(reply)}\n`);
  }

  request(method: string, params: Record<string, unknown> = {}, ms = 60_000): Promise<RpcMessage> {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}; stderr: ${this.stderr.join('').slice(-500)}`)), ms);
      this.#pending.set(id, (m) => (clearTimeout(timer), resolve(m)));
      this.#transport.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    this.#transport.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async init(roots = false) {
    const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: roots ? { roots: {} } : {}, clientInfo: { name: 'test', version: '0' } });
    this.notify('notifications/initialized');
    return r;
  }

  async tools(): Promise<string[]> {
    return ((await this.request('tools/list')).result?.tools ?? []).map((t) => t.name);
  }

  /** A tool call's text, and whether it was an error. */
  async call(name: string, args: Record<string, unknown> = {}, ms = 60_000): Promise<{ text: string; isError: boolean; raw: RpcMessage }> {
    const raw = await this.request('tools/call', { name, arguments: args }, ms);
    const text = (raw.result?.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n');
    return { text: raw.error ? `ERROR ${raw.error.message}` : text, isError: !!raw.result?.isError || !!raw.error, raw };
  }

  close() {
    this.#transport.close();
  }

  exited(): Promise<number | null> {
    return new Promise((resolve) => (this.child.exitCode !== null ? resolve(this.child.exitCode) : this.child.once('exit', (code) => resolve(code))));
  }
}
