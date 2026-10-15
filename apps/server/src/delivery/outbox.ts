import type { Store } from '../store/store.js';
import { isTargetUnreachable, type Runtime } from '../workspaces/runtime.js';

/** Foundation PRD §8: one JSON object per line, at most this long. */
const LINE_MAX = 4096;
const PULL_EVERY_MS = 10_000;
/** Timer pulls running at once; the rest wait their turn in the same tick. */
export const MAX_CONCURRENT_PULLS = 4;
const SEEN_FOR_MS = 24 * 60 * 60_000;
const OUTBOX = '/home/node/.claudepilot/outbox';
/** `<type>.<n>.pulling`: a sealed outbox file. Only these names are ever passed back to the script. */
const PULLING = /^[a-z][a-z0-9_-]{0,31}\.\d{1,24}\.pulling$/;

/**
 * Seals and prints the outbox without truncating a file a writer may hold open (foundation PRD §8):
 * delete what the portal stored last time, rename each `<type>.jsonl` to `<type>.<n>.pulling`, wait a
 * second for writers that opened it just before, then print every sealed file after a `\x1e<name>` line.
 */
export const outboxPullScript = (dir = OUTBOX) => `#!/bin/sh
# claudepilot: seals and prints the outbox. Arguments: .pulling files the portal stored last time.
cd ${dir} 2>/dev/null || exit 0
for f in "$@"; do case "$f" in *.pulling) rm -f -- "$f" ;; esac; done
n=$(date +%s%N)
sealed=
for f in *.jsonl; do
  [ -s "$f" ] || continue
  mv -f -- "$f" "\${f%.jsonl}.$n.pulling" && sealed=1
done
[ -n "$sealed" ] && sleep 1
for f in *.pulling; do
  [ -e "$f" ] || continue
  printf '\\036%s\\n' "$f"
  cat -- "$f"
  echo
done
exit 0
`;
export const OUTBOX_PULL = outboxPullScript();

/** One line a hook or helper appended. `id` is unique per workspace; `type` is the event's kind. */
export interface OutboxEvent {
  id: string;
  type?: string;
  [field: string]: unknown;
}

/** Splits the script's output into the sealed files it printed and their events, by outbox type. */
export function parseOutbox(stdout: string): { files: string[]; events: { channel: string; event: OutboxEvent }[] } {
  const files: string[] = [];
  const events: { channel: string; event: OutboxEvent }[] = [];
  let channel: string | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('\x1e')) {
      const file = line.slice(1);
      channel = PULLING.test(file) ? file.slice(0, file.indexOf('.')) : null;
      if (channel) files.push(file);
      continue;
    }
    if (!channel || !line || line.length > LINE_MAX) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a torn or foreign line: skipped, never fatal
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const id = (event as { id?: unknown }).id;
    if (typeof id !== 'string' || !id || id.length > 100) continue;
    events.push({ channel, event: event as OutboxEvent });
  }
  return { files, events };
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

type Handler = (workspaceId: string, events: OutboxEvent[]) => void;

/**
 * Pulls events that workspaces append to `~/.claudepilot/outbox/<type>.jsonl` (foundation PRD §8):
 * every 10 s for running workspaces some subscriber wants, and once before the portal stops one.
 * Each event reaches its subscriber once, even when a file is read again after a restart.
 */
