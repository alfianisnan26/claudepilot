// A harness for the version module's tests: a real store in a temporary folder, an in-memory workspace manager and runtime (images, recreate, a throwaway
// container), a fake reconciler and chat, and a canary runner that returns what the test says. Nothing here talks to Docker or the network.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeImageRef, claudeVersionOfImageRef, CLAUDE_CANARY_CHECKS, CLAUDE_SETTING_KEYS, type ChatSession, type ClaudeCanaryResult, type SettingValue, type Workspace } from '@portal/contracts';
import { AppError } from '@isnanme/core';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { ImageInfo, Runtime } from '../workspaces/runtime.js';
import type { CanaryOutcome, CanaryTarget } from './canary/runner.js';
import { ClaudeVersions, type ClaudeVersionsDeps } from './service.js';

export const REPO = 'claudepilot-workspace-t';
export const ref = (v: string) => claudeImageRef(v, REPO);

export interface FakeWorkspace {
  id: string;
  name: string;
  /** What its container runs: a tag, the image id behind it, the version label. */
  image: { ref: string; id: string; version: string | null };
  status: 'running' | 'stopped';
  /** What `claude --version` prints in it. */
  running: string | null;
  doctor: string;
}

export interface Harness {
  svc: ClaudeVersions;
  store: Store;
  workspaces: FakeWorkspace[];
  images: Map<string, ImageInfo>;
  recreated: { name: string; image: string }[];
  built: string[];
  started: { image: string; network: string }[];
  removedContainers: string[];
  /** The service's clock: tests move it instead of waiting. */
  clock: { t: number };
  /** Tests set these to steer the fakes. */
  control: {
    recreateFails: string | null;
    ensureFails: string | null;
    sessions: ChatSession[];
    terminals: number;
    candidateBody: string | null;
    candidateStatus: number;
    candidateOffline: boolean;
    canary: (t: CanaryTarget) => CanaryOutcome | Promise<CanaryOutcome>;
    days: number;
  };
  audit: { kind: string; actor: string; userId?: string | null; subject?: string | null; severity?: string; detail?: Record<string, unknown> }[];
  settingListeners: ((key: string, value: SettingValue, old: SettingValue) => void)[];
  runs: CanaryTarget[];
  cleanup(): void;
}

export const result = (id: string, status: ClaudeCanaryResult['status'] = 'pass'): ClaudeCanaryResult => ({ id, status, durationMs: 3, summary: `${id} ${status}`, detail: `output of ${id}` });
export const allPass = (): ClaudeCanaryResult[] => CLAUDE_CANARY_CHECKS.map((d) => result(d.id));

/** A canary outcome in which each check passes, except the ones named. */
export const outcome = (version: string, failing: string[] = [], skipped: string[] = []): CanaryOutcome => ({
  status: 'done',
  note: null,
  reported: version,
  results: CLAUDE_CANARY_CHECKS.map((d) => result(d.id, failing.includes(d.id) ? 'fail' : skipped.includes(d.id) ? 'skipped' : 'pass')),
});

