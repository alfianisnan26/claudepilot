// Test kit for chat content: the real cp-session script run on this machine in place of a workspace, so
// staging and copy-out are tested against the script itself and not a guess of what it does.

import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store/store.js';
import { generateSecretKey, parseSecretKey } from '../../store/secretBox.js';
import type { Workspaces } from '../../workspaces/manager.js';
import type { ExecSession } from '../../workspaces/runtime.js';
import { CP_SESSION } from '../host.js';
import { ChatStore } from '../store.js';
import { FakeWorkspaces } from '../testkit.js';

/** A temporary folder that is removed by {@link cleanup}. */
const made: string[] = [];
export const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `cp-${prefix}-`));
  made.push(dir);
  return dir;
};
export const cleanup = (): void => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
};

/**
 * A `Workspaces` whose `exec` runs the real `cp-session` script as a local process, with the folders it
 * works in pointed at temporary ones: `files` is the root the Files commands may read (CLAUDEPILOT_FILES_ROOT),
 * `uploads` where `put` stages. Commands arrive as ['sh', <script path>, ...args], like the portal sends them.
 */
export class LocalHost {
  readonly root = temp('host');
  readonly files = join(this.root, 'home');
  readonly uploads = join(this.root, 'uploads');
  readonly sessions = join(this.root, 'sessions');
  readonly script = join(this.root, 'cp-session');
  /** The commands run, in order (first argument is the host command). */
  readonly commands: string[][] = [];
  /** Extra environment for the script. */
  env: NodeJS.ProcessEnv = {};
  /** Tests of a cut transfer: the n-th exec's stdin loses everything after this many bytes (the writes are taken, nothing arrives). */
  cutStdinAfter: { bytes: number; execs: number } | null = null;

  constructor() {
    mkdirSync(this.files, { recursive: true });
    writeFileSync(this.script, CP_SESSION);
    chmodSync(this.script, 0o755);
  }

  runtimeFor(): object {
    return {};
  }

  async exec(_target: string, _name: string, command: string[]): Promise<ExecSession> {
    const args = command.slice(2);
    this.commands.push(args);
    const child = spawn('sh', [this.script, ...args], {
      env: { ...process.env, CLAUDEPILOT_FILES_ROOT: this.files, CLAUDEPILOT_UPLOADS_DIR: this.uploads, CLAUDEPILOT_SESSIONS_DIR: this.sessions, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const data: ((b: Buffer) => void)[] = [];
    const exits: ((code: number | null) => void)[] = [];
    // Like a real exec, stderr comes merged into stdout.
    child.stdout.on('data', (c: Buffer) => data.forEach((fn) => fn(c)));
    child.stderr.on('data', (c: Buffer) => data.forEach((fn) => fn(c)));
    child.stdin.on('error', () => undefined);
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      exits.forEach((fn) => fn(code));
    };
    child.on('error', (e) => {
      data.forEach((fn) => fn(Buffer.from(`${e.message}\n`)));
      finish(127);
    });
    child.on('close', finish);
    let took = 0;
    const cut = this.cutStdinAfter && this.cutStdinAfter.execs-- > 0 ? this.cutStdinAfter.bytes : null;
    return {
      write: (d) => {
        if (cut !== null && took >= cut) return;
        const piece = cut === null ? d : d.slice(0, cut - took);
        took += piece.length;
        void child.stdin.write(piece);
        if (cut !== null && took >= cut) child.stdin.end(); // the rest never comes: the host sees the end of the input
      },
      close: () => void child.stdin.destroy(),
      onData: (fn) => void data.push(fn),
      onExit: (fn) => void exits.push(fn),
    };
  }

  asWorkspaces(): Workspaces {
    return this as unknown as Workspaces;
  }
}

/** A portal store in a temporary data directory with one chat session row in it. */
export async function storeWithSession(id = 'S1') {
  const dataDir = temp('store');
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const chat = new ChatStore(store);
  chat.create({ id, workspaceId: 'docker/ws1', cwd: '/home/node', title: 'Test', origin: 'ui' });
  return { store, chat, dataDir, sessionId: id, close: () => store.close() };
}

/**
 * The fake chat host of the chat tests, except that the content commands (`put`, `unstage`, `cat`, `produced`) run
 * the real cp-session script on this machine, against a temporary files root: what staging and copy-out do to
 * real files is what the tests see.
 */
export class StagingWorkspaces extends FakeWorkspaces {
  readonly local = new LocalHost();
  /** Fails every `put` with this exit code when set (nothing is written). */
  putCode = 0;
  override async exec(target: string, name: string, command: string[]): Promise<ExecSession> {
    const cmd = command[2];
    if (cmd === 'put' || cmd === 'unstage' || cmd === 'cat' || cmd === 'produced') {
      this.ops.push(`${cmd} ${command[3] ?? ''}`.trim());
      if (cmd === 'put' && this.putCode !== 0) {
        const code = this.putCode;
        return { write: () => undefined, close: () => undefined, onData: () => undefined, onExit: (fn) => void setTimeout(() => fn(code), 0) };
      }
      return this.local.exec(target, name, command);
    }
    return super.exec(target, name, command);
  }
}
