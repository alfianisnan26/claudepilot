import type { ReporterChatMessage, ReporterChatState, ReporterTicket, ReporterTicketComment } from '@portal/contracts';

/* The panel's pure rules for chat, the composer, the comment thread and the ticket list (PILOT-1111). No React, no DOM: tested directly. */

/* ---------- Chat ---------- */

/**
 * New lines merged into what is shown: one per seq, oldest first. When nothing is new the SAME array comes back, so a live update that
 * only repeats what is shown re-renders nothing.
 */
export function mergeLines(cur: readonly ReporterChatMessage[], add: readonly ReporterChatMessage[]): ReporterChatMessage[] {
  if (!add.length) return cur as ReporterChatMessage[];
  const seen = new Set(cur.map((m) => m.seq));
  const fresh = add.filter((m) => !seen.has(m.seq));
  if (!fresh.length) return cur as ReporterChatMessage[];
  return [...cur, ...fresh].sort((a, b) => a.seq - b.seq);
}

/** What the chat header and composer say about the session: whether it is busy, and a one-word state. */
export function chatStatus(s: Pick<ReporterChatState, 'state' | 'waiting'> | null): { word: string; tone: 'idle' | 'busy' | 'wait' | 'off'; canSend: boolean } {
  if (!s) return { word: 'Loading', tone: 'off', canSend: false };
  if (s.state === 'ended') return { word: 'Ended', tone: 'off', canSend: false };
  if (s.waiting > 0 || s.state === 'waiting') return { word: 'Needs approval', tone: 'wait', canSend: true };
  if (s.state === 'working' || s.state === 'starting') return { word: s.state === 'starting' ? 'Starting' : 'Working', tone: 'busy', canSend: true };
  if (s.state === 'interrupted') return { word: 'Stopped', tone: 'idle', canSend: true };
  return { word: 'Idle', tone: 'idle', canSend: true };
}

/** A client id for a message (what the server checks: a UUID). */
export function newUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const h = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/* ---------- Composer ---------- */

/**
 * What a key does in the composer. Desktop: Enter sends, Shift+Enter is a new line. Touch: Enter is a new line (the send button sends).
 * Ctrl/Cmd+Enter sends everywhere. Nothing while an IME is composing (Enter picks a candidate there).
 */
export function composerKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing?: boolean }, coarse: boolean): 'send' | 'newline' | null {
  if (e.key !== 'Enter' || e.isComposing) return null;
  if (e.ctrlKey || e.metaKey) return 'send';
  if (e.shiftKey) return 'newline';
  return coarse ? 'newline' : 'send';
}

export const COMPOSER_MAX_ROWS = 5;
export const COMPOSER_LINE_PX = 20;
/** The field's height for its content: one line (44 px target) up to five lines, then it scrolls. */
export function composerHeight(scrollHeight: number, line = COMPOSER_LINE_PX, maxRows = COMPOSER_MAX_ROWS, padding = 24): number {
  const min = 44;
  const max = line * maxRows + padding;
  return Math.max(min, Math.min(max, Math.ceil(scrollHeight)));
}

/** The keyboard's height over the layout viewport (iOS shrinks only the visual viewport): the composer lifts by it. */
export function keyboardInset(innerHeight: number, vv: { height: number; offsetTop: number } | null): number {
  if (!vv) return 0;
  return Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
}

/* ---------- Thread (ticket comments) ---------- */

export interface CommentGroup {
  id: string;
  author: string;
  authorKind: ReporterTicketComment['authorKind'];
  createdAt: string;
  items: ReporterTicketComment[];
}

/** Consecutive comments by the same author within ten minutes as one group (author and time printed once), oldest first. */
export function groupComments(list: readonly ReporterTicketComment[], gapMs = 10 * 60_000): CommentGroup[] {
  const sorted = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || Number(a.id) - Number(b.id));
  const out: CommentGroup[] = [];
  for (const c of sorted) {
    const last = out.at(-1);
    const prev = last?.items.at(-1);
    if (last && prev && last.author === c.author && last.authorKind === c.authorKind && Date.parse(c.createdAt) - Date.parse(prev.createdAt) <= gapMs) last.items.push(c);
    else out.push({ id: c.id, author: c.author, authorKind: c.authorKind, createdAt: c.createdAt, items: [c] });
  }
  return out;
}

/** "now", "5m", "3h", "2d", then the date: the thread's one-line time. */
export function relTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(t).toISOString().slice(0, 10);
}

/** A body long enough to clamp to four lines with "more". */
export const needsClamp = (body: string) => body.split('\n').length > 4 || body.length > 320;

