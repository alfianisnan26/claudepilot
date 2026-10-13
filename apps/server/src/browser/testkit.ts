// Test helpers for the browser pool: a fresh store with the pool service and the browser kind, and a fake Docker
// target (workspace containers and browser containers in memory, a supervisor that answers `cpb-ctl`). Not used by
// the portal itself.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserPoolContent, BROWSER_POOL_DEFAULTS } from '@portal/contracts';
import type { WorkspaceStep } from '../delivery/steps.js';
import type { WorkspaceSteps } from '../delivery/steps.js';
import type { FragmentProvider } from '../delivery/reconciler.js';
import { PoolService } from '../pools/service.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { Companions, CompanionInfo, CompanionPlan, ExecStream } from './companion.js';
import { BrowserKind } from './kind.js';
import { kubeCapRefusal, type KubeBrowsers } from './kube.js';
import { BrowserService, type SupervisorStatus } from './service.js';
import { splitWorkspaceId } from './spec.js';

/** A supervisor status with sensible defaults, for tests to override. */
export function supervisorStatus(over: Partial<SupervisorStatus> = {}): SupervisorStatus {
  return {
    protocol: 1,
    bootId: 'sup-1',
    tier: 'browser',
    display: { width: 1280, height: 800 },
    sandbox: 'on',
    chrome: { state: 'up', pid: 100, since: Date.now() - 60_000, bootId: 'chrome-1', starts: 1, crashes: 0, error: null },
    vnc: { up: true, enabled: true },
    control: { held: false },
    viewers: 0,
    activity: { at: 0, toolAt: 0, tool: null, session: null },
    sessions: 0,
    idle: { minutes: 30, stopAt: null },
    memory: { used: 300_000_000, limit: 3_000_000_000 },
    handoffs: [],
    takeOver: true,
    private: false,
    tabs: [{ id: 'A'.repeat(32), title: 'Home', url: 'http://localhost:5173/' }],
    ...over,
  };
}

/** A process in a browser container (`cpb-view`, `cpb-vnc`) that a test drives: what was written to it, and what it says back. */
export function fakeHelper(cmd: string[]) {
  const writes: string[] = [];
  const dataFns: ((d: Buffer) => void)[] = [];
  const exitFns: ((code: number | null) => void)[] = [];
  const state = { closed: false };
  const stream: ExecStream = {
    write: (d) => void writes.push(String(d)),
    end: () => undefined,
    close: () => void (state.closed = true),
    onData: (fn) => void dataFns.push(fn),
    onError: () => undefined,
    onExit: (fn) => void exitFns.push(fn),
  };
  return {
    cmd,
    stream,
    state,
    /** Lines written to its stdin, parsed. */
    sent: () => writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
    say: (data: Buffer) => dataFns.forEach((fn) => fn(data)),
    exit: (code: number | null = 0) => exitFns.forEach((fn) => fn(code)),
  };
}
export type FakeHelper = ReturnType<typeof fakeHelper>;

interface FakeContainer {
  id: string;
  running: boolean;
  startedAt: string;
  netns: string;
  spec: string;
  pool: string;
  portal: string;
}

