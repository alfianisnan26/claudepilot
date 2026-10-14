// The attention registry (docs/prd/attention.md, T-146): what waits for a person, from every module that owns such a thing, in one list.
//
// READ ONLY. A source reads its module's own state (one query) and keeps what the actor may decide, through the module's own `can()`; a
// denial is the same absence as everywhere (no count, no row). Deciding is never here: an item names the module's own route (`action`) and
// the page links to the exact item, so every approval keeps its own checks. No secret, no secret slot value: names and facts only.
//
// Changes: a module that changes calls `changed()` (index.ts chains it onto the hooks that already tell their own pages, and a minute's
// tick catches what turns waiting by the clock, a tool approval past ten minutes). The registry reads every source as the system, compares
// with what it read before, and on a difference emits ONE `attention.changed` event (what appeared, what was resolved) and tells open pages
// through the live topic `attention`.

import {
  ATTENTION_KINDS,
  ATTENTION_PAGE_DEFAULT,
  ATTENTION_PAGE_MAX,
  ATTENTION_SNOOZE_DEFAULT_MIN,
  ATTENTION_SNOOZE_MAX_MIN,
  ATTENTION_WHY,
  actorUserId,
  attentionItemKey,
  type Actor,
  type AttentionItem,
  type AttentionKind,
  type AttentionList,
  type AttentionScope,
  type Verb,
} from '@portal/contracts';
import { AppError } from '@isnanme/core';
import { systemActor } from '../authz/seam.js';
import type { AttentionSnoozes } from './snooze.js';

export interface AttentionSource {
  kind: AttentionKind;
  /**
   * Everything of this kind that waits for a person and that `actor` may decide (the module's own `can()`), or with scope `see` may view
   * (`verbFor`, `readsPersonOnly`); absent is `decide`. One read of the module's state, no N+1.
   */
  list(actor: Actor, now: number, scope?: AttentionScope): AttentionItem[];
}

/** One item, as an event names it: never its text. */
export interface AttentionRef {
  kind: AttentionKind;
  id: string;
}

/** The registry's event (the bus of the Needs you page; slice 2 bridges it to notifications). */
export interface AttentionChanged {
  type: 'attention.changed';
  added: AttentionRef[];
  resolved: AttentionRef[];
  /** Everything waiting now, for the system (every person's view is a part of it). */
  total: number;
  at: string;
}

export interface AttentionOptions {
  now?: () => number;
  /** Tells open pages to load the list again (the `attention` live topic). */
  publish?: () => void;
  /** How long a burst of changes is gathered into one read (tests shorten it). */
  debounceMs?: number;
  /** The clock's tick, for what turns waiting with time. 0: none (tests). */
  tickMs?: number;
  log?: (what: string, e: unknown) => void;
  /** A person's Later (migration 860); without it nothing is ever snoozed. */
  snoozes?: AttentionSnoozes;
}

const WHY_RANK = new Map(ATTENTION_WHY.map((w, i) => [w, i]));

/** Grouped by why (the class order), then the oldest first: what has waited longest leads its group. */
export const attentionOrder = (a: AttentionItem, b: AttentionItem): number =>
  (WHY_RANK.get(a.why) ?? 99) - (WHY_RANK.get(b.why) ?? 99) || a.since.localeCompare(b.since) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);

const refKey = (r: AttentionRef) => `${r.kind}\u0000${r.id}`;

