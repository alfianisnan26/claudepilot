import {
  isTicketClosed,
  type ReporterCallout,
  type ReporterReview,
  type ReporterTicket,
  type ReporterTicketQuery,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
} from '@portal/contracts';
import { pathnameOf, samePage } from '@/features/reporter/shared';

/* Pure state of the panel: the remembered list choice, the query it makes, the callouts it draws, the stream it reads. */

export type Scope = 'page' | 'all' | 'grouped';
export type Sort = NonNullable<ReporterTicketQuery['sort']>;

export interface ListPrefs {
  scope: Scope;
  status: NonNullable<ReporterTicketQuery['status']>;
  priority: TicketPriority[];
  type: TicketType[];
  tags: string[];
  mine: boolean;
  /** null = the scope's default (position on This page, updated elsewhere). */
  sort: Sort | null;
  order: 'asc' | 'desc' | null;
  q: string;
}

export const DEFAULT_PREFS: ListPrefs = { scope: 'page', status: 'open', priority: [], type: [], tags: [], mine: false, sort: null, order: null, q: '' };

export const SORT_LABEL: Record<Sort, string> = {
  updated: 'Updated',
  created: 'Created',
  priority: 'Priority',
  position: 'Position on page',
  captures: 'Most captures',
};

/** The sort in effect: Position only makes sense on one page. */
export function effectiveSort(p: ListPrefs): Sort {
  const s = p.sort ?? (p.scope === 'page' ? 'position' : 'updated');
  return s === 'position' && p.scope !== 'page' ? 'updated' : s;
}
export function effectiveOrder(p: ListPrefs): 'asc' | 'desc' {
  return p.order ?? (effectiveSort(p) === 'position' ? 'asc' : 'desc');
}

/** How many filters differ from the default (the Filter button's count). */
export function activeFilterCount(p: ListPrefs): number {
  return (p.status !== 'open' ? 1 : 0) + p.priority.length + p.type.length + p.tags.length + (p.mine ? 1 : 0);
}

export function buildQuery(p: ListPrefs, currentPath: string | null, extra: Partial<ReporterTicketQuery> = {}): ReporterTicketQuery {
  const q: ReporterTicketQuery = { status: p.status, sort: effectiveSort(p), order: effectiveOrder(p), limit: 100 };
  if (p.priority.length) q.priority = p.priority;
  if (p.type.length) q.type = p.type;
  if (p.tags.length) q.tags = p.tags;
  if (p.mine) q.mine = true;
  if (p.q.trim()) q.q = p.q.trim();
  if (p.scope === 'page' && currentPath) q.path = pathnameOf(currentPath);
  return { ...q, ...extra };
}

/** The query string the server reads (lists comma-joined). */
export function querySearch(q: ReporterTicketQuery): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) s.set(k, v.join(','));
    } else s.set(k, String(v));
  }
  const out = s.toString();
  return out ? `?${out}` : '';
}

const STATUSES = new Set(['open', 'closed', 'all', 'in_progress', 'blocked', 'in_review', 'done', 'wont_do']);
const SORTS = new Set(['updated', 'created', 'priority', 'position', 'captures']);

