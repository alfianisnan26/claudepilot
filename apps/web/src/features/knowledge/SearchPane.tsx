import { cn, RowsSkeleton } from '@isnanme/ui';
import type { NoteSearchHit, VaultSummary } from '@portal/contracts';
import { Row } from './NotesPane';
import { Bot, Search, X } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { knowledgeApi } from './api';
import { useLoad } from './hooks';
import { displayName } from './labels';

/** Text with the matched words marked (positions into the text, never markup). */
export function Marked({ text, marks }: { text: string; marks: [number, number][] }) {
  const out: React.ReactNode[] = [];
  let at = 0;
  marks.forEach(([s, e], i) => {
    if (s < at) return;
    out.push(<Fragment key={`t${i}`}>{text.slice(at, s)}</Fragment>);
    out.push(
      <mark key={`m${i}`} className="rounded bg-amber-400/30 text-inherit">
        {text.slice(s, e)}
      </mark>,
    );
    at = e;
  });
  out.push(<Fragment key="end">{text.slice(at)}</Fragment>);
  return <>{out}</>;
}

/** Full-text search with the filters the box understands: `tag:`, `folder:`, `"phrases"`, `-excluded`. */
export function SearchPane({ vault, q, tick, autoFocus, onQuery, onOpen }: { vault: VaultSummary; q: string; tick: number; autoFocus: boolean; onQuery: (q: string) => void; onOpen: (path: string) => void }) {
  const [text, setText] = useState(q);
  const [debounced, setDebounced] = useState(q);
  const input = useRef<HTMLInputElement>(null);
  // A query set from outside (a tag tapped elsewhere) replaces what is typed.
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(text);
      if (text !== q) onQuery(text);
    }, 200);
    return () => clearTimeout(t);
  }, [text, q, onQuery]);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const searching = debounced.trim().length > 0;
  const result = useLoad(`search|${vault.id}|${debounced}`, () => knowledgeApi.search(vault.id, debounced), searching);
  // An empty box shows what changed most recently.
  const recent = useLoad(`recent|${vault.id}|${tick}`, () => knowledgeApi.recent(vault.id), !searching);
  const hits = result.data?.hits ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 pt-2 pb-2">
        <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-3">
          <Search className="size-4 shrink-0 text-muted" aria-hidden="true" />
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="Search"
            placeholder="Search"
            className="h-11 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted sm:h-10 sm:text-[14.5px]"
          />
          {text && (
            <button type="button" aria-label="Clear" onClick={() => (setText(''), input.current?.focus())} className="press inline-flex size-7 items-center justify-center rounded-full text-muted hover:text-ink">
              <X className="size-4" />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 [scrollbar-width:thin]">
        {!searching ? (
          <ul className="flex flex-col">
            {(recent.data ?? []).map((e) => (
              <Row key={e.path} entry={e} vault={vault} active={false} showFolder onFolder={() => undefined} onOpen={onOpen} />
            ))}
          </ul>
        ) : result.loading && !result.data ? (
          <RowsSkeleton rows={4} lines={2} />
        ) : hits.length === 0 ? (
          <p className="px-2 py-6 text-center text-[14px] text-muted">No matches</p>
        ) : (
          <ul className="flex flex-col">
            {hits.map((h) => (
              <Hit key={h.path} hit={h} vault={vault} onOpen={onOpen} />
            ))}
            {result.data && result.data.total > hits.length && <li className="px-3 py-2 text-center text-[12.5px] text-muted">{result.data.total} matches</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

function Hit({ hit: h, vault, onOpen }: { hit: NoteSearchHit; vault: VaultSummary; onOpen: (p: string) => void }) {
  return (
    <li>
      <button type="button" onClick={() => onOpen(h.path)} className={cn('press flex w-full min-w-0 flex-col gap-0.5 rounded-xl px-2.5 py-2.5 text-left hover:bg-surface-2/70 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none')}>
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold">{displayName(h.name, h.title, vault.settings.labels)}</span>
          {h.agent && <Bot className="size-3.5 shrink-0 text-muted" aria-label="Written by an agent" />}
        </span>
        {h.folder && <span className="truncate text-[12px] text-muted">{h.folder}</span>}
        {h.snippet && h.snippet.text && (
          <span className="line-clamp-3 text-[13px] leading-snug text-ink-soft">
            <Marked text={h.snippet.text} marks={h.snippet.marks} />
          </span>
        )}
      </button>
    </li>
  );
}
