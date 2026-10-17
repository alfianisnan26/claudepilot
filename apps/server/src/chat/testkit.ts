// Test kit for the chat controller: a fake workspace host (cp-session replies), and a started session
// to drive. Shared by chat.test.ts and the suites for worktrees, multi-agent and transfer.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatServerMessage, ChatTask, CreateChatSessionRequest } from '@portal/contracts';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { ChatController, type ChatControllerOptions } from './controller.js';
import { TRUST_EMPTY_HASH } from './host.js';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
}

export const line = (value: unknown) => `${JSON.stringify(value)}\n`;
/** A Claude Code success reply to one of the portal's control requests (body optional). */
export const ok = (requestId: string, response?: unknown) =>
  line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, ...(response === undefined ? {} : { response }) } });
export const fail = (requestId: string, error: string) => line({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error, error_code: 'invalid' } });

/** `trustscan` for a folder with none of the project settings files. */
export const EMPTY_SCAN = { hash: TRUST_EMPTY_HASH, files: [], invalid: [], mcpServers: [], hooks: [], plugins: [], allowRules: 0, envNames: [], extras: [] };

/** A controllable stand-in for one `workspaces.exec` call. */
export class FakeExec implements ExecSession {
  readonly #data: ((b: Buffer) => void)[] = [];
  readonly #exit: ((code: number | null) => void)[] = [];
  written = '';
  closed = false;
  exited = false;
  /** close() came before the command exited — a real exec then loses bytes in flight, and the exit code. */
  closedEarly = false;
  write(d: string): void {
    this.written += d;
  }
  close(): void {
    if (!this.exited) this.closedEarly = true;
    this.closed = true;
  }
  onData(fn: (b: Buffer) => void): void {
    this.#data.push(fn);
  }
  onExit(fn: (code: number | null) => void): void {
    this.#exit.push(fn);
  }
  push(line: string): void {
    const b = Buffer.from(line);
    for (const fn of this.#data) fn(b);
  }
  exit(code: number | null = 0): void {
    if (this.exited) return;
    this.exited = true;
    for (const fn of this.#exit) fn(code);
  }
}

/**
 * A fake Workspaces whose `exec` simulates cp-session: start/status/stop reply, tail stays open, send
 * records. Like a real exec, one closed before its command exits loses what it hadn't delivered and its
 * exit code (Docker drops the rest of a big write; Kubernetes loses the status).
 */
export class FakeWorkspaces {
  readonly tails: FakeExec[] = [];
  readonly tailArgs: string[][] = [];
  readonly sends: { args: string[]; line: string }[] = [];
  readonly sendExecs: FakeExec[] = [];
  readonly startArgs: string[][] = [];
  /** The `start` execs, to read what each got on stdin (its environment lines). */
  readonly startExecs: FakeExec[] = [];
  /** Every command, in order: `start`, `send <first 40 chars>`, `stop`, … */
  readonly ops: string[] = [];
  starts = 0;
  stops = 0;
  /** The exit code of `start` (3: a process is already running, the portal attaches to it). */
  startCode = 0;
  /** What `status` reports (per session when set there), and the exit code `send` returns. */
  alive = true;
  readonly status = new Map<string, boolean>();
  /** The host cannot be reached for `status` (the exec fails): the portal reads it as unknown. */
  statusUnreachable = false;
  sendCode = 0;
  /** A host that takes stdin but never exits. */
  hangSends = false;
  /**
   * T-1049: opt-in. Every control request the portal writes is answered on the newest tail in the same tick it is recorded (settings: the applied
   * ones, permission mode: the asked mode, usage: an API-key account, anything else: a bare success), so a test never races a short
   * `controlTimeoutMs` against a polling responder under load.
   */
  autoRespond = false;
  #answerControl(written: string): void {
    let o: { type?: string; request_id?: string; request?: { subtype?: string; mode?: unknown } };
    try {
      o = JSON.parse(written);
    } catch {
      return;
    }
    const tail = this.tails.at(-1);
    if (o.type !== 'control_request' || !o.request_id || !o.request || !tail) return;
    const sub = o.request.subtype;
    if (sub === 'get_settings') tail.push(ok(o.request_id, APPLIED));
    else if (sub === 'set_permission_mode') tail.push(ok(o.request_id, { mode: String(o.request.mode) }));
    else if (sub === 'get_usage') tail.push(ok(o.request_id, USAGE_API_KEY));
    else tail.push(ok(o.request_id));
  }
  /** What `trustscan` prints (a folder with nothing to load unless a test says otherwise) and its exit code. */
  scanOut = JSON.stringify(EMPTY_SCAN);
  scanCode = 0;
  /** When set, what `trustscan` prints for each folder (instead of `scanOut`). */
  scanFor: ((folder: string) => string) | null = null;
  /** The folders `trustscan` was asked about, in order. */
  readonly scans: string[] = [];
  /** What `psettings` prints (null: the host cannot read the project's rules). */
  psettingsOut: string | null = null;
  /** What `authcheck` prints (the account drop-in names the pool's helper unless a test says otherwise), and its exit code (null: never exits). */
  authOut = 'pass';
  authCode: number | null = 0;
  auths = 0;
  /** While set, `start` waits for it before answering (a launch caught mid-way). */
  startGate: Promise<void> | null = null;
  /** The exit code `purge` returns (3: the process is still alive). */
  purgeCode = 0;
  /** The exit code of a `start` in a non-default Claude's directory (non-zero: the host couldn't start it). */
  wrappedStartCode = 0;
  /**
   * The worktree commands (`wt-add`, `wt-status`, `wt-list`, `wt-remove`): each answers from a function a test can replace,
   * and every call is recorded with its arguments. The defaults make a worktree beside the repository, clean and merged.
   */
  readonly wtCalls: { cmd: string; args: string[] }[] = [];
  wtAdd: (args: string[]) => { code: number; out: string } = ([folder, leaf, branch]) => ({ code: 0, out: `ok\t${folder}.worktrees/${leaf}\t${branch}\tc0ffee${'0'.repeat(34)}\t${folder}\t\n` });
  wtStatus: (args: string[]) => { code: number; out: string } = () => ({ code: 0, out: 'dirty=0\nuntracked=0\nunique=0\nbranch=feature\nhead=c0ffee\n' });
  wtRemove: (args: string[]) => { code: number; out: string } = () => ({ code: 0, out: 'branch=deleted\nok\n' });
  wtList: (args: string[]) => { code: number; out: string } = () => ({ code: 0, out: '[]' });
  /** `sh -c` scripts the controller ran (mkdir, the transfer file's write), with what they got on stdin. */
  readonly shells: { args: string[]; exec: FakeExec }[] = [];
  runtimeFor(target: string): object | undefined {
    return target === 'docker' ? {} : undefined; // only the docker target exists
  }
  async exec(_target: string, _name: string, command: string[]): Promise<ExecSession> {
    const exec = new FakeExec();
    const cmd = command[2]; // ['sh', <script>, <cmd>, ...]
    if (cmd === 'authcheck') {
      this.auths++;
      this.ops.push('authcheck');
      const [out, code] = [this.authOut, this.authCode];
      setTimeout(() => {
        exec.push(`${out}\n`);
        if (code !== null) exec.exit(code);
      }, 0);
    } else if (cmd === 'wt-add' || cmd === 'wt-status' || cmd === 'wt-remove' || cmd === 'wt-list') {
      const args = command.slice(3);
      this.wtCalls.push({ cmd, args });
      this.ops.push(`${cmd} ${args.join(' ')}`.trim());
      const reply = (cmd === 'wt-add' ? this.wtAdd : cmd === 'wt-status' ? this.wtStatus : cmd === 'wt-remove' ? this.wtRemove : this.wtList)(args);
      setTimeout(() => {
        exec.push(reply.out);
        exec.exit(reply.code);
      }, 0);
    } else if (cmd === 'trustscan') {
      this.scans.push(command[3] ?? '');
      this.ops.push('trustscan');
      const [out, code] = [this.scanFor ? this.scanFor(command[3] ?? '') : this.scanOut, this.scanCode];
      setTimeout(() => {
        exec.push(`${out}\n`);
        exec.exit(code);
      }, 0);
    } else if (cmd === 'psettings') {
      // T-561: the project's permission rules as one JSON line (what the host prints), or a failure when a test leaves it null.
      this.ops.push('psettings');
      const out = this.psettingsOut;
      setTimeout(() => {
        if (out !== null) exec.push(`${out}\n`);
        exec.exit(out === null ? 2 : 0);
      }, 0);
    } else if (cmd === 'start') {
      this.starts++;
      this.startArgs.push(command.slice(2));
      this.startExecs.push(exec);
      this.ops.push('start');
      const gate = this.startGate ?? Promise.resolve();
      void gate.then(() =>
        setTimeout(() => {
          if (this.startCode === 0) exec.push('4242 2026-10-10T12:00:00Z\n');
          exec.exit(this.startCode);
        }, 0),
      );
    } else if (cmd === 'tail') {
      this.tails.push(exec); // kept open; the test pushes lines
      this.tailArgs.push(command.slice(2));
    } else if (cmd === 'send') {
      this.sendExecs.push(exec);
      if (this.hangSends) return exec;
      setTimeout(() => {
        if (exec.closed) return exec.exit(null); // closed early: nothing arrived, no exit code either
        if (this.sendCode === 0) {
          this.sends.push({ args: command.slice(2), line: exec.written });
          this.ops.push(`send ${exec.written.slice(0, 40)}`);
          if (this.autoRespond) this.#answerControl(exec.written);
        }
        exec.exit(this.sendCode);
      }, 0);
    } else if (cmd === 'status' && this.statusUnreachable) {
      throw new Error('the session host is unreachable');
    } else if (cmd === 'status') {
      const alive = this.status.get(command[3] ?? '') ?? this.alive;
      setTimeout(() => {
        exec.push(alive ? 'live 4242\n' : 'gone\n');
        exec.exit(0);
      }, 0);
    } else if (cmd === 'stop') {
      this.stops++;
      this.ops.push(`stop ${command[3] ?? ''}`.trim());
      setTimeout(() => exec.exit(0), 0);
    } else if (cmd === 'purge') {
      this.ops.push(`purge ${command[3] ?? ''}`.trim());
      const code = this.purgeCode;
      setTimeout(() => exec.exit(code), 0);
    } else if (command[1] === '-c' && command[6] === 'start') {
      // A start in a non-default Claude's directory goes through a wrapper that exports CLAUDE_CONFIG_DIR.
      this.starts++;
      this.startArgs.push(command.slice(6));
      this.startExecs.push(exec);
      this.shells.push({ args: command.slice(3), exec });
      this.ops.push('start');
      const code = this.wrappedStartCode;
      setTimeout(() => {
        if (code === 0) exec.push('4343 2026-10-10T12:00:00Z\n');
        exec.exit(code);
      }, 0);
    } else {
      if (command[1] === '-c') this.shells.push({ args: command.slice(3), exec });
      setTimeout(() => exec.exit(0), 0);
    }
    return exec;
  }
}

export async function freshStore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-chat-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  return { store, dataDir };
}

