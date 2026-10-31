import { cn } from '@isnanme/ui';
import type { ChatEvent } from '@portal/contracts';
import {
  Bot,
  ChevronRight,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  Layers,
  Lightbulb,
  ListChecks,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { InputBlock, OutputBlock } from './CodeBlock';
import { isCut } from './history';
import { ImageThumbs, type ViewerImage } from './ImageViewer';
import { visibly } from './shellTokens';
import { exitStatus, inputView } from './toolFormat';
import { buildRows, formatSeconds, groupLabel, shortTarget, toolKind, toolLabel, type ToolKind, type ToolPair, type TranscriptRow } from './toolModel';

export type { ToolPair, TranscriptRow };
export { buildRows, formatSeconds, groupLabel, shortTarget };

/** Reads one cut tool result whole (T-376): the transcript's, null where results are always whole (a sub-agent's own transcript). */
export const LoadWholeContext = createContext<((seq: number) => Promise<void>) | null>(null);

/** A tool's icon by its kind (toolModel.ts, shared with the reporter panel): what it does, at a glance. */
const KIND_ICON: Record<ToolKind, LucideIcon> = {
  run: SquareTerminal,
  read: FileText,
  write: FilePen,
  search: Search,
  list: FolderOpen,
  web: Globe,
  agent: Bot,
  todo: ListChecks,
  mcp: Plug,
  other: Wrench,
};
export const toolIcon = (name: string | undefined): LucideIcon => KIND_ICON[toolKind(name)];

export { toolLabel };

/** Rows opened or closed by a tap, by row: kept while the page lives, so a row that leaves the page and comes back is as it was left. */
const tapped = new Map<string, { open: boolean; details: boolean }>();

/** A row's key for {@link useOpen}: the call's id, or its place in the transcript. */
export const rowKey = (e: ChatEvent) => e.toolUseId ?? `${e.seq}@${e.at}`;

/**
 * A row's open state: open by `details` (Show all details) or its own default, until it's tapped; a change of `details` resets taps, so
 * Show all details and Show less apply to every row. With `key`, a tap is remembered for the page's life (chat PRD FR7).
 */
function useOpen(details: boolean, byDefault: boolean, key?: string): [boolean, () => void] {
  const [tap, setTap] = useState<{ open: boolean; details: boolean } | null>(() => (key ? (tapped.get(key) ?? null) : null));
  const seen = useRef(details);
  useEffect(() => {
    if (seen.current === details) return;
    seen.current = details;
    if (key) tapped.delete(key);
    setTap(null);
  }, [details, key]);
  const open = tap && tap.details === details ? tap.open : details || byDefault;
  return [
    open,
    () => {
      const next = { open: !open, details };
      if (key) tapped.set(key, next);
      setTap(next);
    },
  ];
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
    'flex max-w-full min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-left text-[14px] sm:text-[13px]',
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
 * One tool call: its name and one-line summary (a command, a path), then, opened, two blocks (chat PRD FR7): Input, what it was given
 * (a command coloured as shell with its real line breaks, an edit's lines, a path and range, an MCP tool's JSON), and Output, what it
 * returned (long output shows its ends and "Show all"), with any images. Closed by default; a failure opens, in the danger tone (its
 * turn's activity row counts it), and so do returned images. `running` marks a call still waiting for its result.
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
  const Icon = toolIcon(call.toolName);
  const [open, toggle] = useOpen(details, images.length > 0 || error, rowKey(call));
  const id = useId();
  const output = result?.text?.replace(/\s+$/, '') ?? '';
  const input = useMemo(() => inputView(call.toolName, call.toolInput, call.text, call.toolInputCut), [call.toolName, call.toolInput, call.text, call.toolInputCut]);
  const hasInput = !!(input.code || input.diff || input.path || input.facts.length);
  const expandable = !!(hasInput || output || images.length);
  // A page cut a long result to its preview (T-376): Output shows it with the whole size, and reads the whole when a person asks.
  const loadWhole = useContext(LoadWholeContext);
  const cut = result && loadWhole && isCut(result) ? { length: result.textLength!, load: () => loadWhole(result.seq) } : undefined;
  return (
    <div className="flex max-w-full flex-col items-start">
      <RowButton open={open} onToggle={toggle} controls={id} expandable={expandable} danger={error}>
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {/* A call still waiting for its result is a quiet shimmer on its name, not a spinner. */}
        <span className={cn('shrink-0 font-mono', running && !result && 'shimmer')}>{call.toolName ? toolLabel(call.toolName) : 'tool'}</span>
        {call.text && <span className="min-w-0 truncate font-mono text-muted">{shortTarget(visibly(call.text))}</span>}
        {agent && <span className="shrink-0 truncate text-muted/80">· {agent}</span>}
        {running && !result && <span className="sr-only">(running)</span>}
        {error && <span className="sr-only">(failed)</span>}
      </RowButton>
      {open && expandable && (
        <div id={id} className="mt-1 ml-5 flex w-[calc(100%-1.25rem)] min-w-0 flex-col gap-2">
          {hasInput && <InputBlock view={input} />}
          {(output || hasInput) && (
            <OutputBlock
              text={output}
              error={error}
              exit={error ? exitStatus(output) : null}
              empty={result ? 'No output.' : running ? 'Running…' : 'No result.'}
              cut={cut}
            />
          )}
          {images.length > 0 && <ImageThumbs images={images} actions />}
        </div>
      )}
    </div>
  );
}

/** A run of read-only calls as one row ("3 files read · 2 searches"), opening to each call. */
export function ToolGroup({ tools, agent, running, details, render }: { tools: ToolPair[]; agent: string | null; running: boolean; details: boolean; render: (t: ToolPair) => ReactNode }) {
  const [open, toggle] = useOpen(details, false, `g:${rowKey(tools[0]!.call)}`);
  const id = useId();
  const pending = running && tools.some((t) => !t.result);
  return (
    <div className="flex max-w-full flex-col items-start">
      <RowButton open={open} onToggle={toggle} controls={id} expandable>
        <Layers className="size-3.5 shrink-0" aria-hidden="true" />
        <span className={cn('truncate', pending && 'shimmer')}>{groupLabel(tools)}</span>
        {agent && <span className="shrink-0 truncate text-muted/80">· {agent}</span>}
        {pending && <span className="sr-only">(running)</span>}
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
    <div role="status" className="flex items-center gap-1.5 text-[15.5px] sm:text-[14.5px]">
      {/* Read once ("Thinking"), not every second as the count changes. */}
      <span className="sr-only">Thinking</span>
      <span aria-hidden="true" className="shimmer">
        Thinking… {formatSeconds(Math.max(0, now - since))}
      </span>
      {agent && <span className="truncate text-muted/80">· {agent}</span>}
    </div>
  );
}