export class AttentionRegistry {
  readonly #sources = new Map<AttentionKind, AttentionSource>();
  readonly #listeners = new Set<(e: AttentionChanged) => void>();
  readonly #opts: AttentionOptions;
  /** What the last read found, for the system: null until the first read (the baseline, which emits nothing). */
  #known: Map<string, AttentionRef> | null = null;
  #timer: NodeJS.Timeout | undefined;
  #tick: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(opts: AttentionOptions = {}) {
    this.#opts = opts;
  }

  register(source: AttentionSource): void {
    if (this.#sources.has(source.kind)) throw new Error(`attention source ${source.kind} is registered twice`);
    this.#sources.set(source.kind, source);
  }

  kinds(): AttentionKind[] {
    return ATTENTION_KINDS.filter((k) => this.#sources.has(k));
  }

  #now(): number {
    return (this.#opts.now ?? Date.now)();
  }

  /** Every source read once for `actor`: the items, and the kinds that could not be read. */
  #read(actor: Actor, scope: AttentionScope = 'decide'): { items: AttentionItem[]; counts: AttentionList['counts']; unavailable: AttentionKind[] } {
    const now = this.#now();
    const items: AttentionItem[] = [];
    const counts = Object.fromEntries(ATTENTION_KINDS.map((k) => [k, this.#sources.has(k) ? 0 : null])) as AttentionList['counts'];
    const unavailable: AttentionKind[] = [];
    for (const source of this.#sources.values()) {
      try {
        const found = source.list(actor, now, scope).filter((i) => i.kind === source.kind);
        counts[source.kind] = found.length;
        items.push(...found);
      } catch (e) {
        counts[source.kind] = null;
        unavailable.push(source.kind);
        this.#opts.log?.(source.kind, e);
      }
    }
    return { items, counts, unavailable };
  }

  /** `GET /api/attention`: the counts of every kind and one page of the items, grouped by why and then by age. */
  list(actor: Actor, q: { kind?: AttentionKind | null; limit?: number; offset?: number; scope?: AttentionScope } = {}): AttentionList {
    const { items, counts, unavailable } = this.#read(actor, q.scope);
    const limit = Math.min(Math.max(Math.trunc(Number.isFinite(q.limit) ? q.limit! : ATTENTION_PAGE_DEFAULT), 0), ATTENTION_PAGE_MAX);
    const offset = Math.max(Math.trunc(Number.isFinite(q.offset) ? q.offset! : 0), 0);
    const chosen = (q.kind ? items.filter((i) => i.kind === q.kind) : items).sort(attentionOrder);
    // Later is the person's own: their snoozes mark their items (still listed, still counted); a token's or the system's read has none.
    const userId = actor.kind === 'user' ? actorUserId(actor) : null;
    const later = userId && limit > 0 ? this.#snoozes(userId) : null;
    if (later?.size) for (const [n, i] of chosen.entries()) if (later.has(attentionItemKey(i))) chosen[n] = { ...i, snoozedUntil: later.get(attentionItemKey(i))! };
    const total = Object.values(counts).reduce<number>((n, c) => n + (c ?? 0), 0);
    return { total, counts, unavailable, items: chosen.slice(offset, offset + limit), offset, limit, at: new Date(this.#now()).toISOString() };
  }

  #snoozes(userId: string): Map<string, string> | null {
    try {
      return this.#opts.snoozes?.active(userId, this.#now()) ?? null;
    } catch (e) {
      this.#opts.log?.('the snoozes', e);
      return null;
    }
  }

  /**
   * Later: the person puts one item off for `minutes` (default an hour, at most a day; 0 brings it back now). Only an item the person
   * sees now can be snoozed: anything else is the same NOT_FOUND as an item that does not exist. Returns the item as the list shows it.
   */
  snooze(actor: Actor, kind: AttentionKind, id: string, minutes = ATTENTION_SNOOZE_DEFAULT_MIN): AttentionItem {
    const userId = actor.kind === 'user' ? actorUserId(actor) : null;
    if (!userId || !this.#opts.snoozes) throw new AppError('NOT_FOUND', 'Nothing like that waits for you.');
    const item = this.list(actor, { kind, limit: ATTENTION_PAGE_MAX }).items.find((i) => i.id === id);
    if (!item) throw new AppError('NOT_FOUND', 'Nothing like that waits for you.');
    const m = Math.min(Math.max(Math.trunc(Number.isFinite(minutes) ? minutes : ATTENTION_SNOOZE_DEFAULT_MIN), 0), ATTENTION_SNOOZE_MAX_MIN);
    const now = this.#now();
    const until = m > 0 ? new Date(now + m * 60_000).toISOString() : null;
    this.#opts.snoozes.set(userId, kind, id, until, now);
    this.#opts.publish?.();
    const { snoozedUntil: _was, ...rest } = item;
    return until ? { ...rest, snoozedUntil: until } : rest;
  }

  /** The badge: how many things wait on `actor`. */
  count(actor: Actor): number {
    return this.list(actor, { limit: 0 }).total;
  }

  /** The event: one per change that something appeared or was resolved. Returns the unsubscribe. */
  onChange(fn: (e: AttentionChanged) => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  /** A source's module changed. Cheap: the read is debounced. */
  changed(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.check();
    }, this.#opts.debounceMs ?? 300);
    this.#timer.unref();
  }

  /** Reads every source (as the system) and emits what appeared or was resolved since the last read. The first read is the baseline. */
  check(): AttentionChanged | null {
    const { items } = this.#read(systemActor('attention'));
    const now = new Map(items.map((i) => [refKey(i), { kind: i.kind, id: i.id }] as const));
    const before = this.#known;
    this.#known = now;
    if (!before) return null;
    const added = [...now].filter(([k]) => !before.has(k)).map(([, r]) => r);
    const resolved = [...before].filter(([k]) => !now.has(k)).map(([, r]) => r);
    if (added.length === 0 && resolved.length === 0) return null;
    const e: AttentionChanged = { type: 'attention.changed', added, resolved, total: now.size, at: new Date(this.#now()).toISOString() };
    for (const fn of [...this.#listeners]) {
      try {
        fn(e);
      } catch (err) {
        this.#opts.log?.('a listener', err);
      }
    }
    this.#opts.publish?.();
    return e;
  }

  start(): void {
    this.#stopped = false;
    this.check();
    const every = this.#opts.tickMs ?? 60_000;
    if (every > 0 && !this.#tick) {
      this.#tick = setInterval(() => this.check(), every);
      this.#tick.unref();
    }
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    clearInterval(this.#tick);
    this.#timer = undefined;
    this.#tick = undefined;
  }
}

/* ---------- What sources share ---------- */

/** One line of untrusted or long text: whitespace folded, cut with an ellipsis. */
export const clip = (text: string | null | undefined, max = 120): string => {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Who an actor string (`session:<id>`, `portal-mcp:<token>`, `ticket:T-1`, `ui`) is, with the session's title when the query found it. */
export function whoOf(actor: string | null | undefined, sessionTitle?: string | null): AttentionWhoLike | null {
  const a = (actor ?? '').trim();
  if (!a) return null;
  if (a.startsWith('session:')) {
    const id = a.slice('session:'.length);
    return { label: clip(sessionTitle, 60) || `Session ${id.slice(0, 8)}`, link: `/admin/sessions/${encodeURIComponent(id)}` };
  }
  if (a.startsWith('ticket:')) {
    const id = a.slice('ticket:'.length);
    return { label: id, link: `/admin/tickets/${encodeURIComponent(id)}` };
  }
  if (a.startsWith('portal-mcp:')) return { label: 'Portal MCP token', link: null };
  if (a === 'ui' || a.startsWith('user:') || a.startsWith('u_')) return { label: 'You', link: null };
  return { label: clip(a, 40), link: null };
}
type AttentionWhoLike = AttentionItem['who'][number];

export const sessionWho = (id: string | null | undefined, title?: string | null): AttentionWhoLike | null => (id ? whoOf(`session:${id}`, title) : null);
export const ticketWho = (id: string | null | undefined): AttentionWhoLike | null => (id ? { label: id, link: `/admin/tickets/${encodeURIComponent(id)}` } : null);
/** Approving is a person's act (the approve routes refuse tokens and agents): a source of such items lists them for a person, or the system's read. */
export const isPerson = (actor: Actor): boolean => actor.kind === 'user' || actor.kind === 'system';
/** The verb a source checks: what its module's decide route needs, or `view` for the `see` scope (what the module's read tools show anyway). */
export const verbFor = (scope: AttentionScope | undefined, decide: Verb): Verb => (scope === 'see' ? 'view' : decide);
/** A person-only item (a deploy, an approval ticket): listed to decide for a person only; to see, for anyone with view on it. */
export const readsPersonOnly = (actor: Actor, scope: AttentionScope | undefined): boolean => scope === 'see' || isPerson(actor);
export const present = <T>(xs: (T | null | undefined)[]): T[] => xs.filter((x): x is T => x !== null && x !== undefined);
