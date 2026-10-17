// T-971 H1: the refusal watcher. It reads the refusals agents ran into (a permission denied by the folder's rules, a Portal MCP FORBIDDEN, a
// FOLDER_UNTRUSTED) from the stored tool results, groups them by (workspace, rule shape) and files ONE ticket per group, FOR THE COORDINATOR,
// with the command (redacted), the rule and a proposed line. It DETECTS and FILES only: it changes no rule, no setting and no allow list.
// A group already filed (an open ticket carries its tag, or this process filed it lately) is never filed twice, and at most `perHour`
// tickets are filed in an hour: the rest waits for the next pass.

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { TicketItem } from '@portal/contracts';
import { redact } from '../chat/redact.js';
import type { RefusalEventRow } from '../chat/store.js';
import type { Tickets } from './service.js';

export type RefusalKind = 'permission' | 'portal_forbidden' | 'folder_untrusted';

export interface Refusal {
  kind: RefusalKind;
  /** The rule's shape: `git push` for a Bash call, the tool's name otherwise. */
  shape: string;
  /** The line a coordinator would add, or the change to make, in words. Never applied here. */
  proposed: string;
}

/** The tag every filed ticket carries; and `refusal-<8 hex>` names the group (the de-dupe key). */
export const REFUSAL_TAG = 'refusal';
export const REFUSAL_PER_HOUR = 5;
export const REFUSAL_SWEEP_MS = 5 * 60_000;
const LOOKBACK_MS = 60 * 60_000;
const BATCH = 500;
const SAMPLE_MAX = 300;
const HOUR_MS = 60 * 60_000;
/** Programs whose rule is per subcommand (`Bash(git push:*)`), not per program. */
const SUBCOMMAND = new Set(['git', 'npm', 'npx', 'kubectl', 'gh', 'docker', 'yarn', 'pnpm', 'helm']);

const SAFE_WORD = /^[A-Za-z0-9._/@:+-]+$/;

/** The first program word of a shell line, and its subcommand when the program has them. Null when it can't be read as a plain word. */
export function bashShape(command: string): string | null {
  const words = command.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++; // leading VAR=value
  const first = words[i];
  if (!first || !SAFE_WORD.test(first)) return null;
  const program = posix.basename(first);
  if (!program || program.includes('[redacted]')) return null;
  if (SUBCOMMAND.has(program)) {
    // skip flags (and the value of `-C <dir>`) to the subcommand
    let j = i + 1;
    while (j < words.length && words[j]!.startsWith('-')) j += words[j] === '-C' || words[j] === '-c' ? 2 : 1;
    const sub = words[j];
    if (sub && SAFE_WORD.test(sub) && !sub.startsWith('-')) return `${program} ${sub}`;
  }
  return program;
}

/** What a stored failed tool result is, when it is a refusal; null when it is any other failure. */
export function classify(ev: Pick<RefusalEventRow, 'text' | 'toolName' | 'command'>): Refusal | null {
  const tool = ev.toolName && /^[A-Za-z0-9_.:-]{1,80}$/.test(ev.toolName) ? ev.toolName : 'unknown';
  if (/FOLDER_UNTRUSTED/.test(ev.text))
    return {
      kind: 'folder_untrusted',
      shape: 'folder',
      proposed: 'Trust the folder in the portal (a person confirms its project settings); nothing is trusted by the watcher.',
    };
  if (/\bFORBIDDEN\b/.test(ev.text))
    return {
      kind: 'portal_forbidden',
      shape: tool,
      proposed: `Check the agent's access (scope or per-workspace agent access) for the Portal MCP tool \`${tool}\`.`,
    };
  if (/has been denied/i.test(ev.text)) {
    if (tool === 'Bash') {
      const shape = ev.command ? bashShape(ev.command) : null;
      return shape
        ? { kind: 'permission', shape, proposed: `Bash(${shape}:*)` }
        : { kind: 'permission', shape: 'Bash', proposed: '(none: the command could not be read as a plain program; decide by hand)' };
    }
    return { kind: 'permission', shape: tool, proposed: tool };
  }
  return null;
}

export interface RefusalGroup {
  key: string;
  workspaceId: string;
  refusal: Refusal;
  count: number;
  sessions: string[];
  firstAt: string;
  lastAt: string;
  /** The newest command and text, redacted and cut. */
  command: string | null;
  sample: string;
}

/** `refusal-` plus 8 hex digits of the (workspace, kind, shape) key: a valid tag, stable across restarts. */
export function groupTag(workspaceId: string, r: Refusal): string {
  return `refusal-${createHash('sha256').update(`${workspaceId}\0${r.kind}\0${r.shape}`).digest('hex').slice(0, 8)}`;
}