export class Outbox {
  readonly #subs = new Map<string, { handler: Handler; workspaces: () => string[] }>();
  /** Sealed files whose events are stored: the next pull deletes them. */
  readonly #stored = new Map<string, string[]>();
  readonly #inFlight = new Map<string, Promise<void>>();
  #timer: NodeJS.Timeout | undefined;
  #lastPrune = 0;
  /** Workspaces the timer will pull, and how many of its pulls run now. */
  #queue: string[] = [];
  #timed = 0;
  /** Workspaces whose last pull met an unreachable target (logged once until a pull succeeds). */
  readonly #unreachable = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly runtimes: (target: string) => Runtime | undefined,
  ) {}

  /** `workspaces` lists the workspaces whose `<type>` events this subscriber wants pulled. */
  subscribe(type: string, handler: Handler, workspaces: () => string[]) {
    this.#subs.set(type, { handler, workspaces });
  }

  start() {
    this.#timer = setInterval(() => this.#tick(), PULL_EVERY_MS);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
  }

  #tick() {
    // Each tick replaces the queue: a workspace still waiting from the last tick is not pulled twice, and it goes first,
    // so slow pulls at the front never starve the end of the list (T-404 review 2, item 8).
    const wanted = new Set([...this.#subs.values()].flatMap((s) => s.workspaces()));
    const waited = this.#queue.filter((id) => wanted.has(id));
    this.#queue = [...new Set([...waited, ...wanted])].filter((id) => !this.#inFlight.has(id));
    this.#drain();
  }

  /** Starts queued pulls, at most MAX_CONCURRENT_PULLS at once (T-404: the guard channel covers many workspaces). */
  #drain() {
    while (this.#timed < MAX_CONCURRENT_PULLS && this.#queue.length) {
      const id = this.#queue.shift()!;
      if (this.#inFlight.has(id)) continue;
      this.#timed++;
      void this.pull(id)
        .then(
          () => void this.#unreachable.delete(id),
          (e: unknown) => {
            // A target whose tunnel is down: one line per outage, not one per pull (targets-connect PRD §12.5).
            if (isTargetUnreachable(e)) {
              if (!this.#unreachable.has(id)) console.error(`[outbox] ${id}: ${(e as Error).message}`);
              this.#unreachable.add(id);
              return;
            }
            console.error(`[outbox] ${id}: ${(e as Error).message}`);
          },
        )
        .finally(() => {
          this.#timed--;
          this.#drain();
        });
    }
  }

  /** One pull of a running workspace; a call during one shares it. */
  pull(workspaceId: string): Promise<void> {
    const running = this.#inFlight.get(workspaceId);
    if (running) return running;
    const p = this.#pull(workspaceId).finally(() => this.#inFlight.delete(workspaceId));
    this.#inFlight.set(workspaceId, p);
    return p;
  }

  async #pull(workspaceId: string) {
    // Frozen: no pulls (foundation §6.5). Locked: pulls go on, only secrets are out of reach.
    if (this.store.trust.state === 'frozen' || !this.store.writable || !this.store.db) return;
    const slash = workspaceId.indexOf('/');
    const access = this.runtimes(workspaceId.slice(0, slash))?.delivery;
    const name = workspaceId.slice(slash + 1);
    if (!access) return;
    // Stopped: the files wait on the home volume for the next start (§8, Q7).
    if (!(await access.state(name)).running) return;
    const done = this.#stored.get(workspaceId) ?? [];
    const r = await access.run(name, ['/etc/claudepilot/bin/outbox-pull', ...done].map(q).join(' '), { user: 'node', timeoutMs: 15_000 });
    if (r.code === 126 || r.code === 127) return; // not delivered yet
    if (r.code !== 0) throw new Error(`outbox-pull exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
    const { files, events } = parseOutbox(r.stdout);
    this.#store(workspaceId, events);
    this.#stored.set(workspaceId, files);
  }

  #store(workspaceId: string, events: { channel: string; event: OutboxEvent }[]) {
    const db = this.store.db!;
    const now = Date.now();
    const insert = db.prepare('INSERT INTO outbox_seen (workspace_id, event_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
    const fresh = new Map<string, OutboxEvent[]>();
    for (const { channel, event } of events) {
      if (Number(insert.run(workspaceId, `${channel}:${event.id}`, new Date(now).toISOString()).changes) !== 1) continue;
      fresh.set(channel, [...(fresh.get(channel) ?? []), event]);
    }
    for (const [channel, list] of fresh) {
      try {
        this.#subs.get(channel)?.handler(workspaceId, list);
      } catch (e) {
        console.error(`[outbox] ${channel} handler failed for ${workspaceId}: ${(e as Error).message}`);
      }
    }
    if (now - this.#lastPrune > 60 * 60_000) {
      this.#lastPrune = now;
      db.prepare('DELETE FROM outbox_seen WHERE at < ?').run(new Date(now - SEEN_FOR_MS).toISOString());
    }
  }
}
