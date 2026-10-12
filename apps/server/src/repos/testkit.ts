// Workspace git: what the tests share. A "workspace" here is a temporary home folder on this machine, and the session host is the real
// generated script (chat/host.ts) run with `sh` against real git: nothing about the host or git is faked, only where it runs.

import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatServerMessage, ChatSession } from '@portal/contracts';
import { redact } from '../chat/redact.js';
import { CP_SESSION } from '../chat/host.js';
import { Store } from '../store/store.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import type { RepoHost } from './host.js';
import { ReposService, type ReposConfig, type SessionSource } from './service.js';

const made: string[] = [];
process.once('exit', () => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

let scriptDir: string | null = null;
/** The session host script, written once. */
export function hostScript(): string {
  if (!scriptDir) {
    scriptDir = mkdtempSync(join(tmpdir(), 'cp-repos-host-'));
    made.push(scriptDir);
    writeFileSync(join(scriptDir, 'cp-session'), CP_SESSION);
    chmodSync(join(scriptDir, 'cp-session'), 0o755);
  }
  return join(scriptDir, 'cp-session');
}

/** An environment that gives git no global or system configuration and a fixed identity. */
export function gitEnv(files: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDEPILOT_FILES_ROOT: files,
    CLAUDEPILOT_SESSIONS_DIR: join(files, '.claudepilot', 'sessions'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Ann Author',
    GIT_AUTHOR_EMAIL: 'ann@example.com',
    GIT_COMMITTER_NAME: 'Ann Author',
    GIT_COMMITTER_EMAIL: 'ann@example.com',
    ...extra,
  };
}

/** A fresh home folder (its real path). */
export function mkFiles(prefix = 'cp-repos-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

export function gitIn(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Runs the host script like the portal does, on this machine, with the folder as the home folder. */
export function runScript(files: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [hostScript(), ...args], { env: gitEnv(files, extraEnv), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

export function localHost(files: string, extraEnv: NodeJS.ProcessEnv = {}): RepoHost & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    ensure: async () => undefined,
    run: async (_ws, args) => {
      calls.push(args);
      return runScript(files, args, extraEnv);
    },
  };
}

export interface Pool {
  files: string;
  env: NodeJS.ProcessEnv;
  /** `<files>/work`. */
  work: string;
  g(cwd: string, ...args: string[]): string;
  path(...parts: string[]): string;
}

/**
 * A home folder with repositories in the shapes the portal has to tell apart: a plain one with a worktree and every kind of change, a
 * bare remote with clones ahead and behind, a superproject with three submodules (one drifted, one a clone without submodules), a nested
 * repository nobody declared, a detached one, one without a commit, one with a stash, one whose remote URL carries a password, a hostile
 * one, and places a scan must not walk into.
 */
export function buildPool(): Pool {
  const files = mkFiles();
  const env = gitEnv(files);
  const work = join(files, 'work');
  mkdirSync(work, { recursive: true });
  const g = (cwd: string, ...args: string[]) => gitIn(cwd, env, ...args);
  const p = (...parts: string[]) => join(work, ...parts);
  const commit = (dir: string, file: string, text: string, message: string) => {
    writeFileSync(join(dir, file), text);
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', message);
  };

  g(work, 'init', '-q', '-b', 'main', 'proj');
  commit(p('proj'), 'a.txt', 'one\n', 'first commit');
  commit(p('proj'), 'a.txt', 'one\ntwo\n', 'second: add two');
  g(p('proj'), 'worktree', 'add', '-q', '-b', 'feat/x', '../proj.worktrees/feat-x');

  g(work, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  g(work, 'clone', '-q', 'remote.git', 'seed');
  commit(p('seed'), 's.txt', 's\n', 'seed');
  g(p('seed'), 'push', '-q', 'origin', 'main');
  rmSync(p('seed'), { recursive: true, force: true });
  g(work, 'clone', '-q', 'remote.git', 'synced');
  g(work, 'clone', '-q', 'remote.git', 'other');
  commit(p('other'), 'o1.txt', 'o1\n', 'other: one');
  commit(p('other'), 'o2.txt', 'o2\n', 'other: two');
  g(p('other'), 'push', '-q', 'origin', 'main');

  for (const s of ['a', 'b', 'c']) {
    g(work, 'init', '-q', '-b', 'main', `src-${s}`);
    commit(p(`src-${s}`), 'f.txt', `${s}\n`, `init ${s}`);
  }
  g(work, 'init', '-q', '-b', 'main', 'uni');
  for (const s of ['a', 'b', 'c']) g(p('uni'), 'submodule', 'add', '-q', p(`src-${s}`), `mods/${s}`);
  g(p('uni'), 'commit', '-q', '-m', 'add submodules');
  commit(p('uni', 'mods', 'a'), 'f.txt', 'a\nmore\n', 'a: newer');
  mkdirSync(p('uni', 'tools'), { recursive: true });
  g(p('uni', 'tools'), 'init', '-q', '-b', 'main', 'helper');
  commit(p('uni', 'tools', 'helper'), 'h.txt', 'h\n', 'helper init');
  g(work, 'clone', '-q', 'uni', 'uni2');
  g(p('uni2'), 'submodule', 'update', '--init', '-q', 'mods/a', 'mods/b');

  writeFileSync(p('proj', 'staged.txt'), 'staged\n');
  g(p('proj'), 'add', 'staged.txt');
  writeFileSync(p('proj', 'a.txt'), 'one\ntwo\nchanged\n');
  writeFileSync(p('proj', 'untracked.txt'), 'u\n');

  g(work, 'clone', '-q', 'proj', 'detached');
  g(p('detached'), 'checkout', '-q', '--detach', 'HEAD~1');
  g(work, 'init', '-q', '-b', 'main', 'empty');
  g(work, 'clone', '-q', 'proj', 'stashy');
  writeFileSync(p('stashy', 'a.txt'), 'one\ntwo\nstash me\n');
  g(p('stashy'), 'stash', '-q');
  g(work, 'clone', '-q', 'proj', 'creds');
  g(p('creds'), 'remote', 'set-url', 'origin', 'https://user:p@ss@example.com/x/y.git?token=abc#frag');
  g(p('creds'), 'remote', 'add', 'pilot', join(files, '.claudepilot', 'git', 'proj.git'));

  mkdirSync(p('node_modules', 'dep'), { recursive: true });
  g(p('node_modules', 'dep'), 'init', '-q', 'pkg');
  mkdirSync(p('.hidden'), { recursive: true });
  g(p('.hidden'), 'init', '-q', 'secret');

  g(work, 'init', '-q', '-b', 'main', 'evil');
  commit(p('evil'), 'x.txt', 'x\n', 'evil init');
  g(p('evil'), 'config', 'core.fsmonitor', `sh -c 'touch ${files}/PWNED-fsmonitor' #`);
  mkdirSync(p('evil', 'hooks-evil'));
  writeFileSync(p('evil', 'hooks-evil', 'post-checkout'), `#!/bin/sh\ntouch ${files}/PWNED-hook\n`);
  chmodSync(p('evil', 'hooks-evil', 'post-checkout'), 0o755);
  g(p('evil'), 'config', 'core.hooksPath', p('evil', 'hooks-evil'));
  g(p('evil'), 'config', 'filter.evil.clean', `sh -c 'touch ${files}/PWNED-filter; cat'`);
  g(p('evil'), 'config', 'filter.evil.smudge', `sh -c 'touch ${files}/PWNED-smudge; cat'`);
  writeFileSync(p('evil', '.gitattributes'), '*.x filter=evil\n');
  writeFileSync(p('evil', 'data.x'), 'data\n');

  return { files, env, work, g, path: p };
}

/** Writes a file and commits it. */
export function commitFile(pool: Pool, dir: string, file: string, text: string, message: string): void {
  writeFileSync(join(dir, file), text);
  pool.g(dir, 'add', '-A');
  pool.g(dir, 'commit', '-q', '-m', message);
}

export const WS = 'docker/t1';

export interface FakeSessions extends SessionSource {
  sessions: ChatSession[];
  emit(id: string, msg: ChatServerMessage): void;
}

export function fakeSessions(): FakeSessions {
  const listeners = new Set<(id: string, msg: ChatServerMessage) => void>();
  const s: FakeSessions = {
    sessions: [],
    list: (f) => s.sessions.filter((x) => !f?.workspaceId || x.workspaceId === f.workspaceId),
    onEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: (id, msg) => listeners.forEach((l) => l(id, msg)),
  };
  return s;
}

/** A chat session as far as the repositories care. */
export function chatSession(over: Partial<ChatSession> & { id: string; cwd: string }): ChatSession {
  return {
    workspaceId: WS,
    title: 'chat',
    state: 'idle',
    origin: 'ui',
    model: null,
    mode: 'default',
    effort: null,
    ultracode: false,
    ultracodeAvailable: false,
    process: 'live',
    context: null,
    costUsd: 0,
    turns: 0,
    lastSeq: 0,
    waiting: 0,
    waitingFor: null,
    createdAt: '2026-10-12T00:00:00.000Z',
    lastActivityAt: new Date().toISOString(),
    endedReason: null,
    claudeId: '',
    claudeName: null,
    predecessorId: null,
    successorId: null,
    archivedAt: null,
    ticketId: null,
    parentId: null,
    worktree: null,
    startedBy: 'ui',
    bypassCapable: false,
    claudeSessionId: over.id,
    previousClaudes: [],
    switching: null,
    ...over,
  } as ChatSession;
}

export async function reposHarness(opts: { files: string; running?: boolean; config?: Partial<ReposConfig>; host?: RepoHost; now?: { t: number } } ) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-repos-db-'));
  made.push(dataDir);
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const host = opts.host ?? localHost(opts.files);
  const sessions = fakeSessions();
  const state = { running: opts.running ?? true, supported: true };
  let changes = 0;
  const clock = opts.now ?? null;
  const repos = new ReposService({
    store,
    host,
    workspaces: async () => [{ id: WS, name: 't1', running: state.running, supported: state.supported }],
    sessions,
    scrub: (_ws, text) => redact(text),
    notify: () => void changes++,
    config: { auto: false, ...opts.config },
    now: clock ? () => clock.t : undefined,
    random: () => 0.5,
  });
  return {
    store,
    repos,
    sessions,
    host,
    /** The host commands run so far (when the host is the local one). */
    calls: (): string[][] => ('calls' in host ? (host as { calls: string[][] }).calls : []),
    state,
    changes: () => changes,
    done: () => {
      repos.stop();
      store.close();
    },
  };
}
