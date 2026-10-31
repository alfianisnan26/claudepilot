import type { ChatEvent, ReporterChatMessage, ReporterChatRuntime, ReporterChatState, ReporterTicket, ReporterTicketComment, ReporterUsageWindow } from '@portal/contracts';
import { MODE_LABELS } from '@/features/chat/modeLabels';
import { modelShortName } from '@/features/chat/modelName';
import { formatTokens, formatUsd } from '@/features/chat/tokens';
import { buildRows, formatSeconds, shortTarget, toolLabel, type ToolPair, type TranscriptRow } from '@/features/chat/toolModel';

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

/* ---------- Tool activity (the portal chat's grouping) ---------- */

/**
 * What the chat list renders: a line as it is, or a run of tool calls folded into one activity row, as the portal's transcript does
 * (features/chat: `buildRows` joins each result to its call and folds runs of read-only calls, Activity.tsx shows a turn's work as one row).
 * The panel keeps every text line in the open (it has no turn ends to tell a note from a reply), so a run is the calls between two of them.
 */
export type ChatItem =
  | { type: 'line'; key: string; m: ReporterChatMessage }
  | {
      type: 'activity';
      key: string;
      /** The portal's rows: a call with its result, or a run of read-only calls. */
      rows: TranscriptRow[];
      /** Every call in order, the runs opened up. */
      steps: ToolPair[];
      /** The session still works on this run (it is the newest thing in the chat): calls without a result are running. */
      live: boolean;
      /** Changes whenever what the row shows changes: memoised rows compare it, not the arrays. */
      sig: string;
    };

/** A panel line as the portal's transcript event (only what its row model reads), so both fold the same way. */
function asEvent(m: ReporterChatMessage): ChatEvent {
  if (m.kind === 'tool') return { seq: m.seq, at: m.at, kind: 'tool_use', toolName: m.tool ?? undefined, text: m.text, toolUseId: m.toolId ?? undefined };
  if (m.kind === 'tool_result') return { seq: m.seq, at: m.at, kind: 'tool_result', text: m.text, toolUseId: m.toolId ?? undefined, isError: m.ok === false };
  // Every other line stands as it is: an event kind the row model keeps as its own row.
  return { seq: m.seq, at: m.at, kind: 'assistant' };
}

/**
 * The chat's items from its lines. `busy`: the session is working, so the newest run is live. Pure; the chat computes it once per batch of
 * lines (a memo on the lines array, which a batch that adds nothing keeps the same).
 */
export function chatItems(lines: readonly ReporterChatMessage[], busy: boolean): ChatItem[] {
  const bySeq = new Map(lines.map((m) => [m.seq, m]));
  const rows = buildRows(lines.map(asEvent), true);
  const out: ChatItem[] = [];
  let run: TranscriptRow[] = [];
  const flush = () => {
    if (!run.length) return;
    const steps = run.flatMap((r) => (r.type === 'tool' ? [{ call: r.call, result: r.result }] : r.type === 'group' ? r.tools : []));
    out.push({ type: 'activity', key: `a${steps[0]!.call.seq}`, rows: run, steps, live: false, sig: '' });
    run = [];
  };
  for (const r of rows) {
    if (r.type === 'tool' || r.type === 'group') {
      run.push(r);
      continue;
    }
    flush();
    const m = r.type === 'event' ? bySeq.get(r.event.seq) : undefined;
    if (m) out.push({ type: 'line', key: `l${m.seq}`, m });
  }
  flush();
  const last = out.at(-1);
  if (busy && last?.type === 'activity') last.live = true;
  for (const it of out)
    if (it.type === 'activity') it.sig = `${it.live ? 1 : 0}|${it.steps.map((s) => `${s.call.seq}:${s.result ? (s.result.isError ? 'x' : 'o') : '-'}`).join(',')}`;
  return out;
}

/** The tools that start a sub-agent (the portal's AGENT_TOOLS): their line reads "Agent: <what it does>". */
const AGENT_TOOL = new Set(['Task', 'Agent']);
export const isAgentStep = (s: ToolPair) => AGENT_TOOL.has(s.call.toolName ?? '');

