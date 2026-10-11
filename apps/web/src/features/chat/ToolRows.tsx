import { cn, Spinner } from '@isnanme/ui';
import type { ChatEvent } from '@portal/contracts';
import { ChevronRight, CircleAlert, Layers, Lightbulb, Wrench } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { ImageThumbs, type ViewerImage } from './ImageViewer';

/** A tool call and its result (null while it runs, or when the result never came). */
export interface ToolPair {
  call: ChatEvent;
  result: ChatEvent | null;
}

/** One line of the transcript: a stored event, a tool call with its result, a run of read-only calls, or thinking. */
export type TranscriptRow =
  | { type: 'event'; event: ChatEvent }
  | ({ type: 'tool' } & ToolPair)
  | { type: 'group'; tools: ToolPair[] }
  | { type: 'thinking'; event: ChatEvent };

/** Tools that only look: a run of two or more of them reads as one row (chat PRD FR5). */
const READ_ONLY = new Set(['Read', 'NotebookRead', 'Glob', 'LS', 'Grep', 'WebFetch', 'WebSearch', 'TodoRead']);
/**
 * Bash commands that plainly only look (Claude Code finds and searches files with Bash): a known
 * reading command with no redirect or chaining. Display only: a wrong guess just folds a row.
 */
const LOOK_COMMAND = /^(ls|cat|head|tail|grep|rg|find|wc|pwd|tree|stat|file|du|which|git (status|log|diff|show|branch))(\s|$)/;
const isReadOnly = (call: ChatEvent) =>
  READ_ONLY.has(call.toolName ?? '') || (call.toolName === 'Bash' && !!call.text && LOOK_COMMAND.test(call.text) && !/[;&>`]|\$\(/.test(call.text));

/** "mcp__playwright__browser_take_screenshot" reads "playwright · browser_take_screenshot". */
export const toolLabel = (name: string) => (name.startsWith('mcp__') ? name.slice(5).split('__').filter(Boolean).join(' · ') : name);

/**
 * The transcript's rows from its events. Each result joins its call (by the call's id; a result stored
 * without one joins the oldest open call from the same agent). A result with no call to join shows on
 * its own only when it returned images. With `group`, runs of two or more read-only calls from one agent
 * fold into one row; a call that failed or returned images stays out, because it shows open.
 */
export function buildRows(events: ChatEvent[], group: boolean): TranscriptRow[] {
  const callsById = new Map<string, ChatEvent>();
  const resultOf = new Map<number, ChatEvent>(); // call seq → its result
  const joined = new Set<number>(); // result seqs shown with their call
  const open = new Map<string, ChatEvent[]>(); // agent → its calls, in order
  for (const e of events) {
    const agent = e.agentLabel ?? '';
    if (e.kind === 'tool_use') {
      if (e.toolUseId) callsById.set(e.toolUseId, e);
      const calls = open.get(agent);
      if (calls) calls.push(e);
      else open.set(agent, [e]);
    } else if (e.kind === 'tool_result') {
      // Results stored before calls' ids were kept on them have none: they take the oldest open call.
      const call = e.toolUseId ? callsById.get(e.toolUseId) : open.get(agent)?.find((c) => !resultOf.has(c.seq));
      if (call && !resultOf.has(call.seq)) {
        resultOf.set(call.seq, e);
        joined.add(e.seq);
      }
    }
  }
  // Only results without an id scan an agent's calls, and only rows stored before ids were kept lack one.

  const rows: TranscriptRow[] = [];
  for (const e of events) {
    if (e.kind === 'tool_use') rows.push({ type: 'tool', call: e, result: resultOf.get(e.seq) ?? null });
    else if (e.kind === 'tool_result') {
      if (!joined.has(e.seq) && e.images?.length) rows.push({ type: 'event', event: e });
    } else if (e.kind === 'thinking') rows.push({ type: 'thinking', event: e });
    else if (e.kind !== 'request') rows.push({ type: 'event', event: e }); // requests drive the approvals dock
  }
  if (!group) return rows;

  const out: TranscriptRow[] = [];
  let run: ToolPair[] = [];
  let runAgent: string | null = null;
  const flush = () => {
    if (run.length >= 2) out.push({ type: 'group', tools: run });
    else for (const t of run) out.push({ type: 'tool', ...t });
    run = [];
  };
  for (const r of rows) {
    const groupable = r.type === 'tool' && isReadOnly(r.call) && !r.result?.isError && !r.result?.images?.length;
    if (!groupable) {
      flush();
      out.push(r);
      continue;
    }
    const agent = r.call.agentLabel ?? null;
    if (run.length && agent !== runAgent) flush();
    if (!run.length) runAgent = agent;
    run.push({ call: r.call, result: r.result });
  }
  flush();
  return out;
}

/** "3 files read · 2 searches": what a run of read-only calls did. */
const NOUNS: Record<string, [string, string]> = {
  Read: ['file read', 'files read'],
  NotebookRead: ['notebook read', 'notebooks read'],
  Glob: ['listing', 'listings'],
  LS: ['listing', 'listings'],
  Grep: ['search', 'searches'],
  WebFetch: ['page fetched', 'pages fetched'],
  WebSearch: ['web search', 'web searches'],
  TodoRead: ['to-do check', 'to-do checks'],
  Bash: ['command', 'commands'],
};
function groupLabel(tools: ToolPair[]): string {
  const counts = new Map<string, number>();
  for (const { call } of tools) {
    const noun = NOUNS[call.toolName ?? '']?.join('|') ?? 'step|steps';
    counts.set(noun, (counts.get(noun) ?? 0) + 1);
  }
  return [...counts].map(([noun, n]) => `${n} ${noun.split('|')[n === 1 ? 0 : 1]}`).join(' · ');
}

/** "12 s", "2 min 5 s". */
export function formatSeconds(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

/**
 * A row's open state: open by `details` (Show all details) or its own default, until it's tapped; a
 * change of `details` resets taps, so Show all details and Show less apply to every row.
 */
function useOpen(details: boolean, byDefault: boolean): [boolean, () => void] {
  const [tapped, setTapped] = useState<boolean | null>(null);
  useEffect(() => setTapped(null), [details]);
  const open = tapped ?? (details || byDefault);
  return [open, () => setTapped(!open)];
}

/** The row's line: an icon, what it is, and a chevron when there's more to see. */
function RowButton({
  open,
  onToggle,
  controls,
  expandable,
  danger,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  expandable: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  const cls = cn(
    'flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[12px]',
    danger ? 'text-danger' : 'text-ink-soft',
  );
  if (!expandable) return <div className={cls}>{children}</div>;
  return (
    <button type="button" aria-expanded={open} aria-controls={open ? controls : undefined} onClick={onToggle} className={cn(cls, 'press hover:bg-surface-2')}>
      {children}
      <ChevronRight className={cn('size-3.5 shrink-0 opacity-60 transition-transform', open && 'rotate-90')} aria-hidden="true" />
    </button>
  );
}

/**
 * One tool call: its name and one-line summary (a command, a path), then, opened, the summary in full
 * and what the tool returned (text, kept short by the portal, and images). A failure shows open and in
 * the danger tone, and so do returned images. `running` marks a call still waiting for its result.
 */
export function ToolCall({
  call,
  result,
  agent,
  running,
  details,
  images,
}: ToolPair & { agent: string | null; running: boolean; details: boolean; images: ViewerImage[] }) {
  const error = !!result?.isError;
  const [open, toggle] = useOpen(details, error || images.length > 0);
  const id = useId();
  const output = result?.text?.trim() ?? '';
  const expandable = !!(call.text || output || images.length);
  return (
    <div className="flex max-w-full flex-col items-start">
      <RowButton open={open} onToggle={toggle} controls={id} expandable={expandable} danger={error}>
        {error ? <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" /> : <Wrench className="size-3.5 shrink-0" aria-hidden="true" />}
        <span className="shrink-0 font-mono">{call.toolName ? toolLabel(call.toolName) : 'tool'}</span>
        {call.text && <span className="min-w-0 truncate font-mono text-muted">{call.text}</span>}
        {agent && <span className="shrink-0 truncate text-muted/80">· {agent}</span>}
        {running && !result && <Spinner className="size-3 shrink-0" />}
        {error && <span className="sr-only">(failed)</span>}
      </RowButton>
      {open && expandable && (
        <div id={id} className="mt-1 ml-5 flex w-[calc(100%-1.25rem)] flex-col gap-2">
          {(call.text || output) && (
            <div className={cn('overflow-hidden rounded-lg border text-[12px]', error ? 'border-danger/30 bg-danger-soft' : 'border-line bg-surface-2/50')}>
              {/* The summary in full where the row can't show it all: commands, and anything long. */}
              {call.text && (call.toolName === 'Bash' || call.text.length > 48) && (
                <p className="border-b border-line/70 px-3 py-1.5 font-mono break-all text-ink-soft">{call.text}</p>
              )}
              {output ? (
                <pre className={cn('max-h-60 overflow-auto px-3 py-2 font-mono leading-relaxed break-words whitespace-pre-wrap', error ? 'text-danger' : 'text-ink')}>
                  {output}
                </pre>
              ) : (
                <p className="px-3 py-1.5 text-muted">{result ? 'No output.' : running ? 'Running…' : 'No result.'}</p>
              )}
            </div>
          )}
          {images.length > 0 && <ImageThumbs images={images} />}
        </div>
      )}
    </div>
  );
}

/** A run of read-only calls as one row ("3 files read · 2 searches"), opening to each call. */
export function ToolGroup({ tools, agent, running, details, render }: { tools: ToolPair[]; agent: string | null; running: boolean; details: boolean; render: (t: ToolPair) => ReactNode }) {
  const [open, toggle] = useOpen(details, false);
  const id = useId();
  const pending = running && tools.some((t) => !t.result);
  return (
    <div className="flex max-w-full flex-col items-start">
      <RowButton open={open} onToggle={toggle} controls={id} expandable>
        <Layers className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{groupLabel(tools)}</span>
        {agent && <span className="shrink-0 truncate text-muted/80">· {agent}</span>}
        {pending && <Spinner className="size-3 shrink-0" />}
      </RowButton>
      {open && (
        <div id={id} className="mt-0.5 ml-2 flex w-[calc(100%-0.5rem)] flex-col gap-0.5 border-l border-line pl-2">
          {tools.map(render)}
        </div>
      )}
    </div>
  );
}

/** A finished thinking block: "Thought for 12 s", opening to the reasoning (redacted thinking has none). */
export function ThinkingRow({ event, agent, details }: { event: ChatEvent; agent: string | null; details: boolean }) {
  const [open, toggle] = useOpen(details, false);
  const id = useId();
  const text = event.text?.trim() ?? '';
  // Under a second usually means the portal read the block late (after a restart, say): no time then.
  const label = event.durationMs !== undefined && event.durationMs >= 1000 ? `Thought for ${formatSeconds(event.durationMs)}` : 'Thought';
  return (
    <div className="flex max-w-full flex-col items-start">
      <RowButton open={open} onToggle={toggle} controls={id} expandable={!!text}>
        <Lightbulb className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{label}</span>
        {agent && <span className="shrink-0 truncate text-muted/80">· {agent}</span>}
      </RowButton>
      {open && text && (
        <div id={id} className="mt-1 ml-5 border-l-2 border-line pl-3 text-[13px] leading-relaxed whitespace-pre-wrap text-muted">
          {text}
        </div>
      )}
    </div>
  );
}

/** A thinking block still open: "Thinking… 4 s", counting from when this tab heard it start. */
export function LiveThinking({ since, agent }: { since: number; agent: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div role="status" className="flex items-center gap-1.5 px-1 text-[12px] text-ink-soft">
      <Spinner className="size-3 shrink-0" />
      <span>Thinking… {formatSeconds(Math.max(0, now - since))}</span>
      {agent && <span className="truncate text-muted/80">· {agent}</span>}
    </div>
  );
}