/* ========================= C2/C3 controller (fake workspaces) ========================= */

export type Control = { id: string; request: Record<string, unknown> };

/** The control requests the controller wrote, in order. */
export function controls(ws: FakeWorkspaces): Control[] {
  const out: Control[] = [];
  for (const s of ws.sends) {
    try {
      const o = JSON.parse(s.line) as { type?: string; request_id?: string; request?: Record<string, unknown> };
      if (o.type === 'control_request' && o.request_id && o.request) out.push({ id: o.request_id, request: o.request });
    } catch {
      // not JSON: not a control request
    }
  }
  return out;
}

/** A started session with its reader attached, a log of everything dispatched, and a way to take each
 *  new control request of a subtype as the controller writes it. `start` also starts durability work; `req` adds to the create request
 *  (an agent, say). */
export async function liveSession(opts: ChatControllerOptions = {}, start = false, req: Partial<CreateChatSessionRequest> = {}) {
  const { store, dataDir } = await freshStore();
  const ws = new FakeWorkspaces();
  const controller = new ChatController(store, ws as unknown as Workspaces, opts);
  if (start) controller.start();
  const messages: ChatServerMessage[] = [];
  controller.onEvent((_id, msg) => messages.push(msg));
  const id = (await controller.create({ workspaceId: 'docker/ws1', ...req })).id;
  await until(() => ws.tails.length === 1);
  await until(() => controller.get(id)?.state === 'idle');
  await sleep(20); // let the tail attach its data handler
  const seen = new Set<string>();
  const take = async (subtype: string): Promise<Control> => {
    let found: Control | undefined;
    await until(() => !!(found = controls(ws).find((c) => c.request.subtype === subtype && !seen.has(c.id))));
    seen.add(found!.id);
    return found!;
  };
  /** Answers every get_settings the controller asks (on the newest tail) until `p` settles. */
  const answering = async <T>(p: Promise<T>, applied: unknown = APPLIED): Promise<T> => {
    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    while (!settled) {
      const ask = controls(ws).find((c) => c.request.subtype === 'get_settings' && !seen.has(c.id));
      if (ask) {
        seen.add(ask.id);
        ws.tails.at(-1)!.push(ok(ask.id, applied));
      }
      await sleep(5);
    }
    return p;
  };
  const inputs = (uuid: string) => messages.flatMap((m) => (m.type === 'input' && m.uuid === uuid ? [m.state] : []));
  const lastTasks = (): ChatTask[] | undefined => messages.findLast((m): m is Extract<ChatServerMessage, { type: 'tasks' }> => m.type === 'tasks')?.tasks;
  const state = () => controller.get(id)!.state;
  const done = async () => {
    await controller.end(id).catch(() => undefined);
    controller.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, dataDir, ws, controller, messages, id, tail: ws.tails[0]!, take, answering, inputs, lastTasks, state, done };
}