export async function harness(o: { installed?: string[]; workspaces?: Partial<FakeWorkspace>[]; imageFixed?: boolean; settleMs?: number } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'cp-cv-svc-'));
  const store = await Store.open({ dataDir: dir, secretKey: parseSecretKey(generateSecretKey()) });
  const images = new Map<string, ImageInfo>();
  let n = 0;
  const addImage = (v: string) => {
    const r = ref(v);
    images.set(r, { ref: r, id: `sha256:image-${v}-${++n}`, version: v, builtAt: '2026-10-12T00:00:00.000Z', sizeBytes: 1000 });
    return images.get(r)!;
  };
  for (const v of o.installed ?? ['2.1.296']) addImage(v);

  const workspaces: FakeWorkspace[] = (o.workspaces ?? [{ name: 'api' }]).map((w) => {
    const img = images.get(ref('2.1.296')) ?? addImage('2.1.296');
    return { id: `docker/${w.name}`, name: w.name!, image: { ref: img.ref, id: img.id, version: '2.1.296' }, status: 'running', running: '2.1.296', doctor: 'Auto-updates: disabled (set by env: DISABLE_UPDATES)', ...w } as FakeWorkspace;
  });
  const control: Harness['control'] = { recreateFails: null, ensureFails: null, sessions: [], terminals: 0, candidateBody: JSON.stringify({ stable: '2.1.287', latest: '2.1.296' }), candidateStatus: 200, candidateOffline: false, canary: (t) => outcome(t.version), days: 7 };
  const built: string[] = [];
  const recreated: Harness['recreated'] = [];
  const started: Harness['started'] = [];
  const removedContainers: string[] = [];
  const audit: Harness['audit'] = [];
  const settingListeners: Harness['settingListeners'] = [];
  const runs: CanaryTarget[] = [];
  const clock = { t: Date.parse('2026-10-12T06:00:00.000Z') };

  const runtime: Runtime = {
    target: { id: 'docker', label: 'Docker', kind: 'docker', where: '/fake.sock' },
    check: async () => undefined,
    list: async () => [],
    create: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    remove: async () => undefined,
    usage: async () => [],
    shell: async () => { throw new Error('no shell'); },
    exec: async () => { throw new Error('no exec'); },
    delivery: {
      state: async () => ({ exists: true, running: true }),
      run: async (name, script) => {
        const w = workspaces.find((x) => x.name === name);
        if (!w) throw new AppError('NOT_FOUND', 'no such workspace');
        if (/claude --version/.test(script)) return { code: 0, stdout: w.running ? `${w.running} (Claude Code)\n` : '', stderr: '' };
        if (/claude doctor/.test(script)) return { code: 0, stdout: `${w.doctor}\n`, stderr: '' };
        if (/tmux list-sessions/.test(script)) return { code: 0, stdout: `${control.terminals}\n`, stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      put: async () => undefined,
      read: async () => null,
      watchStarts: () => () => undefined,
    },
    images: {
      defaultRef: ref('2.1.296'),
      refFor: (v) => ref(v),
      inspect: async (r) => images.get(r) ?? [...images.values()].find((i) => i.id === r) ?? null,
      ensure: async (v, progress) => {
        progress(`building ${v}`);
        if (control.ensureFails) throw new Error(control.ensureFails);
        built.push(v);
        return images.get(ref(v))?.ref ?? addImage(v).ref;
      },
      list: async () => [...images.values()],
      remove: async (r) => {
        if (workspaces.some((w) => w.image.ref === r)) throw new AppError('CONFLICT', `${r} is in use by a container.`);
        images.delete(r);
      },
    },
    imageOf: async (name) => {
      const w = workspaces.find((x) => x.name === name);
      return w ? { ref: w.image.ref, version: w.image.version, id: w.image.id } : null;
    },
    recreate: async () => ({ from: null, to: '' }),
    throwaway: {
      start: async (spec) => (started.push({ image: spec.image, network: spec.network }), { name: 'vc-canary-fake' }),
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      put: async () => undefined,
      read: async () => null,
      exec: async () => { throw new Error('no exec'); },
      shell: async () => { throw new Error('no shell'); },
      isolate: async () => undefined,
      remove: async (name) => void removedContainers.push(name),
      leftovers: async () => [],
    },
  };

  const asWorkspace = (w: FakeWorkspace): Workspace => ({ id: w.id, name: w.name, target: 'docker', image: w.image.ref, status: w.status, createdAt: '2026-10-12T00:00:00.000Z', claude: { pinned: w.image.version, running: null, flags: [] } });

  const deps: ClaudeVersionsDeps = {
    store,
    workspaces: {
      list: async () => workspaces.map(asWorkspace),
      runtimeFor: (t) => (t === 'docker' ? runtime : undefined),
      runtimeList: () => [runtime],
      recreate: async (_t, name, image, progress, opts) => {
        const w = workspaces.find((x) => x.name === name)!;
        progress('Stopping');
        recreated.push({ name, image });
        if (control.recreateFails) throw new AppError('SERVICE_UNAVAILABLE', control.recreateFails);
        const from = w.image.ref;
        const img = [...images.values()].find((i) => i.ref === image || i.id === image)!;
        w.image = { ref: opts?.label ?? (image.startsWith('sha256:') ? img.ref : image), id: img.id, version: img.version };
        w.running = img.version;
        return { from, to: image };
      },
    },
    reconciler: { row: () => null, request: async () => undefined },
    chat: { list: (f) => control.sessions.filter((s) => !f.workspaceId || s.workspaceId === f.workspaceId) },
    settings: {
      get: ((key: string) => (key === CLAUDE_SETTING_KEYS.canaryDays ? control.days : undefined)) as never,
      onChange: (fn) => (settingListeners.push(fn), () => void settingListeners.splice(settingListeners.indexOf(fn), 1)),
    },
    audit: (e) => void audit.push(e),
    fetch: (async () => {
      if (control.candidateOffline) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      return new Response(control.candidateBody ?? '', { status: control.candidateStatus });
    }) as unknown as typeof fetch,
    runner: async (_t, target, hooks) => {
      runs.push(target);
      hooks.note('Running: fake');
      const out = await control.canary(target);
      hooks.results(out.results, out.reported);
      return out;
    },
    now: () => new Date(clock.t),
    imageFixed: o.imageFixed,
    settleMs: o.settleMs ?? 1,
    scheduleDelayMs: 60_000,
  };
  const svc = new ClaudeVersions(deps);
  void claudeVersionOfImageRef;
  return { svc, store, workspaces, images, recreated, built, started, removedContainers, clock, control, audit, settingListeners, runs, cleanup: () => (svc.stop(), rmSync(dir, { recursive: true, force: true })) };
}

/** Waits until a condition holds (a background operation finishing). */
export async function until(ok: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}