/** Remembered prefs, checked field by field (storage is the viewer's, but old or odd values must not break the list). */
export function parsePrefs(raw: string | null): ListPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const v = JSON.parse(raw) as Partial<ListPrefs>;
    const arr = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string').slice(0, 20) : []);
    return {
      scope: v.scope === 'all' || v.scope === 'grouped' ? v.scope : 'page',
      status: typeof v.status === 'string' && STATUSES.has(v.status) ? v.status : 'open',
      priority: arr(v.priority) as TicketPriority[],
      type: arr(v.type) as TicketType[],
      tags: arr(v.tags),
      mine: v.mine === true,
      sort: typeof v.sort === 'string' && SORTS.has(v.sort) ? v.sort : null,
      order: v.order === 'asc' || v.order === 'desc' ? v.order : null,
      q: '',
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** The captures of a ticket on this page, in order. */
export const capturesHere = (t: ReporterTicket, path: string) => t.captures.filter((c) => samePage(c.anchor.path, path));

/** A done ticket keeps its callout this long, so the reporter sees it go fixed, then deployed. */
const DONE_DAYS = 14;

/**
 * The callouts for this page: one per capture of each ticket with a capture here (not won't-do; done ones only for two weeks), plus
 * the viewer's own draft review comments as pending markers. Deployment state is this environment's.
 */
export function buildCallouts(
  tickets: ReporterTicket[],
  path: string,
  environment: string | null,
  draft: ReporterReview | null,
  now = Date.now(),
): ReporterCallout[] {
  const out: ReporterCallout[] = [];
  for (const t of tickets) {
    if (t.status === 'wont_do') continue;
    if (isTicketClosed(t.status) && now - Date.parse(t.updatedAt) > DONE_DAYS * 86_400_000) continue;
    const total = t.captures.length;
    for (const c of t.captures) {
      if (!samePage(c.anchor.path, path)) continue;
      out.push({
        key: t.key,
        summary: t.summary,
        status: t.status,
        priority: t.priority,
        url: t.url,
        captureId: c.captureId,
        phase: t.phase,
        fix: t.fix,
        deployment: (environment && t.deployments.find((d) => d.environment === environment)) || null,
        reportedOn: t.site ? { origin: t.site.origin, environment: t.site.environment } : null,
        awaitingReporter: t.awaitingReporter,
        unread: t.unread,
        index: c.index,
        total,
        anchor: c.anchor,
      });
    }
  }
  if (draft && draft.status === 'draft') {
    for (const c of draft.comments) {
      if (!samePage(c.anchor.path, path)) continue;
      out.push({
        key: draft.id,
        summary: c.body.split('\n')[0]!.slice(0, 140) || draft.title,
        status: 'open' as TicketStatus,
        priority: 'normal',
        url: '',
        captureId: c.captureId,
        pending: true,
        phase: 'open',
        fix: null,
        deployment: null,
        reportedOn: null,
        awaitingReporter: false,
        unread: 0,
        index: c.index,
        total: draft.comments.length,
        anchor: c.anchor,
      });
    }
  }
  return out;
}

/** Every capture on this page across the listed tickets, top to bottom (for Play all). */
export function playlist(tickets: ReporterTicket[], path: string): { key: string; captureId: string }[] {
  return tickets
    .flatMap((t) => capturesHere(t, path).map((c) => ({ key: t.key, captureId: c.captureId, y: c.anchor.rect.y, x: c.anchor.rect.x })))
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map(({ key, captureId }) => ({ key, captureId }));
}

/** Tickets grouped by the page of their first capture ("grouped by page"), groups in first-seen order. */
export function groupByPage(tickets: ReporterTicket[]): { path: string; items: ReporterTicket[] }[] {
  const groups = new Map<string, ReporterTicket[]>();
  for (const t of tickets) {
    const p = t.captures[0] ? pathnameOf(t.captures[0].anchor.path) : '';
    groups.set(p, [...(groups.get(p) ?? []), t]);
  }
  return [...groups.entries()].map(([path, items]) => ({ path, items }));
}

/**
 * Reads a streamed body: server-sent-event framing ("data: {...}" lines, blank line between) or one JSON object per line. Returns
 * the complete events and the unfinished rest to prepend to the next chunk. Lines that are not JSON (comments, keep-alives) are skipped.
 */
export function splitStream(buffer: string): { events: unknown[]; rest: string } {
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() ?? '';
  const events: unknown[] = [];
  for (const raw of lines) {
    const line = raw.startsWith('data:') ? raw.slice(5).trim() : raw.trim();
    if (!line || line.startsWith(':') || /^(event|id|retry):/.test(raw)) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // not an event
    }
  }
  return { events, rest };
}

/** A normalized, comparable form of a hotkey ("Alt+Shift+R"), or null for a lone modifier. */
export function hotkeyOf(e: { key: string; altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): string | null {
  if (['Alt', 'Shift', 'Control', 'Meta'].includes(e.key)) return null;
  const parts = [e.ctrlKey && 'Ctrl', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean) as string[];
  if (!parts.length) return null;
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [...parts, key].join('+');
}

export const DEFAULT_HOTKEYS = { report: 'Alt+Shift+R', crop: 'Alt+Shift+C', callouts: 'Alt+Shift+H', panel: 'Alt+Shift+P' } as const;
export type Hotkeys = Record<keyof typeof DEFAULT_HOTKEYS, string>;

export function parseHotkeys(raw: string | null): Hotkeys {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<Hotkeys>) : {};
    const ok = (s: unknown) => typeof s === 'string' && /^((Ctrl|Meta|Alt|Shift)\+)+[^+]{1,12}$/.test(s);
    return {
      report: ok(v.report) ? v.report! : DEFAULT_HOTKEYS.report,
      crop: ok(v.crop) ? v.crop! : DEFAULT_HOTKEYS.crop,
      callouts: ok(v.callouts) ? v.callouts! : DEFAULT_HOTKEYS.callouts,
      panel: ok(v.panel) ? v.panel! : DEFAULT_HOTKEYS.panel,
    };
  } catch {
    return { ...DEFAULT_HOTKEYS };
  }
}

/** A path on the host origin to open in the same tab ("Open that page"), or null when it would leave that origin. */
export function samePageHref(origin: string, path: string): string | null {
  try {
    const u = new URL(path, origin);
    return u.origin === origin && (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
  } catch {
    return null;
  }
}

/** Proposed summary for a submitted review: its title, else the first comment's first line. */
export function proposedSummary(r: ReporterReview): string {
  return (r.title.trim() || r.comments[0]?.body.split('\n')[0] || 'UI review').slice(0, 200);
}

/** How many tickets a submit mode makes (shown on the button). */
export function ticketsFor(r: ReporterReview, mode: 'single' | 'per-page' | 'per-capture'): number {
  if (!r.comments.length) return 0;
  if (mode === 'single') return 1;
  if (mode === 'per-capture') return r.comments.length;
  return new Set(r.comments.map((c) => pathnameOf(c.anchor.path))).size;
}
