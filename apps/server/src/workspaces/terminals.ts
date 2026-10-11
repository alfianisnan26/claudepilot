import { AppError } from '@isnanme/core';
import { TERMINAL_MAX, type CreateTerminalRequest, type TerminalKind, type WorkspaceTerminal } from '@portal/contracts';
import type { Workspaces } from './manager.js';
import { runToEnd } from './runToEnd.js';

/** Our tmux sessions are `cp-<id>`; anything else on the workspace's tmux server is the user's own. */
const PREFIX = 'cp-';
export const TERMINAL_ID = /^(claude|shell)-[1-9][0-9]?$/;
const INSTALL_LIMIT_MS = 3 * 60_000;
const FOLDER_MAX = 4096;

/** The Claude Code installer's bin folder first (see claudeLogin.ts), then Claude Code, then a shell when it exits. */
const PROGRAM: Record<TerminalKind, string> = {
  claude: 'PATH="$HOME/.local/bin:$PATH"; export PATH; claude; exec "${SHELL:-bash}" -l',
  shell: 'exec "${SHELL:-bash}" -l',
};

/** `~`, `~/…` or an absolute path, one line; the home folder when empty. */
export function cleanFolder(input: unknown): string {
  const folder = typeof input === 'string' ? input.trim() : '';
  if (!folder) return '~';
  if (folder.length > FOLDER_MAX || /[\0\n\r]/.test(folder) || !(folder === '~' || folder.startsWith('~/') || folder.startsWith('/'))) {
    const message = 'Use a folder like ~/work/api or /srv/app.';
    throw new AppError('VALIDATION_FAILED', message, { details: { cwd: message } });
  }
  return folder;
}

/** The attach command for the shell socket: tmux's own client, onto an existing terminal only. */
export function attachCommand(id: string): string[] {
  if (!TERMINAL_ID.test(id)) throw new AppError('VALIDATION_FAILED', 'Unknown terminal.');
  return ['tmux', 'attach-session', '-t', `${PREFIX}${id}`];
}

/**
 * Terminals that outlive the browser: tmux sessions in the workspace, as its user, so several Claude
 * Codes (on the workspace's own Claude sign-in) can run side by side and keep working with no tab
 * open. tmux is installed when it's missing (workspace images ship it; this machine may not), and
 * Claude Code too, through the sign-in's installer.
 */
export class Terminals {
  /** One tmux install at a time per workspace. */
  readonly #installs = new Map<string, Promise<void>>();

  constructor(
    private readonly workspaces: Workspaces,
    private readonly claude: { ensureInstalled(target: string, name: string): Promise<void> },
  ) {}

