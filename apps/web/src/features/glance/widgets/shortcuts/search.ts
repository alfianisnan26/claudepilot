import type { ChatSessionState } from '@portal/contracts';

// What the quick-search palette lists and in what order (docs/prd/glance-widgets.md §6.5). Pure over plain items, so the ranking can be
// tested; `sources.ts` turns sessions, workspaces, tickets, pages and actions into items.

export type PaletteKind = 'action' | 'page' | 'session' | 'workspace' | 'ticket';

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  title: string;
  /** The row's second part: where it runs, how it stands, what it does. */
  hint: string;
  to: string;
  /** Matched but not shown (a Claude's name, a branch, a ticket number). */
  keywords?: string;
  /** For the order among sessions: when it was last used (ms). */
  recent?: number;
  /** A session's state, for the row's dot. */
  state?: ChatSessionState;
  /** The source already matched it (a ticket found by the portal's own text search): no word has to match again here. */
  matched?: boolean;
}

/** Where kinds sit when scores tie: what you do, where you go, then the things you search for. */
const KIND_ORDER: Record<PaletteKind, number> = { action: 0, page: 1, session: 2, ticket: 3, workspace: 4 };

export const words = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * How well an item answers the query, 0 for not at all. Every word must be found: in the title (an exact title 120, a title that
 * starts with it 100, a word of the title that does 60, anywhere in it 30) or in what is shown beside it and in the keywords (10). The
 * words add up, so "fix tests" finds "Fix the tests" above "Tests: fix later" only by where the words fall.
 */
export function scoreItem(item: PaletteItem, ws: string[]): number {
  if (ws.length === 0) return 1;
  const title = item.title.toLowerCase();
  const titleWords = title.split(/[\s·/_:.-]+/).filter(Boolean);
  const rest = `${item.hint} ${item.keywords ?? ''}`.toLowerCase();
  let total = 0;
  for (const w of ws) {
    let best = 0;
    if (title === w) best = 120;
    else if (title.startsWith(w)) best = 100;
    else if (titleWords.some((t) => t.startsWith(w))) best = 60;
    else if (title.includes(w)) best = 30;
    else if (rest.includes(w)) best = 10;
    if (best === 0) return item.matched ? 5 : 0;
    total += best;
  }
  return total;
}

const byRank = (score: Map<string, number>) => (a: PaletteItem, b: PaletteItem) =>
  (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (b.recent ?? 0) - (a.recent ?? 0) || a.title.localeCompare(b.title);

export interface SearchOptions {
  /** Most results in all. */
  limit?: number;
  /** Most of one kind, so a hundred sessions do not push the pages and tickets out. */
  perKind?: number;
}

/** The items answering `query`, best first. An empty query is `suggest`. */
export function searchPalette(items: readonly PaletteItem[], query: string, opts: SearchOptions = {}): PaletteItem[] {
  const ws = words(query);
  if (ws.length === 0) return suggest(items, opts);
  const { limit = 12, perKind = 6 } = opts;
  const score = new Map<string, number>();
  const hits = items.filter((i) => {
    const s = scoreItem(i, ws);
    if (s > 0) score.set(i.id, s);
    return s > 0;
  });
  const used = new Map<PaletteKind, number>();
  return hits
    .sort(byRank(score))
    .filter((i) => {
      const n = used.get(i.kind) ?? 0;
      if (n >= perKind) return false;
      used.set(i.kind, n + 1);
      return true;
    })
    .slice(0, limit);
}

/** With nothing typed: the actions, the sessions used last, then the pages. */
export function suggest(items: readonly PaletteItem[], opts: SearchOptions = {}): PaletteItem[] {
  const { limit = 20 } = opts;
  const of = (kind: PaletteKind) => items.filter((i) => i.kind === kind);
  const sessions = of('session')
    .sort((a, b) => (b.recent ?? 0) - (a.recent ?? 0))
    .slice(0, 5);
  return [...of('action'), ...sessions, ...of('page')].slice(0, limit);
}

/** "T-12", "t12" or "12" typed after a "T": a way to a ticket by its number, which the search over text would not find. */
export function ticketByNumber(query: string): PaletteItem | null {
  const m = /^\s*t-?(\d{1,7})\s*$/i.exec(query);
  // T-1098: a bucket key (KONF-12, any case) opens that ticket too; the server resolves it.
  const k = m ? null : /^\s*([a-z]{2,6})-(\d{1,7})\s*$/i.exec(query);
  if (k) {
    const key = `${k[1]!.toUpperCase()}-${Number(k[2])}`;
    return { id: `ticket:${key}`, kind: 'ticket', title: key, hint: 'Open ticket', to: `/admin/tickets/${key}`, matched: true };
  }
  if (!m) return null;
  const id = `T-${Number(m[1])}`;
  return { id: `ticket:${id}`, kind: 'ticket', title: id, hint: 'Open ticket', to: `/admin/tickets/${id}`, matched: true };
}