/** One step's words, as the portal's activity row names its latest step: "Read hero.tsx", "Bash npm test", "Agent: Find the hero". */
export function stepText(s: ToolPair): string {
  const { name, target } = stepParts(s);
  return target ? `${name}${isAgentStep(s) ? ':' : ''} ${target}` : name;
}
/** A step's name ("Bash", "playwright · browser_click", "Agent") and what it was given, shortened as the portal's rows do. */
export function stepParts(s: ToolPair): { name: string; target: string } {
  if (isAgentStep(s)) return { name: 'Agent', target: (s.call.text ?? '').trim() };
  return { name: s.call.toolName ? toolLabel(s.call.toolName) : 'Tool', target: shortTarget(s.call.text) };
}

export const stepFailed = (s: ToolPair) => !!s.result?.isError;

/** How long a finished run took, from its first call to its last result ("12 s"); null while one runs or when a time is missing. */
export function runTook(steps: readonly ToolPair[]): string | null {
  if (!steps.length || steps.some((s) => !s.result)) return null;
  const from = Date.parse(steps[0]!.call.at);
  const to = Math.max(...steps.map((s) => Date.parse(s.result!.at)));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return formatSeconds(to - from);
}

/** Rows an opened activity shows before "Show N more". */
export const ACTIVITY_FIRST = 8;

/* ---------- Session runtime (the chat header's info line and sheet) ---------- */

const UNAVAILABLE = 'unavailable';

/** Percent of the context window used, as the portal's context ring rounds it; null when the window is not known. */
export const contextPct = (c: ReporterChatRuntime['context']): number | null => (c && c.windowTokens ? Math.min(100, Math.round((c.usedTokens / c.windowTokens) * 100)) : null);

/** The info line under the chat title: "Opus 5.5 · Work · 42%" (model · Claude · context), only what is known. */
export function runtimeLine(r: ReporterChatRuntime | undefined): string {
  if (!r) return '';
  const pct = contextPct(r.context);
  return [modelShortName(r.model), r.claude, pct !== null ? `${pct}%` : null].filter(Boolean).join(' · ');
}

/** "in 3h 05m", "in 12m", "now": until a reset time; null when there is none or it is not a time. */
export function resetsIn(iso: string | null, now = Date.now()): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const m = Math.max(0, Math.floor((t - now) / 60_000));
  if (m < 1) return 'now';
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `in ${Math.floor(h / 24)}d`;
}

const windowText = (w: ReporterUsageWindow | null, now: number) => {
  if (!w || w.usedPct === null) return UNAVAILABLE;
  const reset = resetsIn(w.resetsAt, now);
  return `${Math.round(w.usedPct)}%${reset ? ` · resets ${reset}` : ''}`;
};

/** The sheet's rows: every value the portal has, "unavailable" where it has none (never a guess). */
export function runtimeRows(r: ReporterChatRuntime | undefined, status: string, now = Date.now()): { label: string; value: string; tone?: 'danger' }[] {
  const ctx = r?.context ?? null;
  const pct = contextPct(ctx);
  const mode = r?.mode ? MODE_LABELS[r.mode] : null;
  return [
    { label: 'Status', value: status },
    { label: 'Model', value: r?.model ? `${modelShortName(r.model)}${r.effort ? ` · ${r.effort}` : ''}` : UNAVAILABLE },
    { label: 'Mode', value: mode?.label ?? UNAVAILABLE, ...(mode?.danger ? { tone: 'danger' as const } : {}) },
    { label: 'Claude', value: r?.claude ?? UNAVAILABLE },
    { label: 'Context', value: ctx ? (pct !== null && ctx.windowTokens ? `${pct}% · ${formatTokens(ctx.usedTokens)} of ${formatTokens(ctx.windowTokens)}` : `${formatTokens(ctx.usedTokens)} tokens`) : UNAVAILABLE },
    { label: 'Cost', value: r?.costUsd !== null && r?.costUsd !== undefined ? formatUsd(r.costUsd) : UNAVAILABLE },
    { label: 'Plan session', value: windowText(r?.plan?.session ?? null, now) },
    { label: 'Plan week', value: windowText(r?.plan?.week ?? null, now) },
  ];
}
