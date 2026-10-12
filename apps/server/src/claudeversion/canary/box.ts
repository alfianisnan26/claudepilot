// The canary's view of its throwaway container: run a script, write and read files, start the in-container stand-in API, give the CLI a fake
// login, and drive the REAL Claude Code CLI over the stream-json protocol the way the portal's chat host does (docs/prd/claude-version-pinning.md §11).
// Everything the CLI sees comes from `canaryEnv` (an allowlist) and the container; nothing is read from the portal's own environment.

import type { DeliveryAccess, ExecSession, ShellSession, TarEntry, ThrowawayAccess } from '../../workspaces/runtime.js';
import { canaryEnv } from './env.js';
import { CANARY_STANDIN } from '../standin.js';

/** The workspace user inside the image. */
const NODE_UID = 1000;
export const BOX_HOME = '/home/node';
export const BOX_DIR = '/tmp/canary';
const STATE = `${BOX_DIR}/state`;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One request the stand-in saw: method, path, header names only, and for a model request the tools offered and the tool results sent back. */
export interface StandInSeen {
  method: string;
  path: string;
  headers?: string[];
  tools?: string[];
  model?: string | null;
  stream?: boolean;
  toolResults?: { error: boolean; content: string }[];
}

export class CheckFailed extends Error {
  constructor(
    message: string,
    readonly detail = '',
  ) {
    super(message);
  }
}

