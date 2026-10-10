import { AppError } from '@isnanme/core';
import type { ClaudeAuthStatus } from '@portal/contracts';
import type { Workspaces } from './manager.js';
import type { ExecSession } from './runtime.js';

/** How long a started sign-in waits for its code; `timeout` also ends it inside the workspace. */
const LOGIN_LIMIT_S = 15 * 60;
const LINK_WAIT_MS = 20_000;
const CODE_WAIT_MS = 60_000;
/** Claude Code's sign-in pages. A link anywhere else is refused, so the portal never shows a lookalike. */
const SIGN_IN_HOSTS = ['claude.com', 'claude.ai', 'anthropic.com'];
const PROMPT = /paste code/i;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const OUTPUT_MAX = 64 * 1024;

/** The sign-in link Claude Code printed, when it points at an Anthropic host over https. */
export function signInLink(output: string): string | null {
  const found = output.replace(ANSI, '').match(/https:\/\/[^\s"'<>]+/);
  if (!found) return null;
  try {
    const url = new URL(found[0]);
    const host = url.hostname;
    return url.protocol === 'https:' && SIGN_IN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Prefills the email on Claude's sign-in page (optional). A plain address; anything odd is dropped. */
export function cleanEmail(input: unknown): string | null {
  const email = typeof input === 'string' ? input.trim() : '';
  return /^[^\s@"']{1,128}@[^\s@"']{1,128}$/.test(email) ? email : null;
}

/** The code Anthropic's page shows: one line of letters, digits and a few separators. */
export function cleanCode(input: unknown): string {
  const code = typeof input === 'string' ? input.trim() : '';
  if (!/^[A-Za-z0-9._~#-]{8,1024}$/.test(code)) {
    const message = 'Paste the whole code the sign-in page shows.';
    throw new AppError('VALIDATION_FAILED', message, { details: { code: message } });
  }
  return code;
}

/** The last thing Claude Code said, for an error message (never the code itself). */
function lastLine(output: string, code: string): string {
  const lines = output.replace(ANSI, '').split(code).join('[code]').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.filter((l) => !PROMPT.test(l)).pop() ?? '';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

interface Login {
  exec: ExecSession;
  pid: number | null;
  output: string;
  exited: boolean;
  exitCode: number | null;
  timer: NodeJS.Timeout;
  wake: (() => void)[];
}

/**
 * Signs a workspace's Claude Code in to the person's own Claude account (Pro, Max, Team) from the
 * portal. It runs Claude Code's own `claude auth login` in the workspace, shows the link that prints,
 * and writes the code the person pastes to its stdin. Claude Code does the OAuth exchange (PKCE) and
 * keeps the credential in the workspace's home: the portal never stores, logs or reads it, and it
 * never goes into a pool (Account Pool PRD §6).
 */
export class ClaudeLogins {
  readonly #logins = new Map<string, Login>();

  constructor(private readonly workspaces: Workspaces) {}

  /** `sso`: Claude Code's single sign-on flow, for organizations that sign in through their identity provider. */
  async start(target: string, name: string, opts: { sso?: boolean; email?: string | null } = {}): Promise<{ url: string }> {
    const id = `${target}/${name}`;
    await this.cancel(target, name);
    // Options go in as arguments ("$@"), never through the shell's parsing.
    const email = cleanEmail(opts.email);
    const args = ['--claudeai', ...(opts.sso ? ['--sso'] : []), ...(email ? ['--email', email] : [])];
    const exec = await this.workspaces.exec(target, name, ['sh', '-c', `echo "cp-pid:$$"; exec timeout ${LOGIN_LIMIT_S} claude auth login "$@"`, 'sh', ...args]);
    const login: Login = {
      exec,
      pid: null,
      output: '',
      exited: false,
      exitCode: null,
      wake: [],
      timer: setTimeout(() => void this.cancel(target, name), LOGIN_LIMIT_S * 1000),
    };
    login.timer.unref();
    this.#logins.set(id, login);
    exec.onData((d) => {
      login.output = (login.output + d.toString('utf8')).slice(-OUTPUT_MAX);
      login.pid ??= Number(/cp-pid:(\d+)/.exec(login.output)?.[1]) || null;
      login.wake.splice(0).forEach((fn) => fn());
    });
    exec.onExit((code) => {
      login.exited = true;
      login.exitCode = code;
      login.wake.splice(0).forEach((fn) => fn());
    });

    const ready = await this.#until(login, () => !!signInLink(login.output) || login.exited, LINK_WAIT_MS);
    const url = signInLink(login.output);
    if (!ready || !url) {
      const why = login.exitCode === 127 ? 'Claude Code isn’t installed in this workspace.' : lastLine(login.output, '\u0000') || 'No sign-in link appeared.';
      await this.cancel(target, name);
      throw new AppError('SERVICE_UNAVAILABLE', `Claude Code didn’t start its sign-in: ${why}`);
    }
    console.log(`[workspaces] Claude sign-in started in ${id}${opts.sso ? ' (SSO)' : ''}`);
    return { url };
  }

  /** Hands the code to Claude Code. A code it rejects can be pasted again while the sign-in runs. */
  async submit(target: string, name: string, input: unknown): Promise<void> {
    const id = `${target}/${name}`;
    const login = this.#logins.get(id);
    if (!login || login.exited) throw new AppError('CONFLICT', 'That sign-in has ended. Start it again.');
    const code = cleanCode(input);
    const mark = login.output.length;
    login.exec.write(`${code}\n`);
    // Done when Claude Code exits, or asks for a code again because this one didn't work.
    const answered = await this.#until(login, () => login.exited || PROMPT.test(login.output.slice(mark)), CODE_WAIT_MS);
    if (login.exited && login.exitCode === 0) {
      this.#forget(id);
      console.log(`[workspaces] Claude sign-in finished in ${id}`);
      return;
    }
    const why = answered ? lastLine(login.output.slice(mark), code) : 'Claude Code didn’t answer.';
    if (login.exited || !answered) await this.cancel(target, name);
    const message = `${why || 'Claude Code didn’t accept the code.'}${login.exited || !answered ? ' Start the sign-in again.' : ''}`;
    throw new AppError('VALIDATION_FAILED', message, { details: { code: message } });
  }

  /** Ends a sign-in that's still waiting (the dialog was closed). */
  async cancel(target: string, name: string): Promise<void> {
    const id = `${target}/${name}`;
    const login = this.#logins.get(id);
    if (!login) return;
    this.#forget(id);
    // Closing stdin doesn't end `claude auth login`: stop it by its PID (the `timeout` wrapping it).
    if (!login.exited && login.pid) await this.#run(target, name, ['kill', String(login.pid)]).catch(() => undefined);
    login.exec.close();
  }

  /** Claude Code's own `claude auth status` (status only, never the credential). */
  async status(target: string, name: string): Promise<ClaudeAuthStatus> {
    const r = await this.#run(target, name, ['claude', 'auth', 'status', '--json']);
    const brace = r.output.indexOf('{');
    if (brace < 0) return { loggedIn: false, method: 'unknown' };
    try {
      const j = JSON.parse(r.output.slice(brace, r.output.lastIndexOf('}') + 1)) as { loggedIn?: unknown; authMethod?: unknown };
      return { loggedIn: j.loggedIn === true, method: typeof j.authMethod === 'string' ? j.authMethod : 'unknown' };
    } catch {
      return { loggedIn: false, method: 'unknown' };
    }
  }

  /** `claude auth logout` in the workspace. */
  async logout(target: string, name: string): Promise<void> {
    const r = await this.#run(target, name, ['claude', 'auth', 'logout']);
    if (r.code !== 0) throw new AppError('SERVICE_UNAVAILABLE', `Signing out failed: ${lastLine(r.output, '\u0000') || `exit ${r.code}`}`);
    console.log(`[workspaces] Claude signed out in ${target}/${name}`);
  }

  #forget(id: string) {
    const login = this.#logins.get(id);
    if (!login) return;
    clearTimeout(login.timer);
    this.#logins.delete(id);
  }

  /** Waits until `ready()` holds (true) or `ms` pass (false). */
  #until(login: Login, ready: () => boolean, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const check = () => {
        if (ready()) return (clearTimeout(timer), resolve(true));
        login.wake.push(check);
      };
      const timer = setTimeout(() => resolve(false), ms);
      check();
    });
  }

  /** A short command, to completion (10 s at most). */
  async #run(target: string, name: string, command: string[]): Promise<{ code: number | null; output: string }> {
    const exec = await this.workspaces.exec(target, name, command);
    let output = '';
    exec.onData((d) => (output = (output + d.toString('utf8')).slice(-OUTPUT_MAX)));
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 10_000);
      exec.onExit((c) => (clearTimeout(timer), resolve(c)));
    });
    exec.close();
    return { code, output };
  }
}
