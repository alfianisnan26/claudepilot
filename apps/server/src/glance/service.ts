// The glance aggregator (docs/prd/glance-widgets.md §4): one snapshot per person for every widget and every open page, and the live
// topic `glance` that says when to ask for it again. A source that changes calls `changed()`; a snapshot is built once however many
// tabs ask for it, and pages are told only when what one shows is different, so a busy session's stream of events costs nothing.

import type { Actor, GlanceSnapshot } from '@portal/contracts';
import { effectiveOrgScope, orgScopeFilter, orgScopeKey, type OrgScope } from '../authz/orgScope.js';
import { actorString, actorUserId } from '../authz/seam.js';
import { buildSnapshot, type GlanceSources } from './build.js';

/** A burst of events (a turn ending, a worker starting, ten tasks reporting) becomes one build. */
const DEBOUNCE_MS = 400;

export interface GlanceOptions {
  /** Tells open pages to load the snapshot again (the `glance` live topic). */
  notify: () => void;
  /** Whether some page watches the topic. While none does, a change only marks the snapshots old: the next request builds one. */
  watching?: () => boolean;
  now?: () => number;
  debounceMs?: number;
  log?: (what: string, e: unknown) => void;
  /**
   * 2026-11-02: a snapshot younger than this is answered again after a change (0: every change rebuilds, as before). A build reads every
   * session and asks can() of each; with the Konfersi crews something changes every second, and each change rebuilt every asker's
   * snapshot: 1-2 s of a blocked event loop every few seconds. A change still reaches the pages, at most this much later.
   */
  minRebuildMs?: number;
}

export class Glance {
  readonly #sources: GlanceSources;
  readonly #opts: GlanceOptions;
  /** The snapshot of each actor who has asked (by `actorKey`), until something changes. */
  readonly #cache = new Map<string, { snap: GlanceSnapshot; at: number }>();
  /** When a source last changed; a cached snapshot built before it is old (rebuilt once `minRebuildMs` allows). */
  #changedAt = -Infinity;
  /** Every actor (and the context they asked in) who has asked: whose snapshot a change has to compare before it pushes. */
  readonly #actors = new Map<string, { actor: Actor; scope: OrgScope | null }>();
  /** What the last push described, per actor, to push again only when something differs. */
  readonly #announced = new Map<string, string>();
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  readonly #undo: (() => void)[] = [];

  constructor(sources: GlanceSources, opts: GlanceOptions) {
    this.#sources = sources;
    this.#opts = opts;
  }

  /**
   * `actor`'s snapshot, built again if a source changed since it was. `scope` is the request's `?org=` (authz/orgScope.ts): Personal or one
   * org, kept apart in the cache; null is everything the actor may see (today's behaviour).
   */
  snapshot(actor: Actor, asked: OrgScope | null = null): GlanceSnapshot {
    // An org the asker is not in is one empty scope, so made-up ids do not grow the cache.
    const scope = effectiveOrgScope(actor, asked);
    const key = `${actorKey(actor)}|${orgScopeKey(scope)}`;
    this.#actors.set(key, { actor, scope });
    const hit = this.#cache.get(key);
    return hit && this.#usable(hit) ? hit.snap : this.#build(key, actor, scope);
  }

  /** A source changed (a session's state, a request, a task, a ticket, a CI run). Cheap: the work is debounced. */
  changed(): void {
    this.#changedAt = this.#clock();
    if (!this.#opts.minRebuildMs) this.#cache.clear();
    if (this.#timer || this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#push();
    }, this.#opts.debounceMs ?? DEBOUNCE_MS);
    this.#timer.unref();
  }

  /** Something to undo when it stops (an event subscription). */
  onStop(undo: () => void): void {
    this.#undo.push(undo);
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const undo of this.#undo.splice(0)) undo();
  }

  #clock(): number {
    return (this.#opts.now ?? Date.now)();
  }

  /** Built after the last change, or younger than `minRebuildMs`. */
  #usable(hit: { at: number }): boolean {
    return hit.at > this.#changedAt || this.#clock() - hit.at < (this.#opts.minRebuildMs ?? 0);
  }

  #build(key: string, actor: Actor, scope: OrgScope | null): GlanceSnapshot {
    const at = this.#clock();
    const snap = buildSnapshot(this.#sources, actor, at, this.#opts.log, orgScopeFilter(actor, scope));
    this.#cache.set(key, { snap, at });
    return snap;
  }

  #push(): void {
    if (this.#opts.watching && !this.#opts.watching()) return;
    // Every actor who has asked is compared with what was last said about them; one push tells the pages, and each page asks for its own.
    let different = false;
    let later = false;
    for (const [key, { actor, scope }] of this.#actors) {
      const hit = this.#cache.get(key);
      // Too young to rebuild yet, but older than the change: told on a later push, once it may be rebuilt.
      if (hit && hit.at <= this.#changedAt && this.#usable(hit)) later = true;
      const now = fingerprint(hit && this.#usable(hit) ? hit.snap : this.#build(key, actor, scope));
      if (now !== this.#announced.get(key)) {
        this.#announced.set(key, now);
        different = true;
      }
    }
    if (different) this.#opts.notify();
    if (later && !this.#timer && !this.#stopped) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#push();
      }, this.#opts.minRebuildMs ?? 0);
      this.#timer.unref();
    }
  }
}

/** Whose snapshot: the actor's string and the user whose rights apply (a job's string is only its name, so two users' jobs must not share one). */
const actorKey = (actor: Actor): string => `${actorString(actor)}|${actorUserId(actor) ?? '-'}`;

/** What a page would draw, without the time it was built at. */
export const fingerprint = (s: GlanceSnapshot): string => JSON.stringify({ ...s, at: '' });
