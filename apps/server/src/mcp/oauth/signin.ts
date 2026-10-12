import { randomUUID } from 'node:crypto';
import { AppError } from '@isnanme/core';
import type { McpSignInStart } from '@portal/contracts';
import { redact } from '../../chat/redact.js';
import type { ExecSession, ShellSession } from '../../workspaces/runtime.js';
import { AddressError, checkAuthUrl, checkRedirect, lastLine, parseLogin, scrubOAuth, SIGN_IN_MS, stripTerminal } from './parse.js';
import { serverName, validServer, CLAUDE_DIR, type OAuthServer } from './status.js';

/**
 * Guided sign-in to an OAuth MCP server, in the workspace (MCP set PRD §13.3, D1). Claude Code does the OAuth: the
 * portal runs `claude mcp login --no-browser <server>` in a terminal there (it reads the pasted address from a
 * terminal and gives up on a plain pipe ✅), hands the person the authorization URL it prints, and writes the
 * address the person pastes back as its input. Claude Code exchanges the code (PKCE) and keeps the token in the
 * workspace's own Claude folder: the portal never sees, stores or refreshes it. The pasted address carries the
 * authorization code: it is checked, written once, and kept in no log, no store and no message.
 */

/** What a sign-in needs of a runtime: a terminal to run the login in, and a plain command to stop it with. */
export interface OAuthHost {
  shell(target: string, name: string, size: { cols: number; rows: number }, command?: string[]): Promise<ShellSession>;
  exec(target: string, name: string, command: string[]): Promise<ExecSession>;
}

/** How long to wait for the URL, for Claude Code's answer to a pasted address, and for a process to leave; and how long a sign-in lives. */
export interface SignInLimits {
  linkMs: number;
  answerMs: number;
  exitMs: number;
  signInMs: number;
}
const LIMITS: SignInLimits = { linkMs: 25_000, answerMs: 30_000, exitMs: 2_000, signInMs: SIGN_IN_MS };
/** Open sign-ins: all of them, and one workspace's. A person finishes one at a time. */
const MAX_OPEN = 12;
const MAX_PER_WORKSPACE = 4;
const OUTPUT_MAX = 64 * 1024;
/** How long a finished sign-in still answers "signed in" to a second complete. */
const FINISHED_MS = 2 * 60_000;
/** Wide enough that Claude Code never wraps the URL it prints. */
const COLS = 2000;

/**
 * `$1` is the Claude's folder under ~/.claudepilot (empty: Default), `$2` the server. The shell's PID is printed
 * first and stays the PID of `timeout` (exec), whose own 330 s limit is a net under Claude Code's 300 s one.
 */
const SCRIPT = [
  'PATH="$HOME/.local/bin:$PATH"; export PATH',
  'if [ -n "$1" ]; then CLAUDE_CONFIG_DIR="$HOME/.claudepilot/$1"; export CLAUDE_CONFIG_DIR; fi',
  'shift',
  'cd "$HOME" 2>/dev/null || cd /',
  'echo "cp-pid:$$"',
  'exec timeout -k 3 330 claude mcp login --no-browser "$@"',
].join('\n');

/** Why an open sign-in stopped without signing in: words only, for the audit. */
export type SignInEnd = 'cancelled' | 'replaced' | 'expired' | 'workspace_removed' | 'failed' | 'refused' | 'ended';

interface SignIn {
  id: string;
  /** Who started it (multi-user, PLAN-10: a person's id; today always the one owner). */
  actor: string;
  /** workspace, Claude folder and server: one open sign-in each. */
  slot: string;
  workspaceId: string;
  dir: string;
  server: OAuthServer;
  shell: ShellSession;
  /** Everything Claude Code printed, and what it printed since the last address was written. */
  output: string;
  fresh: string;
  exited: boolean;
  exitCode: number | null;
  pid: number | null;
  callback: string;
  timer: NodeJS.Timeout;
  busy: boolean;
  wake: (() => void)[];
}

