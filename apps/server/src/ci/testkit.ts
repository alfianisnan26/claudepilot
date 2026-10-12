// Test helpers (not used by the portal): the service on a real database and a "workspace" that is a temporary home folder on
// this machine, where the real cp-ci runs against real git.
import { AppError } from '@isnanme/core';
import type { CiRun } from '@portal/contracts';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import type { CiHost, CiReply } from './host.js';
import { Home } from './runner/testkit.js';
import { CiService, type CiServiceOptions } from './service.js';

export const WS = 'docker/test';
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A workspace that is a temporary home folder here: cp-ci really runs there. */
export class HomeHost implements CiHost {
  running = true;
  failNext: Error | null = null;
  readonly calls: string[][] = [];
  constructor(readonly home: Home) {}
  async state() {
    return this.running ? ('running' as const) : ('stopped' as const);
  }
  async states() {
    return new Map<string, 'running' | 'stopped'>([[WS, this.running ? 'running' : 'stopped']]);
  }
  async cp(_id: string, args: string[], opts?: { stdin?: string }): Promise<CiReply> {
    this.calls.push(args);
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    return this.home.ci(args, { stdin: opts?.stdin });
  }
  async install() {}
}

export async function harness(opts: CiServiceOptions = {}) {
  const dataDir = tempDirectory('cp-ci-svc-');
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const home = new Home();
  const host = new HomeHost(home);
  const svc = new CiService(store, host, { pollActiveMs: 50, pollIdleMs: 50, ...opts });
  let changes = 0;
  svc.onChange = () => void changes++;
  const created: string[] = [];
  const finished: { id: string; status: string; was: string | null }[] = [];
  svc.hooks = { created: (r) => void created.push(r.id), changed: (r, was) => void finished.push({ id: r.id, status: r.status, was }) };
  const src = home.repo('app', { 'README.md': '# app\n' });
  return {
    store, home, host, svc, src, created, finished,
    changes: () => changes,
    /** Polls until the predicate holds. */
    async until(what: string, ok: () => boolean, ms = 60_000) {
      const stop = Date.now() + ms;
      while (!ok()) {
        if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
        await svc.poll(WS);
        await sleep(100);
      }
    },
    async run(id: string): Promise<CiRun> {
      return svc.show(id);
    },
    done: () => store.close(),
  };
}
export type H = Awaited<ReturnType<typeof harness>>;

export const PIPELINE = `on:
  push: { branches: ['**'] }
  merge: { branches: [main] }
  manual:
    inputs:
      target: { type: choice, options: [staging, production], default: staging }
jobs:
  test:
    steps:
      - name: Say
        run: echo "hello from $PILOT_BRANCH"
      - run: test -f README.md
`;

/** A remote made from the harness's repository with a .pilot pipeline committed on main, connected as `pilot`. */
export async function remote(h: H, files: Record<string, string> = { '.pilot/ci.yml': PIPELINE }) {
  h.home.commit(h.src, files, 'add pipeline');
  const repo = await h.svc.createRepo({ workspaceId: WS, name: 'app', source: h.src, connect: true });
  // The clone is not an event; the baseline for pushes starts here.
  await h.svc.poll(WS);
  return repo;
}

export const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    return e instanceof AppError ? e.code : `other:${(e as Error).message}`;
  }
  return 'none';
};