const clean = (s: string) => redact(s).replace(/[`\r\n\u0000-\u001f]+/g, ' ').trim().slice(0, SAMPLE_MAX);

/** Groups refusals by (workspace, rule shape), counting each. `into` merges a later batch into an earlier one. */
export function groupRefusals(events: RefusalEventRow[], into: Map<string, RefusalGroup> = new Map()): Map<string, RefusalGroup> {
  for (const ev of events) {
    const refusal = classify(ev);
    if (!refusal) continue;
    const key = groupTag(ev.workspaceId, refusal);
    let g = into.get(key);
    if (!g) {
      g = { key, workspaceId: ev.workspaceId, refusal, count: 0, sessions: [], firstAt: ev.at, lastAt: ev.at, command: null, sample: '' };
      into.set(key, g);
    }
    g.count++;
    if (!g.sessions.includes(ev.sessionId) && g.sessions.length < 20) g.sessions.push(ev.sessionId);
    if (ev.at < g.firstAt) g.firstAt = ev.at;
    if (ev.at >= g.lastAt) {
      g.lastAt = ev.at;
      g.command = ev.command ? clean(ev.command) : null;
      g.sample = clean(ev.text);
    }
  }
  return into;
}

/** The ticket for one group. The phrase `FOR THE COORDINATOR:` is what the coordinator's watch reads. */
export function ticketFor(g: RefusalGroup): { summary: string; description: string; tags: string[] } {
  const what = g.refusal.kind === 'permission' ? `${g.refusal.shape} refused` : g.refusal.kind === 'portal_forbidden' ? `${g.refusal.shape} forbidden` : 'folder untrusted';
  const description = [
    `FOR THE COORDINATOR: ${g.refusal.proposed}`,
    '',
    `The watcher saw agents refused ${g.count} time${g.count === 1 ? '' : 's'} (${g.refusal.kind}) in \`${g.workspaceId}\`, between ${g.firstAt} and ${g.lastAt}, in ${g.sessions.length} session${g.sessions.length === 1 ? '' : 's'}.`,
    '',
    `- Rule shape: \`${g.refusal.shape}\``,
    `- Proposed line: \`${g.refusal.proposed.replace(/`/g, "'")}\``,
    ...(g.command ? [`- Latest command (redacted): \`${g.command}\``] : []),
    `- Latest refusal (redacted): ${g.sample}`,
    `- Sessions: ${g.sessions.map((s) => `\`${s}\``).join(', ')}`,
    '',
    'Filed by the refusal watcher (T-971 H1). It changed no rule: decide whether to add the line, and keep the deny rules in mind (D-60).',
  ].join('\n');
  return { summary: `FOR THE COORDINATOR: ${what} in ${g.workspaceId}`, description, tags: [REFUSAL_TAG, g.key] };
}

export interface RefusalWatcherOptions {
  /** The stored refusals from `sinceAt` on, oldest first (the chat controller). */
  source: (sinceAt: string, limit: number) => RefusalEventRow[];
  tickets: Pick<Tickets, 'create' | 'list'>;
  now?: () => Date;
  perHour?: number;
}

export class RefusalWatcher {
  readonly #o: Required<RefusalWatcherOptions>;
  #cursor: string;
  /** Events at the cursor's timestamp already counted (a read starts AT the cursor, so these come again). */
  #seen = new Set<string>();
  #pending = new Map<string, RefusalGroup>();
  #filedAt: number[] = [];
  /** Groups this process filed: a ticket closed since is not filed again until a new restart. */
  #filed = new Set<string>();

  constructor(opts: RefusalWatcherOptions) {
    this.#o = { now: () => new Date(), perHour: REFUSAL_PER_HOUR, ...opts };
    this.#cursor = new Date(this.#o.now().getTime() - LOOKBACK_MS).toISOString();
  }

  /** One pass: read what is new, file what is not filed yet (within the rate limit). Returns the tickets it filed. */
  scan(): TicketItem[] {
    for (;;) {
      const rows = this.#o.source(this.#cursor, BATCH);
      const fresh = rows.filter((r) => !this.#seen.has(`${r.sessionId}:${r.seq}`));
      groupRefusals(fresh, this.#pending);
      const last = rows[rows.length - 1];
      if (last) {
        if (last.at !== this.#cursor) this.#seen.clear();
        this.#cursor = last.at;
        for (const r of rows) if (r.at === this.#cursor) this.#seen.add(`${r.sessionId}:${r.seq}`);
      }
      if (rows.length < BATCH || fresh.length === 0) break;
    }
    const now = this.#o.now().getTime();
    this.#filedAt = this.#filedAt.filter((t) => now - t < HOUR_MS);
    const out: TicketItem[] = [];
    for (const [key, g] of this.#pending) {
      if (this.#filed.has(key) || this.#hasOpenTicket(key)) {
        this.#pending.delete(key);
        continue;
      }
      if (this.#filedAt.length >= this.#o.perHour) break; // the rest waits for the next pass
      const t = this.#o.tickets.create({ kind: 'system' }, { ...ticketFor(g), type: 'task', priority: 'normal' });
      this.#filedAt.push(now);
      this.#filed.add(key);
      this.#pending.delete(key);
      out.push(t);
    }
    return out;
  }

  #hasOpenTicket(tag: string): boolean {
    return this.#o.tickets.list({ kind: 'system' }, { tag, limit: 1 }).total > 0;
  }
}

type Timer = { unref?: () => void };

/** Runs {@link RefusalWatcher.scan} every few minutes; one pass failing never stops the loop. */
export class RefusalSweep {
  #timer: Timer | null = null;
  #stopped = true;
  constructor(
    private readonly watcher: Pick<RefusalWatcher, 'scan'>,
    private readonly intervalMs = REFUSAL_SWEEP_MS,
    private readonly setTimer: (fn: () => void, ms: number) => Timer = (fn, ms) => setTimeout(fn, ms),
    private readonly clearTimer: (t: Timer) => void = (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  ) {}

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) this.clearTimer(this.#timer);
    this.#timer = null;
  }

  #schedule() {
    this.#timer = this.setTimer(() => {
      this.#timer = null;
      if (this.#stopped) return;
      try {
        this.watcher.scan();
      } catch (e) {
        console.error(`[tickets] the refusal watcher failed: ${(e as Error).message}`);
      } finally {
        if (!this.#stopped) this.#schedule();
      }
    }, this.intervalMs);
    this.#timer.unref?.();
  }
}