/** A failed assertion of a check: its message is the one-line summary, `detail` the output behind it. */
export function expect(cond: unknown, message: string, detail = ''): asserts cond {
  if (!cond) throw new CheckFailed(message, detail);
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The lines of a stream-json session, parsed; text that is not JSON (a warning on stderr) is kept as a string. */
export type StreamLine = Record<string, unknown> | string;

export interface StreamSession {
  /** Every line so far, in order. */
  readonly lines: StreamLine[];
  send(obj: unknown): void;
  /** One line already built (the portal's own `userLine`, `allowResponse`, `controlRequest` ...). */
  sendRaw(line: string): void;
  /** Resolves with the first line (from the start) that satisfies `pred`, or rejects with what was seen when `ms` pass or the process ends. */
  waitFor(pred: (l: Record<string, unknown>) => boolean, ms: number, what: string): Promise<Record<string, unknown>>;
  /** Ends stdin and the process; resolves when it is gone (or after a short wait). */
  close(): Promise<void>;
  readonly exited: Promise<number | null>;
}

export class CanaryBox {
  proxy: string | undefined;
  ca: string | undefined;
  httpUrl: string | undefined;

  constructor(
    private readonly t: ThrowawayAccess,
    readonly name: string,
    /** The `claude` under test: `claude` for the image's, the scratch install's path for a candidate. */
    readonly claude: string,
    /** Where a candidate's `claude` lives, put first on PATH so everything the CLI runs finds the same one. */
    readonly binDir: string | null = null,
  ) {}

  get path(): string {
    return [this.binDir, '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
  }

  /** The environment of one CLI run (allowlist only). */
  env(extra?: Record<string, string | undefined>): Record<string, string> {
    return canaryEnv({ home: BOX_HOME, path: this.path, proxy: this.proxy, ca: this.ca, extra });
  }

  /** `sh -c script` in the container as the workspace user (or root), with the canary environment exported first. */
  async sh(script: string, o: { stdin?: string; timeoutMs?: number; user?: 'root' | 'node'; env?: Record<string, string | undefined> } = {}): Promise<RunResult> {
    const exports = Object.entries(this.env(o.env)).map(([k, v]) => `export ${k}=${shq(v)}`);
    return this.t.run(this.name, `${exports.join('\n')}\n${script}`, { user: o.user ?? 'node', stdin: o.stdin, timeoutMs: o.timeoutMs ?? 60_000 });
  }

  put(entries: TarEntry[]): Promise<void> {
    return this.t.put(this.name, entries);
  }

  read(path: string): Promise<string | null> {
    return this.t.read(this.name, path);
  }

  /** A file for the workspace user. */
  file(path: string, content: string, mode = 0o644): TarEntry {
    return { path, type: 'file', content, mode, uid: NODE_UID, gid: NODE_UID };
  }

  dir(path: string, mode = 0o755): TarEntry {
    return { path, type: 'directory', mode, uid: NODE_UID, gid: NODE_UID };
  }

  /** A command with stdin open, as the workspace user, with the canary environment. */
  exec(command: string[], o: { env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<ExecSession> {
    return this.t.exec(this.name, command, { env: this.env(o.env), cwd: o.cwd });
  }

  /** A terminal as the workspace user, with the canary environment (`claude mcp login` reads the pasted address from a terminal). */
  shell(size: { cols: number; rows: number }, command: string[], extra?: Record<string, string | undefined>): Promise<ShellSession> {
    return this.t.shell(this.name, size, command, { env: this.env(extra) });
  }

  /** The delivery engine's view of this container, so the portal's own `writeBundle` writes into it exactly as it does into a workspace. */
  asDelivery(): DeliveryAccess {
    return {
      state: async () => ({ exists: true, running: true }),
      run: (_name, script, opts) => this.t.run(this.name, script, opts),
      put: (_name, entries) => this.t.put(this.name, entries),
      read: (_name, path) => this.t.read(this.name, path),
      watchStarts: () => () => undefined,
    };
  }

  /* ---------- The stand-in API ---------- */

  /** Writes the stand-in script into the container and starts it (as the workspace user); resolves once it is listening. */
  async startStandIn(): Promise<void> {
    await this.put([this.dir(BOX_DIR), this.dir(STATE), this.file(`${BOX_DIR}/standin.cjs`, CANARY_STANDIN), this.file(`${STATE}/script.json`, '{}')]);
    const r = await this.sh(`cd ${BOX_DIR} && (nohup node standin.cjs ${STATE} >standin.out 2>&1 &)\nfor i in $(seq 1 100); do [ -s ${STATE}/ready.json ] && break; sleep 0.2; done\ncat ${STATE}/ready.json`, { timeoutMs: 40_000 });
    let ready: { proxy?: string; http?: string; ca?: string };
    try {
      ready = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as typeof ready;
    } catch {
      const out = await this.read(`${BOX_DIR}/standin.out`);
      throw new CheckFailed('The stand-in API did not start in the container.', `${r.stdout}\n${r.stderr}\n${out ?? ''}`.trim());
    }
    this.proxy = ready.proxy;
    this.ca = ready.ca;
    this.httpUrl = ready.http;
  }

  /** What the stand-in answers from now on (it re-reads this on every request). */
  setScript(script: Record<string, unknown>): Promise<void> {
    return this.put([this.file(`${STATE}/script.json`, JSON.stringify(script))]);
  }

  async seen(): Promise<StandInSeen[]> {
    const text = (await this.read(`${STATE}/requests.jsonl`)) ?? '';
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as StandInSeen;
        } catch {
          return { method: '?', path: l.slice(0, 80) };
        }
      });
  }

  async resetSeen(): Promise<void> {
    await this.sh(`: > ${STATE}/requests.jsonl`);
  }

  /** A clearly fake claude.ai login for the Default Claude (the same shape the usage testkit writes), so the CLI behaves as a subscription account. */
  async fakeLogin(o: { plan?: string; scopes?: string[] } = {}): Promise<void> {
    await this.put([
      this.dir(`${BOX_HOME}/.claude`, 0o700),
      this.file(
        `${BOX_HOME}/.claude/.credentials.json`,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'FAKE-canary-access-token-not-real',
            refreshToken: 'FAKE-canary-refresh-token-not-real',
            expiresAt: 4102444800000,
            scopes: o.scopes ?? ['user:inference', 'user:profile'],
            subscriptionType: o.plan ?? 'max',
            rateLimitTier: 'default_claude_max_5x',
          },
        }),
        0o600,
      ),
      this.file(
        `${BOX_HOME}/.claude.json`,
        JSON.stringify({
          hasCompletedOnboarding: true,
          oauthAccount: {
            accountUuid: '00000000-0000-4000-8000-000000000001',
            emailAddress: 'fake-user@example.invalid',
            organizationUuid: '00000000-0000-4000-8000-000000000002',
            organizationName: 'Fake Org (canary)',
            displayName: 'Fake',
          },
        }),
      ),
      this.dir(`${BOX_HOME}/work`),
    ]);
  }

  /** Stops every Claude Code process the checks left (a hung one, a session host child), never the stand-in. */
  async killClaude(): Promise<void> {
    await this.sh(`pkill -u node -f 'claude -p' || true; pkill -u node -f 'claude.* --print' || true`, { timeoutMs: 15_000 }).catch(() => undefined);
  }

  /* ---------- Driving the CLI ---------- */

  /**
   * `claude` with the chat host's stream-json flags (`args` after `-p`), in `cwd`, under `timeout` so a hung CLI cannot outlive the check.
   * Lines are collected as they arrive; `send` writes one JSON line to stdin.
   */
  async stream(args: string[], o: { cwd?: string; env?: Record<string, string | undefined>; limitS?: number } = {}): Promise<StreamSession> {
    return this.streamCommand(['timeout', String(o.limitS ?? 120), this.claude, '-p', ...args], o);
  }

  /** The same for a whole command (one of the portal's own, such as the usage probe's or the side question's), which brings its own `timeout`. */
  async streamCommand(command: string[], o: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<StreamSession> {
    const session = await this.exec(command, { env: o.env, cwd: o.cwd ?? `${BOX_HOME}/work` });
    const lines: StreamLine[] = [];
    let tail = '';
    let code: number | null | undefined;
    const exited = new Promise<number | null>((resolve) => session.onExit((c) => ((code = c), resolve(c))));
    session.onData((d) => {
      tail += d.toString('utf8');
      let nl: number;
      while ((nl = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, nl).trim();
        tail = tail.slice(nl + 1);
        if (!line) continue;
        if (line.startsWith('{')) {
          try {
            lines.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            lines.push(line);
          }
        } else lines.push(line);
      }
    });
    const summary = () => lines.slice(-12).map((l) => (typeof l === 'string' ? l : JSON.stringify(l).slice(0, 240))).join('\n');
    return {
      lines,
      send: (obj) => session.write(`${JSON.stringify(obj)}\n`),
      sendRaw: (l) => session.write(l.endsWith('\n') ? l : `${l}\n`),
      waitFor: async (pred, ms, what) => {
        const deadline = Date.now() + ms;
        for (;;) {
          const hit = lines.find((l): l is Record<string, unknown> => typeof l !== 'string' && pred(l));
          if (hit) return hit;
          if (code !== undefined) throw new CheckFailed(`The process ended (exit ${code ?? '?'}) before ${what}.`, summary());
          if (Date.now() > deadline) throw new CheckFailed(`Timed out waiting for ${what}.`, summary());
          await new Promise((r) => setTimeout(r, 100));
        }
      },
      close: async () => {
        try {
          session.close();
        } catch {
          // already gone
        }
        await Promise.race([exited, new Promise((r) => setTimeout(r, 3000).unref())]);
      },
      exited,
    };
  }
}
