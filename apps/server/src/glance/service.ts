// The glance aggregator (docs/prd/glance-widgets.md §4): one snapshot per person for every widget and every open page, and the live
// topic `glance` that says when to ask for it again. A source that changes calls `changed()`; a snapshot is built once however many
// tabs ask for it, and pages are told only when what one shows is different, so a busy session's stream of events costs nothing.

import type { Actor, GlanceSnapshot } from '@portal/contracts';
import { actorString, actorUserId, ownerActor } from '../authz/seam.js';
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
}

export class Glance {
  readonly #sources: GlanceSources;
  readonly #opts: GlanceOptions;
  /** The snapshot of each actor who has asked (by `actorKey`), until something changes. */
  readonly #cache = new Map<string, GlanceSnapshot>();
  /** Every actor who has asked: whose snapshot a change has to compare before it pushes. */
  readonly #actors = new Map<string, Actor>();
  /** What the last push described, per actor, to push again only when something differs. */
  readonly #announced = new Map<string, string>();
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  readonly #undo: (() => void)[] = [];

  constructor(sources: GlanceSources, opts: GlanceOptions) {
    this.#sources = sources;
    this.#opts = opts;
  }

  /** `actor`'s snapshot, built again if a source changed since it was. */
  snapshot(actor: Actor = ownerActor()): GlanceSnapshot {
    const key = actorKey(actor);
    this.#actors.set(key, actor);
    return this.#cache.get(key) ?? this.#build(key, actor);
  }

  /** A source changed (a session's state, a request, a task, a ticket, a CI run). Cheap: the work is debounced. */
  changed(): void {
    this.#cache.clear();
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

  #build(key: string, actor: Actor): GlanceSnapshot {
    const snap = buildSnapshot(this.#sources, actor, (this.#opts.now ?? Date.now)(), this.#opts.log);
    this.#cache.set(key, snap);
    return snap;
  }

  #push(): void {
    if (this.#opts.watching && !this.#opts.watching()) return;
    // Every actor who has asked is compared with what was last said about them; one push tells the pages, and each page asks for its own.
    let different = false;
    for (const [key, actor] of this.#actors) {
      const now = fingerprint(this.#cache.get(key) ?? this.#build(key, actor));
      if (now !== this.#announced.get(key)) {
        this.#announced.set(key, now);
        different = true;
      }
    }
    if (different) this.#opts.notify();
  }
}

/** Whose snapshot: the actor's string and the user whose rights apply (a job's string is only its name, so two users' jobs must not share one). */
const actorKey = (actor: Actor): string => `${actorString(actor)}|${actorUserId(actor) ?? '-'}`;

/** What a page would draw, without the time it was built at. */
export const fingerprint = (s: GlanceSnapshot): string => JSON.stringify({ ...s, at: '' });