/** How many of the newest groups to show first, and how many more each scroll to the top reveals. */
export const THREAD_FIRST = 30;
export const THREAD_STEP = 20;

/* ---------- Ticket list ---------- */

/** The thumbnail a row shows: this page's capture first, else the first; null when the ticket has no screenshot (a compact text row). */
export function rowThumb(t: Pick<ReporterTicket, 'captures'>, here: Pick<ReporterTicket['captures'][number], 'screenshotUrl'>[] = []): string | null {
  return here.find((c) => c.screenshotUrl)?.screenshotUrl ?? t.captures.find((c) => c.screenshotUrl)?.screenshotUrl ?? null;
}

const sig = (t: ReporterTicket) => JSON.stringify(t);

/**
 * The next list with the objects of the current one kept where a ticket did not change, so memoised rows skip their render: a refresh after
 * a change event re-renders only the rows that changed.
 */
export function reuseRows(cur: readonly ReporterTicket[] | null, next: readonly ReporterTicket[]): ReporterTicket[] {
  if (!cur?.length) return next as ReporterTicket[];
  const old = new Map(cur.map((t) => [t.key, t]));
  let same = cur.length === next.length;
  const out = next.map((t, i) => {
    const o = old.get(t.key);
    const keep = o && sig(o) === sig(t) ? o : t;
    if (keep !== cur[i]) same = false;
    return keep;
  });
  return same ? (cur as ReporterTicket[]) : out;
}

/** A further page appended (cursor pagination): one row per key, the newer copy wins in place. */
export function appendPage(cur: readonly ReporterTicket[], page: readonly ReporterTicket[]): ReporterTicket[] {
  const at = new Map(cur.map((t, i) => [t.key, i]));
  const out = [...cur];
  for (const t of page) {
    const i = at.get(t.key);
    if (i === undefined) {
      at.set(t.key, out.length);
      out.push(t);
    } else out[i] = t;
  }
  return out;
}

/** How many rows a refresh asks for: what is loaded now (so a refresh keeps the pages already scrolled through), within the API's 100. */
export const refreshLimit = (loaded: number, page = 50) => Math.min(100, Math.max(page, loaded));

/**
 * The rows to render of a long list (windowing): the ones within `overscan` rows of the scrolled-to range, by an estimated row height. The
 * rest are spacers of that height, so the list keeps its length and scroll position.
 */
export function windowRange(count: number, scrollTop: number, viewport: number, rowPx: number, overscan = 8): { start: number; end: number } {
  if (count <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowPx);
  const visible = Math.ceil(Math.max(viewport, rowPx) / rowPx);
  // Scrolled past the end (a list that just got shorter): the last rows, never a start beyond the list.
  const start = Math.min(Math.max(0, first - overscan), Math.max(0, count - visible - overscan));
  const end = Math.min(count, Math.max(start, first) + visible + overscan);
  return { start, end };
}

/** "[Landing] Hero is cut off" as a small tag and the rest: a bracketed prefix the list shows as a tag, not as title text. */
export function splitPrefix(summary: string): { tag: string | null; text: string } {
  const m = /^\s*\[([^\]\n]{1,24})\]\s*(.+)$/s.exec(summary);
  return m ? { tag: m[1]!.trim(), text: m[2]! } : { tag: null, text: summary };
}

/** A session title without the internal prefix a crew gives it ("mo-T-2430 Fix the hero" reads "Fix the hero"). */
export const sessionTitle = (title: string) => title.replace(/^\s*[a-z]{1,6}-(?:T|[A-Z]{2,6})-\d+\s*[:·—–-]?\s*/, '') || title;

/** The filters that differ from the default as removable chips (one row under the search), each with what removing it leaves. */
export function filterChips<P extends { status: string; priority: string[]; type: string[]; tags: string[]; mine: boolean }>(
  p: P,
  label: { status: (s: string) => string; priority: (v: string) => string; type: (v: string) => string },
): { id: string; label: string; without: P }[] {
  const out: { id: string; label: string; without: P }[] = [];
  if (p.status !== 'open') out.push({ id: 'status', label: label.status(p.status), without: { ...p, status: 'open' } });
  for (const v of p.priority) out.push({ id: `p:${v}`, label: label.priority(v), without: { ...p, priority: p.priority.filter((x) => x !== v) } });
  for (const v of p.type) out.push({ id: `t:${v}`, label: label.type(v), without: { ...p, type: p.type.filter((x) => x !== v) } });
  for (const v of p.tags) out.push({ id: `g:${v}`, label: `#${v}`, without: { ...p, tags: p.tags.filter((x) => x !== v) } });
  if (p.mine) out.push({ id: 'mine', label: 'Mine', without: { ...p, mine: false } });
  return out;
}
