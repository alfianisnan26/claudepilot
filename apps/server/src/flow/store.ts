// The flow watchdog's state (T-1966): one JSON value in `portal_meta` (no migration), so a portal restart keeps the rate limits, the round
// robin, the stalls and the last actions. Read once, written after each round. Nothing in it is message text: ids, counts, fixed sentences.

import { FLOW_LIMITS, type FlowAction, type FlowProgramView } from '@portal/contracts';
import type { Store } from '../store/store.js';

export interface FlowStall {
  /** When the program was first seen stalled (ms). */
  since: number;
  /** The first message the watchdog sent for the program during this stall (ms), or null. */
  nudgedAt: number | null;
  /** When the owner was told about this stall (ms), or null. */
  notifiedAt: number | null;
}

export interface FlowState {
  lastRunAt: string | null;
  /** Rate limit: `<condition>:<lead id>` (or `<condition>:<program>`) to when it last acted (ms). */
  sent: Record<string, number>;
  /** The QA-ASK round robin, per program. */
  rr: Record<string, number>;
  stall: Record<string, FlowStall>;
  /** Newest first, at most FLOW_LIMITS.kept. */
  actions: FlowAction[];
  view: FlowProgramView[];
}

export const emptyFlowState = (): FlowState => ({ lastRunAt: null, sent: {}, rr: {}, stall: {}, actions: [], view: [] });

export interface FlowStatePort {
  readonly writable: boolean;
  load(): FlowState;
  save(s: FlowState): void;
}

const META_KEY = 'flow:state';
const DAY = 86_400_000;

/** Drops what is too old to matter (rate entries over a day) and caps the trail. */
export function trimState(s: FlowState, now: number): FlowState {
  const sent: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.sent)) if (typeof v === 'number' && now - v < DAY) sent[k] = v;
  return { ...s, sent, actions: s.actions.slice(0, FLOW_LIMITS.kept) };
}

function parse(raw: string | undefined): FlowState {
  const st = emptyFlowState();
  if (!raw) return st;
  try {
    const p = JSON.parse(raw) as Partial<FlowState>;
    if (typeof p.lastRunAt === 'string') st.lastRunAt = p.lastRunAt;
    if (p.sent && typeof p.sent === 'object') for (const [k, v] of Object.entries(p.sent)) if (typeof v === 'number') st.sent[k] = v;
    if (p.rr && typeof p.rr === 'object') for (const [k, v] of Object.entries(p.rr)) if (typeof v === 'number') st.rr[k] = v;
    if (p.stall && typeof p.stall === 'object')
      for (const [k, v] of Object.entries(p.stall))
        if (v && typeof v.since === 'number')
          st.stall[k] = { since: v.since, nudgedAt: typeof v.nudgedAt === 'number' ? v.nudgedAt : null, notifiedAt: typeof v.notifiedAt === 'number' ? v.notifiedAt : null };
    if (Array.isArray(p.actions)) st.actions = p.actions.slice(0, FLOW_LIMITS.kept);
    if (Array.isArray(p.view)) st.view = p.view;
  } catch {
    // unreadable: start afresh (the rate limits start again; a lead may hear once more)
  }
  return st;
}

/** The real one, over the portal's SQLite. Read-only (frozen, locked): nothing is written and the watchdog does not act. */
export class MetaFlowStore implements FlowStatePort {
  #cache: FlowState | null = null;
  constructor(private readonly store: Store) {}

  get writable(): boolean {
    return !!this.store.writable;
  }

  load(): FlowState {
    if (this.#cache) return this.#cache;
    let raw: string | undefined;
    try {
      raw = (this.store.db?.prepare('SELECT value FROM portal_meta WHERE key = ?').get(META_KEY) as { value: string } | undefined)?.value;
    } catch {
      raw = undefined;
    }
    return (this.#cache = parse(raw));
  }

  save(s: FlowState): void {
    this.#cache = s;
    if (!this.store.writable) return;
    try {
      this.store.db
        .prepare('INSERT INTO portal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(META_KEY, JSON.stringify(s));
    } catch (e) {
      console.error(`[flow] saving the watchdog's state failed: ${(e as Error).message}`);
    }
  }
}

/** For tests: in memory, through JSON (what the real one keeps). */
export class MemoryFlowStore implements FlowStatePort {
  writable = true;
  #raw: string | undefined;
  load(): FlowState {
    return parse(this.#raw);
  }
  save(s: FlowState): void {
    this.#raw = JSON.stringify(s);
  }
}
