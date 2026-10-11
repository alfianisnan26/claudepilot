import { redact } from '../chat/redact.js';
import type { Store } from '../store/store.js';
import type { DeliveryAccess } from '../workspaces/runtime.js';
import type { Owner } from './types.js';

/**
 * The run-in-workspace step (MCP set A4, foundation §6.2, adopted by Skillset A7): commands a pool type
 * runs through `exec` as the workspace user, in the workspace container, after its files are written.
 * A kind enqueues them from its `delivered` hook, which runs after every successful reconcile, the
 * start reconcile included, so they run at once in a running workspace and after the next start in a
 * stopped one. They never run inside a reconcile: a five-minute install must not hold up delivery, a
 * revocation least of all.
 *
 * Each step has a timeout (enforced inside the workspace too, so nothing outlives it), output that is
 * redacted and capped before anyone sees it, and a result in `delivery_events`. One queue per
 * workspace, steps one at a time; a step queued again while it waits is dropped. Steps carry no secret
 * values: scripts are command lines, which `docker events` records (Secrets & env FR11).
 */

export interface StepResult {
  /** Exit code; null when the step didn't run (not running, Locked or Frozen, no access) or the exec failed. */
  code: number | null;
  /** stdout and stderr, redacted, each capped. */
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Why it didn't run, when it didn't. */
  skipped?: string;
  ms: number;
}

export interface WorkspaceStep {
  owner: Owner;
  /** Unique per workspace while queued: the same key queued again before it runs is dropped. */
  key: string;
  /** What the event log calls it ("verify", "install npm:…"). */
  label: string;
  /** `sh -c` script. The workspace user's by default (A4). */
  script: string;
  user?: 'node' | 'root';
  timeoutMs: number;
  /** The outcome, with output already redacted. Never throws into the queue. */
  done?: (result: StepResult) => void;
}

/** What a step's output may grow to before it's cut, kept from the end (errors come last). */
const OUTPUT_MAX = 16_384;
/** What the event log keeps of it. */
const EVENT_OUTPUT_MAX = 1_000;
/** Extra time for the exec itself beyond the step's own timeout. */
const EXEC_SLACK_MS = 15_000;

const tail = (s: string, max: number) => (s.length > max ? `…${s.slice(-(max - 1))}` : s);

export class WorkspaceSteps {
  readonly #queues = new Map<string, WorkspaceStep[]>();
  readonly #running = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly access: (target: string) => DeliveryAccess | undefined,
  ) {}

  /** Queues steps for a workspace; they start right away unless one is already running there. */
  enqueue(workspaceId: string, steps: WorkspaceStep[]) {
    const queue = this.#queues.get(workspaceId) ?? [];
    for (const s of steps) if (!queue.some((q) => q.owner === s.owner && q.key === s.key)) queue.push(s);
    this.#queues.set(workspaceId, queue);
    void this.#drain(workspaceId);
  }

  /** Steps waiting (not yet started) for a workspace, by key. */
  queued(workspaceId: string, owner: Owner): string[] {
    return (this.#queues.get(workspaceId) ?? []).filter((s) => s.owner === owner).map((s) => s.key);
  }

  /** Resolves once the workspace's queue is empty (tests, and callers that want to wait). */
  async idle(workspaceId: string): Promise<void> {
    while (this.#running.has(workspaceId) || (this.#queues.get(workspaceId)?.length ?? 0) > 0) await new Promise((r) => setTimeout(r, 20));
  }

  /** The workspace is gone: drop what waits for it. */
  forget(workspaceId: string) {
    this.#queues.delete(workspaceId);
  }

  async #drain(workspaceId: string) {
    if (this.#running.has(workspaceId)) return;
    this.#running.add(workspaceId);
    try {
      for (;;) {
        const step = this.#queues.get(workspaceId)?.shift();
        if (!step) break;
        const result = await this.#run(workspaceId, step);
        try {
          step.done?.(result);
        } catch (e) {
          console.error(`[steps] ${step.owner} ${step.label} on ${workspaceId}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.#running.delete(workspaceId);
      if (!this.#queues.get(workspaceId)?.length) this.#queues.delete(workspaceId);
    }
  }

  async #run(workspaceId: string, step: WorkspaceStep): Promise<StepResult> {
    const started = Date.now();
    const skip = (why: string): StepResult => ({ code: null, stdout: '', stderr: '', timedOut: false, skipped: why, ms: 0 });
    // Steps are part of delivery: a portal that doesn't trust its state runs none (foundation §6.5).
    if (this.store.trust.state !== 'ok' || !this.store.writable) return skip(`portal ${this.store.trust.state}`);
    const slash = workspaceId.indexOf('/');
    const access = this.access(workspaceId.slice(0, slash));
    const name = workspaceId.slice(slash + 1);
    if (!access) return skip('no delivery for this target');
    let result: StepResult;
    try {
      if (!(await access.state(name)).running) return skip('not running');
      // `timeout` inside the workspace too: an exec that times out on our side keeps running otherwise.
      const seconds = Math.max(1, Math.ceil(step.timeoutMs / 1000));
      const script = `exec timeout -k 5 ${seconds} sh -c ${shq(step.script)}`;
      const r = await access.run(name, script, { user: step.user ?? 'node', timeoutMs: step.timeoutMs + EXEC_SLACK_MS });
      result = {
        code: r.code,
        stdout: redact(tail(r.stdout, OUTPUT_MAX)),
        stderr: redact(tail(r.stderr, OUTPUT_MAX)),
        timedOut: r.code === 124 || r.code === 137,
        ms: Date.now() - started,
      };
    } catch (e) {
      result = { code: null, stdout: '', stderr: redact((e as Error).message), timedOut: /timed out/.test((e as Error).message), ms: Date.now() - started };
    }
    this.#event(workspaceId, step, result);
    return result;
  }

  #event(workspaceId: string, step: WorkspaceStep, r: StepResult) {
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    const output = tail(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim(), EVENT_OUTPUT_MAX);
    db.prepare('INSERT INTO delivery_events (at, workspace_id, kind, details) VALUES (?, ?, ?, ?)').run(
      new Date().toISOString(),
      workspaceId,
      'step',
      JSON.stringify({ owner: step.owner, step: step.label, code: r.code, ms: r.ms, ...(r.timedOut ? { timedOut: true } : {}), ...(output ? { output } : {}) }),
    );
  }
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