  async list(target: string, name: string): Promise<WorkspaceTerminal[]> {
    const format = ['#{session_name}', '#{session_created}', '#{session_attached}', '#{pane_current_path}', '#{pane_current_command}', '#{pane_pid}'].join('\t');
    // No tmux, or no server yet: nothing open (the exit code says so, the output doesn't matter).
    const r = await runToEnd(this.workspaces, target, name, ['sh', '-c', 'command -v tmux >/dev/null && tmux list-sessions -F "$1" 2>/dev/null || true', 'sh', format]);
    const rows = r.output
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([session]) => session?.startsWith(PREFIX) && TERMINAL_ID.test(session.slice(PREFIX.length)));
    const programs = await this.#programs(target, name, rows.map((row) => row[5] ?? ''));
    return rows
      .map(([session, created, attached, cwd, command, pid]) => {
        const id = session!.slice(PREFIX.length);
        return {
          id,
          kind: id.startsWith('claude') ? 'claude' : 'shell',
          cwd: cwd ?? '',
          command: programs.get(pid ?? '') ?? command ?? '',
          createdAt: new Date(Number(created) * 1000 || Date.now()).toISOString(),
          attached: Number(attached) || 0,
        } satisfies WorkspaceTerminal;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * What each pane runs now: the pane's shell starts Claude Code (or whatever was typed) as its
   * child, and tmux's pane_current_command names only the shell. Pane PID → its first child's name.
   */
  async #programs(target: string, name: string, pids: string[]): Promise<Map<string, string>> {
    const valid = pids.filter((p) => /^[0-9]{1,10}$/.test(p));
    if (!valid.length) return new Map();
    const r = await runToEnd(this.workspaces, target, name, ['ps', '-o', 'ppid=,comm=', '--ppid', valid.join(',')]).catch(() => null);
    const map = new Map<string, string>();
    for (const line of r?.output.split('\n') ?? []) {
      const [ppid, comm] = line.trim().split(/\s+/, 2);
      if (ppid && comm && !map.has(ppid)) map.set(ppid, comm);
    }
    return map;
  }

  async create(target: string, name: string, req: Partial<CreateTerminalRequest>): Promise<WorkspaceTerminal> {
    const kind: TerminalKind = req.kind === 'shell' ? 'shell' : 'claude';
    const folder = cleanFolder(req.cwd);
    await this.#ensureTmux(target, name);
    const open = await this.list(target, name);
    if (open.length >= TERMINAL_MAX)
      throw new AppError('CONFLICT', `${TERMINAL_MAX} terminals are open in this workspace. Close one first.`);
    if (kind === 'claude') await this.claude.ensureInstalled(target, name);

    let n = 1;
    while (open.some((t) => t.id === `${kind}-${n}`)) n++;
    const id = `${kind}-${n}`;
    // Folder, session and program go in as arguments; `~` is expanded by the workspace's own shell.
    const script = [
      'd="$1"',
      'case "$d" in "~") d="$HOME" ;; "~/"*) d="$HOME/${d#\\~/}" ;; esac',
      '[ -d "$d" ] || { echo "No folder $d" >&2; exit 3; }',
      'tmux new-session -d -s "$2" -n "$4" -x 160 -y 48 -c "$d" "$3" || exit $?',
      // The portal's tabs replace tmux's status line (a row less on a phone); the mouse scrolls history.
      'tmux set-option -t "$2" status off >/dev/null; tmux set-option -t "$2" mouse on >/dev/null; true',
    ].join('; ');
    const r = await runToEnd(this.workspaces, target, name, ['sh', '-c', script, 'sh', folder, `${PREFIX}${id}`, PROGRAM[kind], kind]);
    if (r.code !== 0) {
      const why = r.output.trim().split('\n').pop() || `exit ${r.code}`;
      throw new AppError(r.code === 3 ? 'VALIDATION_FAILED' : 'SERVICE_UNAVAILABLE', `Couldn’t open the terminal: ${why}`, {
        expose: true,
        ...(r.code === 3 ? { details: { cwd: why } } : {}),
      });
    }
    console.log(`[workspaces] terminal ${id} opened in ${target}/${name}`);
    const made = (await this.list(target, name)).find((t) => t.id === id);
    return made ?? { id, kind, cwd: folder, command: kind, createdAt: new Date().toISOString(), attached: 0 };
  }

  async close(target: string, name: string, id: string): Promise<void> {
    if (!TERMINAL_ID.test(id)) throw new AppError('NOT_FOUND', 'That terminal doesn’t exist.');
    const r = await runToEnd(this.workspaces, target, name, ['tmux', 'kill-session', '-t', `${PREFIX}${id}`]);
    if (r.code !== 0) throw new AppError('NOT_FOUND', 'That terminal doesn’t exist.');
    console.log(`[workspaces] terminal ${id} closed in ${target}/${name}`);
  }

  /** tmux, installed with the system's package manager through passwordless sudo when it's missing. */
  #ensureTmux(target: string, name: string): Promise<void> {
    const id = `${target}/${name}`;
    const running = this.#installs.get(id);
    if (running) return running;
    const install = (async () => {
      if ((await runToEnd(this.workspaces, target, name, ['sh', '-c', 'command -v tmux'])).code === 0) return;
      console.log(`[workspaces] installing tmux in ${id}`);
      const script = [
        'set -e',
        'sudo -n true 2>/dev/null || { echo "needs passwordless sudo to install tmux"; exit 4; }',
        'if command -v apt-get >/dev/null; then sudo -n apt-get update -qq && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux',
        'elif command -v apk >/dev/null; then sudo -n apk add --no-cache tmux',
        'elif command -v dnf >/dev/null; then sudo -n dnf install -y tmux',
        'else echo "no known package manager"; exit 4; fi',
      ].join('\n');
      const r = await runToEnd(this.workspaces, target, name, ['sh', '-c', script], INSTALL_LIMIT_MS);
      const ok = r.code === 0 && (await runToEnd(this.workspaces, target, name, ['sh', '-c', 'command -v tmux'])).code === 0;
      if (!ok) {
        const why = r.code === null ? 'the install took too long' : r.output.trim().split('\n').pop() || `exit ${r.code}`;
        throw new AppError('SERVICE_UNAVAILABLE', `tmux isn’t installed in this workspace and couldn’t be installed: ${why}`, { expose: true });
      }
      console.log(`[workspaces] installed tmux in ${id}`);
    })().finally(() => this.#installs.delete(id));
    this.#installs.set(id, install);
    return install;
  }
}