export type Live = Awaited<ReturnType<typeof liveSession>>;

/** What Claude Code reports as applied on a fresh process (get_settings.applied). */
export const APPLIED = { applied: { model: 'claude-opus-5-5', effort: 'medium', ultracode: false, ultracodeAvailable: true } };
/** Claude Code 2.1.296's `get_usage {skip_behaviors: true}` reply for an API-key session (the pool's helper), as observed. */
export const USAGE_API_KEY = {
  session: {
    total_cost_usd: 0.00014,
    total_api_duration_ms: 21,
    total_duration_ms: 6987,
    total_lines_added: 0,
    total_lines_removed: 0,
    model_usage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.00014, contextWindow: 1_000_000, maxOutputTokens: 128_000, thinkingTokens: 0, canonicalModel: 'claude-opus-5-5', provider: 'firstParty', costBasis: 'list' } },
  },
  subscription_type: null,
  rate_limits_available: false,
  rate_limits: null,
  behaviors: null,
};
/** A main-thread `system/init`: a turn starts, on the pool's helper (what Claude Code 2.1.296 reports for it). */
export const init = (sessionId: string, mode = 'default', apiKeySource: string | null = 'apiKeyHelper') =>
  line({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5-5', permissionMode: mode, ...(apiKeySource === null ? {} : { apiKeySource }) });

/** A first turn starts (so Claude Code has a transcript to resume) and its applied settings are read. */
export async function firstTurn(s: Live) {
  s.tail.push(init(s.id));
  s.tail.push(ok((await s.take('get_settings')).id, APPLIED));
  await until(() => s.controller.get(s.id)!.effort === 'medium');
}

/**
 * The portal restarts under a live session (a deploy; T-277 layer 2): the controller stops (the processes keep running), a new one on the
 * same store and workspaces starts and attaches again. `s.controller`, `s.tail` and `s.state` become the new ones and `s.done` stops it
 * too. `setup` installs what the owner installs (the Bypass policy, the server code check) before it starts.
 */
export async function restartPortal(s: Live, opts: ChatControllerOptions = {}, setup?: (c: ChatController) => void): Promise<ChatController> {
  s.controller.stop();
  const tails = s.ws.tails.length;
  const next = new ChatController(s.store, s.ws as unknown as Workspaces, opts);
  next.onEvent((_id, msg) => s.messages.push(msg));
  setup?.(next);
  next.start();
  await until(() => s.ws.tails.length > tails);
  await sleep(20);
  const done = s.done;
  Object.assign(s, {
    controller: next,
    tail: s.ws.tails.at(-1)!,
    state: () => next.get(s.id)!.state,
    done: async () => {
      await next.end(s.id).catch(() => undefined);
      next.stop();
      await done();
    },
  });
  return next;
}

/** The process vanishes (its reader drops and `status` says gone): the session reads Interrupted. */
export async function vanish(s: Live) {
  s.ws.alive = false;
  s.ws.tails.at(-1)!.exit(0);
  await until(() => s.state() === 'interrupted');
  s.ws.alive = true;
}