const person = (message: string) => new AppError('SERVICE_UNAVAILABLE', message, { expose: true });

export class SignIns {
  readonly #open = new Map<string, SignIn>();
  readonly #slots = new Map<string, string>();
  readonly #serial = new Map<string, Promise<unknown>>();
  /** Sign-ins that just succeeded: a second "complete" (a double tap, a paste after the browser finished it by itself) still answers. */
  readonly #finished = new Map<string, { workspaceId: string; dir: string; server: OAuthServer; actor: string; at: number }>();
  /** A login that finished on its own (the browser could reach Claude Code's listener): the caller checks the server. */
  onSignedIn: (workspaceId: string, dir: string, server: OAuthServer, actor: string) => void = () => {};
  /** A sign-in stopped without signing in (`by`: who stopped it, when a person did). */
  onEnded: (e: { workspaceId: string; dir: string; server: OAuthServer; actor: string; by: string | null; reason: SignInEnd }) => void = () => {};

  readonly #limits: SignInLimits;

  constructor(
    private readonly host: () => OAuthHost | undefined,
    private readonly log: (line: string) => void = (line) => console.log(line),
    limits: Partial<SignInLimits> = {},
  ) {
    this.#limits = { ...LIMITS, ...limits };
  }

  /** Open sign-ins of a workspace (tests, and the portal's own limits). */
  count(workspaceId?: string): number {
    return [...this.#open.values()].filter((s) => !workspaceId || s.workspaceId === workspaceId).length;
  }

  /**
   * Starts the login and returns the page to open. A second start for the same server and Claude replaces the
   * first. `server` has been found among the workspace's delivered OAuth servers by the caller.
   */
  async start(workspaceId: string, dir: string, server: OAuthServer, actor: string): Promise<McpSignInStart> {
    if (!CLAUDE_DIR.test(dir) || !validServer(server)) throw new AppError('VALIDATION_FAILED', 'That server can’t be signed in to.');
    // One start at a time per server: a second tap waits for the first, then replaces it.
    const slot = `${workspaceId}\0${dir}\0${server.plugin}/${server.key}`;
    const run = (this.#serial.get(slot) ?? Promise.resolve()).catch(() => undefined)
      .then(() => this.#start(workspaceId, dir, server, slot, actor));
    this.#serial.set(slot, run);
    try {
      return await run;
    } finally {
      if (this.#serial.get(slot) === run) this.#serial.delete(slot);
    }
  }

  async #start(workspaceId: string, dir: string, server: OAuthServer, slot: string, actor: string): Promise<McpSignInStart> {
    const host = this.host();
    if (!host) throw new AppError('CONFLICT', 'This workspace can’t sign in to MCP servers from the portal.');
    const previous = this.#slots.get(slot);
    if (previous) await this.#end(this.#open.get(previous), 'replaced');
    if (this.count() >= MAX_OPEN || this.count(workspaceId) >= MAX_PER_WORKSPACE) throw new AppError('CONFLICT', 'Too many sign-ins are open. Finish or cancel one first.');

    const slash = workspaceId.indexOf('/');
    const target = workspaceId.slice(0, slash);
    const name = workspaceId.slice(slash + 1);
    const shell = await host.shell(target, name, { cols: COLS, rows: 24 }, ['sh', '-c', SCRIPT, 'sh', dir, serverName(server)]);
    const s: SignIn = {
      id: randomUUID(),
      actor,
      slot,
      workspaceId,
      dir,
      server,
      shell,
      output: '',
      fresh: '',
      exited: false,
      exitCode: null,
      pid: null,
      callback: '',
      busy: false,
      wake: [],
      timer: setTimeout(() => void this.#end(s, 'expired'), this.#limits.signInMs),
    };
    s.timer.unref();
    this.#open.set(s.id, s);
    this.#slots.set(slot, s.id);
    shell.onData((d) => {
      const text = d.toString('utf8');
      s.output = (s.output + text).slice(-OUTPUT_MAX);
      s.fresh = (s.fresh + text).slice(-OUTPUT_MAX);
      s.pid ??= parseLogin(s.output).pid;
      s.wake.splice(0).forEach((fn) => fn());
    });
    shell.onExit((code) => {
      s.exited = true;
      s.exitCode = code;
      s.wake.splice(0).forEach((fn) => fn());
      // Signed in without a paste: the person's browser reached Claude Code's own listener (the same machine).
      if (code === 0 && !s.busy && this.#open.has(s.id) && parseLogin(s.output).authenticated) {
        this.#forget(s);
        this.#remember(s);
        this.log(`[mcp] sign-in finished for ${serverName(s.server)} in ${workspaceId} (no paste)`);
        this.onSignedIn(workspaceId, dir, server, s.actor);
      }
    });

    await this.#until(s, () => !!parseLogin(s.output).url || s.exited, this.#limits.linkMs);
    const seen = parseLogin(s.output);
    if (!seen.url || (s.exited && !seen.prompting)) {
      const why = seen.absent
        ? 'Claude Code hasn’t loaded this server yet. Start a session in this workspace, or wait for the next delivery, then try again.'
        : (seen.failure ?? (seen.url ? 'it ended at once' : (lastLine(s.output) ?? 'no sign-in address appeared')));
      await this.#end(s, 'failed');
      throw person(`Claude Code didn’t start the sign-in: ${why.replace(/\.$/, '')}.`);
    }
    let found;
    try {
      found = checkAuthUrl(seen.url);
    } catch (e) {
      await this.#end(s, 'refused');
      throw e instanceof AddressError ? person(e.message) : e;
    }
    s.callback = found.callback;
    this.log(`[mcp] sign-in started for ${serverName(server)} in ${workspaceId}${dir ? ` (${dir})` : ''}`);
    return { signInId: s.id, url: found.url, callback: found.callback, expiresAt: new Date(Date.now() + this.#limits.signInMs - 5_000).toISOString() };
  }

  /**
   * Writes the pasted address as Claude Code's input and waits for its answer. An address it turns down can be
   * pasted again while the sign-in is open; the provider's refusal or a timeout ends it.
   */
  async complete(workspaceId: string, signInId: string, pasted: unknown): Promise<{ server: OAuthServer; dir: string; startedBy: string }> {
    const fin = this.#finished.get(signInId);
    if (fin && fin.workspaceId === workspaceId && Date.now() - fin.at < FINISHED_MS) return { server: fin.server, dir: fin.dir, startedBy: fin.actor };
    const s = this.#find(workspaceId, signInId);
    if (s.busy) throw new AppError('CONFLICT', 'An address is being checked. Wait a moment.');
    let line: string;
    try {
      line = checkRedirect(pasted, s.callback);
    } catch (e) {
      if (!(e instanceof AddressError)) throw e;
      throw new AppError('VALIDATION_FAILED', e.message, { details: { redirectUrl: e.message } });
    }
    s.busy = true;
    try {
      s.fresh = '';
      s.shell.write(Buffer.from(`${line}\r`));
      await this.#until(s, () => parseLogin(s.fresh).authenticated || !!parseLogin(s.fresh).failure || parseLogin(s.fresh).refused > 0 || s.exited, this.#limits.answerMs);
      const seen = parseLogin(s.fresh);
      if (seen.authenticated || (s.exited && s.exitCode === 0)) {
        await this.#until(s, () => s.exited, this.#limits.exitMs);
        this.#forget(s);
        this.#remember(s);
        try {
          s.shell.close();
        } catch {
          // already closed
        }
        this.log(`[mcp] sign-in finished for ${serverName(s.server)} in ${workspaceId}`);
        return { server: s.server, dir: s.dir, startedBy: s.actor };
      }
      if (seen.refused > 0 && !s.exited) {
        throw new AppError('VALIDATION_FAILED', 'Claude Code doesn’t accept that address. Copy the whole address of the page that failed to load.', {
          details: { redirectUrl: 'Not the address of this sign-in.' },
        });
      }
      const why = seen.failure ?? (s.exited ? 'it ended without signing in' : 'Claude Code didn’t answer');
      // Anything printed back is scrubbed: it may echo the address.
      const clean = redact(scrubOAuth(stripTerminal(why), line, String(pasted))).replace(/\.$/, '');
      await this.#end(s, 'ended');
      throw person(`Sign-in ended: ${clean}. Start again.`);
    } finally {
      s.busy = false;
    }
  }

  /** The dialog was closed. Safe to call twice, or for a sign-in that ended. */
  async cancel(workspaceId: string, signInId: string, actor: string): Promise<void> {
    const s = this.#open.get(signInId);
    if (!s || s.workspaceId !== workspaceId) return;
    await this.#end(s, 'cancelled', actor);
  }

  /** The workspace is gone: end its sign-ins. */
  async forgetWorkspace(workspaceId: string): Promise<void> {
    for (const s of [...this.#open.values()]) if (s.workspaceId === workspaceId) await this.#end(s, 'workspace_removed');
  }

  #find(workspaceId: string, signInId: string): SignIn {
    const s = this.#open.get(signInId);
    if (!s || s.workspaceId !== workspaceId || s.exited) {
      if (s?.exited) this.#forget(s);
      throw new AppError('CONFLICT', 'That sign-in has ended. Start it again.');
    }
    return s;
  }

  #remember(s: SignIn) {
    const now = Date.now();
    for (const [id, f] of this.#finished) if (now - f.at >= FINISHED_MS) this.#finished.delete(id);
    this.#finished.set(s.id, { workspaceId: s.workspaceId, dir: s.dir, server: s.server, actor: s.actor, at: now });
  }

  #forget(s: SignIn) {
    clearTimeout(s.timer);
    this.#open.delete(s.id);
    if (this.#slots.get(s.slot) === s.id) this.#slots.delete(s.slot);
  }

  /** Stops the login: Ctrl-C first, then its PID, and the terminal closes. */
  async #end(s: SignIn | undefined, why: SignInEnd, by: string | null = null): Promise<void> {
    if (!s) return;
    this.#forget(s);
    this.onEnded({ workspaceId: s.workspaceId, dir: s.dir, server: s.server, actor: s.actor, by, reason: why });
    if (!s.exited) {
      try {
        s.shell.write(Buffer.from('\x03'));
      } catch {
        // the terminal is already gone
      }
      await this.#until(s, () => s.exited, this.#limits.exitMs);
    }
    if (!s.exited && s.pid) await this.#kill(s);
    try {
      s.shell.close();
    } catch {
      // already closed
    }
    if (why !== 'cancelled' && why !== 'replaced') this.log(`[mcp] sign-in for ${serverName(s.server)} in ${s.workspaceId} ended: ${why}`);
  }

  /** Closing the terminal doesn't always stop what runs in it: stop the process by its PID, as the workspace user. */
  async #kill(s: SignIn) {
    const host = this.host();
    if (!host || !s.pid) return;
    const slash = s.workspaceId.indexOf('/');
    try {
      const exec = await host.exec(s.workspaceId.slice(0, slash), s.workspaceId.slice(slash + 1), ['kill', String(s.pid)]);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#limits.exitMs);
        exec.onExit(() => (clearTimeout(timer), resolve()));
      });
      exec.close();
    } catch {
      // the workspace stopped: nothing left to kill
    }
  }

  /** Waits until `ready()` holds (true) or `ms` pass (false). */
  #until(s: SignIn, ready: () => boolean, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let over = false;
      const finish = (ok: boolean) => {
        over = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const check = () => {
        if (over) return;
        if (ready()) finish(true);
        else s.wake.push(check);
      };
      const timer = setTimeout(() => finish(false), ms);
      timer.unref();
      check();
    });
  }
}