/** A Docker target in memory: workspaces, their browser containers, and what was done to them. */
export function fakeTarget(targetId = 'docker', portal = 'portal-1') {
  const workspaces = new Map<string, { id: string; running: boolean; startedAt: string }>();
  const containers = new Map<string, FakeContainer>();
  const calls: string[] = [];
  const state = {
    sandboxWorks: true,
    supervisor: supervisorStatus(),
    ctl: [] as { cmd: string; args: string[] }[],
    failCreate: null as string | null,
    wiped: [] as string[],
    imageId: 'sha256:image-1',
    /** Processes started with `stream`, in order. */
    helpers: [] as FakeHelper[],
  };
  let seq = 0;
  const comps = {
    targetId,
    available: true,
    workspace: async (name: string) => workspaces.get(name) ?? null,
    inspect: async (name: string): Promise<CompanionInfo | null> => {
      const c = containers.get(name);
      return c ? { id: c.id, running: c.running, startedAt: c.startedAt, netns: c.netns, spec: c.spec, pool: c.pool, portal: c.portal, health: c.running ? 'running' : 'exited' } : null;
    },
    list: async () => [...containers].filter(([, c]) => c.portal === portal).map(([name]) => name),
    gateway: async () => '172.17.0.1',
    sandboxWorks: async () => state.sandboxWorks,
    imageId: async () => state.imageId,
    specHash: async (plan: CompanionPlan) => `spec:${plan.content.tier}:${plan.content.display}:${plan.content.idleMinutes}:${plan.sandbox}:${state.imageId}`,
    prepareMounts: async (name: string) => void calls.push(`mounts ${name}`),
    create: async (plan: CompanionPlan, netns: string, spec: string) => {
      if (state.failCreate) throw new Error(state.failCreate);
      calls.push(`create ${plan.workspace}`);
      containers.set(plan.workspace, { id: `b${++seq}`, running: false, startedAt: '', netns, spec, pool: plan.poolId, portal });
    },
    start: async (name: string) => {
      calls.push(`start ${name}`);
      const c = containers.get(name);
      if (c) Object.assign(c, { running: true, startedAt: new Date().toISOString() });
    },
    stop: async (name: string) => {
      calls.push(`stop ${name}`);
      const c = containers.get(name);
      if (c) c.running = false;
    },
    restart: async (name: string) => {
      calls.push(`restart ${name}`);
      const c = containers.get(name);
      if (c) Object.assign(c, { running: true, startedAt: new Date(Date.now() + 60_000).toISOString() });
    },
    remove: async (name: string) => {
      calls.push(`remove ${name}`);
      containers.delete(name);
    },
    wipeProfile: async (name: string) => {
      const ws = workspaces.get(name);
      if (!ws?.running) return false;
      state.wiped.push(name);
      return true;
    },
    exec: async (_name: string, cmd: string[]) => {
      if (cmd[0] !== 'cpb-ctl') return { code: 1, stdout: '', stderr: 'unexpected command' };
      state.ctl.push({ cmd: cmd[1]!, args: cmd.slice(2) });
      if (cmd[1] === 'status') return { code: 0, stdout: `${JSON.stringify({ ok: true, result: state.supervisor })}\n`, stderr: '' };
      return { code: 0, stdout: `${JSON.stringify({ ok: true, result: state.supervisor })}\n`, stderr: '' };
    },
    stream: async (_name: string, cmd: string[]) => {
      const helper = fakeHelper(cmd);
      state.helpers.push(helper);
      return helper.stream;
    },
    watch: () => () => undefined,
  };
  return {
    comps: comps as unknown as Companions,
    workspaces,
    containers,
    calls,
    state,
    /** A running workspace (its container ID is what a browser container joins). */
    addWorkspace: (name: string, running = true) => workspaces.set(name, { id: `ws-${name}-${++seq}`, running, startedAt: new Date(Date.now() - 120_000).toISOString() }),
    /** `docker restart` of the workspace: a new start time (and the same container ID). */
    restartWorkspace: (name: string) => {
      const w = workspaces.get(name)!;
      w.startedAt = new Date(Date.now() + 5000).toISOString();
      w.running = true;
    },
    /** `docker rm` + create: a new container ID. */
    recreateWorkspace: (name: string) => workspaces.set(name, { id: `ws-${name}-${++seq}`, running: true, startedAt: new Date().toISOString() }),
  };
}

export type FakeTarget = ReturnType<typeof fakeTarget>;

/** A step queue that records instead of running. */
export function fakeSteps() {
  const queued: { workspaceId: string; step: WorkspaceStep }[] = [];
  const steps = { enqueue: (workspaceId: string, list: WorkspaceStep[]) => list.forEach((step) => queued.push({ workspaceId, step })) } as unknown as WorkspaceSteps;
  return { steps, queued };
}

/** `kube`: Kubernetes targets (KubeBrowsers on a fake API server), beside the fake Docker ones. */
export async function browserHarness(opts: { targets?: string[]; kube?: Map<string, KubeBrowsers> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-browser-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const providers: FragmentProvider[] = [];
  const pools = new PoolService(store, { providers });
  const requests: string[] = [];
  pools.reconciler = { request: (id: string) => (requests.push(id), Promise.resolve()) };
  const targets = new Map<string, FakeTarget>();
  for (const id of opts.targets ?? ['docker']) targets.set(id, fakeTarget(id, store.portalId!));
  const kube = opts.kube ?? new Map<string, KubeBrowsers>();
  const kind = new BrowserKind({
    supports: (t) => targets.has(t) || kube.has(t),
    refuseAssign: (workspaceId) => (kube.has(splitWorkspaceId(workspaceId).target) ? kubeCapRefusal(store, workspaceId) : null),
  });
  pools.register(kind);
  const { steps, queued } = fakeSteps();
  const notified: number[] = [];
  const service = new BrowserService({
    store,
    pools,
    kind,
    steps,
    companions: new Map([...targets].map(([id, t]) => [id, t.comps])),
    kube,
    internalUrl: 'http://claudepilot-portal.portal-ns.svc.cluster.local:3000',
    portalPort: 3104,
    notify: () => notified.push(Date.now()),
  });
  const create = (name = 'dev', content: Partial<BrowserPoolContent> = {}) => pools.create('browser', { name, content: { ...BROWSER_POOL_DEFAULTS, ...content } });
  /** What the reconciler does after a write: asks the kind's provider for fragments, then reports the delivery. */
  const deliver = (workspaceId: string, running = true) => {
    const provider = providers.find((p) => p.type === 'browser')!;
    provider.fragments(workspaceId, { running, now: new Date() });
    provider.delivered?.(workspaceId, { running, now: new Date(), delivered: new Set(), pluginFolders: new Map() });
  };
  const done = () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, pools, kind, service, targets, target: targets.get('docker')!, queued, requests, notified, providers, create, deliver, done, splitWorkspaceId };
}
