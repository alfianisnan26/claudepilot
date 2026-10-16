// The memory budget of a workspace (T-416, D-61; chat-sessions PRD FR39a). The shared workspace pod (8 GiB) was OOMKilled on 2026-10-15
// at 02:11 UTC and every Claude process in it died. Before the portal starts or wakes a session it reads the workspace's memory (anon +
// active_file against memory.max, workspaces/memory.ts) and refuses, with a reason a person or an agent can read, when
//   used + the session's estimate (+ one more per Agent-tool sub-agent it runs, + one per launch not running yet) + 1.5 GiB > the limit.
// An unavailable reading does not block (logged once per workspace); the live cap (caps.ts) stays the ceiling either way.
//
// The alert: on the liveness round (once a minute), a workspace whose used memory passed 85 percent of its limit is a Needs you item (and
// so a notification, attention/notify.ts) with its five largest processes by RSS, by name only. It clears below 80 percent; the next
// crossing is a new item (a new notification).

import { createHash } from 'node:crypto';
import { CHAT_API, workspaceRef, type AttentionItem } from '@portal/contracts';
import { AppError, defineErrorCodes } from '@isnanme/core';
import { can } from '../authz/seam.js';
import { readsPersonOnly, verbFor, type AttentionSource } from '../attention/registry.js';
import type { MemoryReading } from '../workspaces/memory.js';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** One Claude Code process (measured about 310 MB on 2026-10-15; D-61), rounded up. Each Agent-tool sub-agent counts one more. */
export const SESSION_MEMORY_ESTIMATE_BYTES = 350 * MiB;
/** What is always left free: a spike of an npm or a git, the page cache the kernel needs to run. */
export const MEMORY_HEADROOM_BYTES = 1.5 * GiB;
/** The alert: above this share of memory.max; it clears below MEMORY_CLEAR_RATIO (so a reading near the line does not flap). */
export const MEMORY_ALERT_RATIO = 0.85;
export const MEMORY_CLEAR_RATIO = 0.8;
/** A workspace is read at most this often by the liveness round; a start or wake takes a reading at most this old. */
export const MEMORY_LOOK_MS = 60_000;
export const MEMORY_FRESH_MS = 5_000;
/**
 * A launch that ran holds its reservation until a reading taken at least this long after it settled (T-416 review): a cached reading
 * from before cannot see the process, and a new Claude is far below its steady size in its first seconds.
 */
export const MEMORY_SETTLE_MS = 10_000;

export const MEMORY_BUDGET = 'MEMORY_BUDGET';
declare module '@isnanme/core' {
  interface ErrorCodeRegistry {
    MEMORY_BUDGET: true;
  }
}
defineErrorCodes({ [MEMORY_BUDGET]: { status: 409, message: 'The workspace does not have the memory for one more session.' } });

/** A session's estimate: one process, and one more for each Agent-tool sub-agent it runs (they run inside its process). */
export const sessionEstimate = (agentsRunning: number): number => SESSION_MEMORY_ESTIMATE_BYTES * (1 + Math.max(0, Math.trunc(agentsRunning) || 0));

export interface BudgetRefusal {
  usedBytes: number;
  limitBytes: number;
  needBytes: number;
  headroomBytes: number;
}

/** Null when `needBytes` more fits with the headroom kept; else the numbers of the refusal. */
export function budgetVerdict(reading: MemoryReading, needBytes: number): BudgetRefusal | null {
  if (reading.usedBytes + needBytes + MEMORY_HEADROOM_BYTES <= reading.limitBytes) return null;
  return { usedBytes: reading.usedBytes, limitBytes: reading.limitBytes, needBytes, headroomBytes: MEMORY_HEADROOM_BYTES };
}

const gib = (b: number): string => (b / GiB).toFixed(1);
const mb = (b: number): string => `${Math.round(b / MiB)} MB`;

export function memoryBudgetError(workspaceId: string, r: BudgetRefusal): AppError {
  return new AppError(
    MEMORY_BUDGET,
    `Not enough memory in ${workspaceId}: ${gib(r.usedBytes)} of ${gib(r.limitBytes)} GiB in use, and this session needs about ${mb(r.needBytes)} with ${gib(r.headroomBytes)} GiB kept free. End or sleep a session there, or wait for one to finish.`,
    { status: 409, details: { workspaceId, usedBytes: r.usedBytes, limitBytes: r.limitBytes, needBytes: r.needBytes, headroomBytes: r.headroomBytes } },
  );
}

export interface MemoryAlert {
  workspaceId: string;
  /** When the reading first passed the line (ISO): with the workspace, the item's id, so each crossing is told once. */
  since: string;
  reading: MemoryReading;
}

export interface WorkspaceMemoryOptions {
  /** The reading through the runtime (index.ts: `readWorkspaceMemory` over the manager's exec); null when unavailable. */
  read: (workspaceId: string) => Promise<MemoryReading | null>;
  now?: () => number;
  log?: (line: string) => void;
  /** The alerts changed (index.ts: `attention.changed()`). */
  onChange?: () => void;
}

/** The readings of every workspace the portal looks at, their cache, and the alerts. */
export class WorkspaceMemory {
  readonly #o: WorkspaceMemoryOptions;
  readonly #last = new Map<string, { at: number; reading: MemoryReading | null }>();
  readonly #inFlight = new Map<string, Promise<MemoryReading | null>>();
  readonly #alerts = new Map<string, MemoryAlert>();
  /** The workspaces whose unavailable reading was logged (once, until it is available again). */
  readonly #unavailable = new Set<string>();

  constructor(o: WorkspaceMemoryOptions) {
    this.#o = o;
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /** The clock the readings' `at` is on (index.ts: both are `Date.now`), so a release time compares with a reading's. */
  now(): number {
    return this.#now();
  }

  /** A reading at most `maxAgeMs` old (one exec at a time per workspace); null when unavailable. Never throws. */
  async reading(workspaceId: string, maxAgeMs = MEMORY_FRESH_MS): Promise<MemoryReading | null> {
    const last = this.#last.get(workspaceId);
    if (last && this.#now() - last.at < maxAgeMs) return last.reading;
    const running = this.#inFlight.get(workspaceId);
    if (running) return running;
    const p = (async () => {
      let reading: MemoryReading | null = null;
      let why = 'no cgroup v2 memory files, or no limit';
      try {
        reading = await this.#o.read(workspaceId);
      } catch (e) {
        why = (e as Error).message || 'the exec failed';
      }
      this.#last.set(workspaceId, { at: this.#now(), reading });
      if (!reading && !this.#unavailable.has(workspaceId)) {
        this.#unavailable.add(workspaceId);
        this.#o.log?.(`[memory] ${workspaceId}: the memory reading is unavailable (${why}); the memory budget does not block there, the live cap still does`);
      } else if (reading) this.#unavailable.delete(workspaceId);
      this.#alertFrom(workspaceId, reading);
      return reading;
    })().finally(() => this.#inFlight.delete(workspaceId));
    this.#inFlight.set(workspaceId, p);
    return p;
  }

  /** The liveness round: each workspace read at most once a minute; the alerts follow. */
  async look(workspaceIds: Iterable<string>): Promise<void> {
    const looked = new Set(workspaceIds);
    await Promise.allSettled([...looked].map((id) => this.reading(id, MEMORY_LOOK_MS)));
    // A workspace no session runs in any more keeps no alert (nothing reads it again).
    for (const id of [...this.#alerts.keys()]) if (!looked.has(id)) this.#setAlert(id, null);
  }

  alerts(): MemoryAlert[] {
    return [...this.#alerts.values()];
  }

  #alertFrom(workspaceId: string, reading: MemoryReading | null): void {
    const was = this.#alerts.get(workspaceId);
    if (!reading) return; // unavailable: what was known stands until a reading says otherwise
    const share = reading.usedBytes / reading.limitBytes;
    if (was) {
      if (share < MEMORY_CLEAR_RATIO) this.#setAlert(workspaceId, null);
      else this.#alerts.set(workspaceId, { ...was, reading }); // the same item, its numbers fresh
    } else if (share >= MEMORY_ALERT_RATIO) this.#setAlert(workspaceId, { workspaceId, since: new Date(reading.at).toISOString(), reading });
  }

  #setAlert(workspaceId: string, alert: MemoryAlert | null): void {
    if (alert) this.#alerts.set(workspaceId, alert);
    else if (!this.#alerts.delete(workspaceId)) return;
    try {
      this.#o.onChange?.();
    } catch {
      // the registry is gone (shutdown)
    }
  }
}

/** The workspace part kept whole in an item id (T-675); a longer id is clipped and hashed so two long ids never share an item. */
const ITEM_ID_WORKSPACE_MAX = 100;

/**
 * T-675: the Web Push subject is `attention:workspace_memory:<id>` and the notify bus drops a subject id over 200 characters, so an item
 * id with a long workspace id lost its push without a trace. A workspace id over 100 characters is clipped and given a hash of the whole.
 */
export function memoryItemId(workspaceId: string, since: string): string {
  const ws = workspaceId.length > ITEM_ID_WORKSPACE_MAX ? `${workspaceId.slice(0, ITEM_ID_WORKSPACE_MAX)}~${createHash('sha256').update(workspaceId).digest('hex').slice(0, 10)}` : workspaceId;
  return `${ws}@${since}`;
}

/** Needs you: a workspace near its memory limit. A person decides what to end or sleep; the item opens the sessions. */
export function memoryAttentionSource(memory: Pick<WorkspaceMemory, 'alerts'>): AttentionSource {
  return {
    kind: 'workspace_memory',
    list(actor, _now, scope) {
      if (!readsPersonOnly(actor, scope)) return [];
      return memory
        .alerts()
        .filter((a) => can(actor, verbFor(scope, 'operate'), workspaceRef(a.workspaceId)).allow)
        .map((a): AttentionItem => {
          const r = a.reading;
          const pct = Math.round((r.usedBytes / r.limitBytes) * 100);
          const top = r.top.map((p) => `${p.name} ${p.mb} MB`).join(', ');
          return {
            kind: 'workspace_memory',
            id: memoryItemId(a.workspaceId, a.since),
            title: `${a.workspaceId}: memory ${pct}%${top ? ` (${top})` : ''}`,
            who: [],
            why: 'question',
            risk: `${gib(r.usedBytes)} of ${gib(r.limitBytes)} GiB in use (anon + active file); at the limit every session in it stops`,
            since: a.since,
            link: '/admin/sessions',
            // The page and the deck only link (`link`); no route decides this item, a person ends or sleeps sessions on their own pages.
            action: { label: 'Sessions', method: 'POST', path: CHAT_API.list },
          };
        });
    },
  };
}
