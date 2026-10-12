import { cn, ease } from '@isnanme/ui';
import { X } from 'lucide-react';
import { MotionConfig, motion } from 'motion/react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { NAV } from '@/app/nav';
import { pinnedToViewport, useVisualViewport } from '@/lib/viewport';
import { LevelDot } from '../../ui';
import { sessionLevel } from '../sessions/model';
import { actionItems, pageItems, sessionItems, ticketItems, workspaceItems } from './items';
import { closePalette } from './paletteStore';
import { searchPalette, ticketByNumber, type PaletteItem, type PaletteKind } from './search';
import { usePaletteData } from './usePaletteData';

/** What the trailing word of a row says. Actions and pages are what they look like; the things you search for are named. */
const KIND_WORD: Partial<Record<PaletteKind, string>> = { session: 'Session', workspace: 'Workspace', ticket: 'Ticket' };

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The quick search (Ctrl/Cmd+K, or the Shortcuts chip): sessions by title, workspaces, tickets, pages and actions in one list. The
 * keyboard does everything (type, arrows, Enter, Escape); a tap does the same. Loaded only when it opens.
 */
export default function Palette() {
  const navigate = useNavigate();
  const here = useLocation();
  const viewport = useVisualViewport();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const data = usePaletteData(query);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const q = query.trim();
  const byNumber = useMemo(() => ticketByNumber(q), [q]);
  const items = useMemo<PaletteItem[]>(
    () => [
      ...actionItems(here),
      ...pageItems(NAV),
      ...sessionItems(data.sessions ?? []),
      ...workspaceItems(data.workspaces ?? []),
      ...(byNumber ? [byNumber] : []),
      ...(data.tickets && data.tickets.forQuery === q ? ticketItems(data.tickets.items) : []),
    ],
    [here, data.sessions, data.workspaces, data.tickets, byNumber, q],
  );
  const results = useMemo(() => searchPalette(items, query), [items, query]);
  const current = Math.min(active, Math.max(0, results.length - 1));

  // Focus the field, keep the page behind from scrolling, and give focus back where it was.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    input.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = overflow;
      if (!document.activeElement || document.activeElement === document.body) before?.focus?.({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current, results]);

  const go = (item: PaletteItem | undefined) => {
    if (!item) return;
    navigate(item.to);
    closePalette();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (results.length) setActive((current + 1) % results.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (results.length) setActive((current - 1 + results.length) % results.length);
        break;
      case 'Home':
        if (e.target === input.current && !query) (e.preventDefault(), setActive(0));
        break;
      case 'End':
        if (e.target === input.current && !query) (e.preventDefault(), setActive(Math.max(0, results.length - 1)));
        break;
      case 'Enter':
        if (!e.nativeEvent.isComposing) (e.preventDefault(), go(results[current]));
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        closePalette();
        break;
      case 'Tab': {
        // Stays inside the dialog: the field and the close button.
        const stops = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.getClientRects().length > 0);
        const first = stops[0];
        const last = stops.at(-1);
        if (!first || !last) break;
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
        break;
      }
    }
  };

  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        className="fixed inset-x-0 top-0 z-50 h-dvh"
        style={pinnedToViewport(viewport)}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15, ease }}
      >
        <div className="absolute inset-0 bg-black/35" onClick={closePalette} aria-hidden="true" />
        <div className="relative flex h-full items-start justify-center p-3 sm:pt-24">
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            onKeyDown={onKeyDown}
            initial={{ y: -8 }}
            animate={{ y: 0 }}
            exit={{ y: -8 }}
            transition={{ duration: 0.18, ease }}
            className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-lift sm:max-h-96"
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-line pr-1 pl-4">
              <input
                ref={input}
                value={query}
                onChange={(e) => (setQuery(e.target.value), setActive(0))}
                role="combobox"
                aria-expanded={results.length > 0}
                aria-controls={listId}
                aria-activedescendant={results.length ? optionId(current) : undefined}
                aria-autocomplete="list"
                aria-label="Search"
                placeholder="Search"
                type="text"
                inputMode="search"
                enterKeyHint="go"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted"
              />
              <button type="button" onClick={closePalette} aria-label="Close search" className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink">
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <p role="status" className="sr-only">
              {results.length === 0 ? 'No matches' : `${results.length} ${results.length === 1 ? 'result' : 'results'}`}
            </p>
            {results.length === 0 && <p className="py-6 text-center text-sm text-muted">No matches.</p>}
            <ul ref={list} id={listId} role="listbox" aria-label="Results" hidden={results.length === 0} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
              {results.map((item, i) => (
                <li
                  key={item.id}
                  id={optionId(i)}
                  data-index={i}
                  role="option"
                  aria-selected={i === current}
                  onMouseMove={() => i !== current && setActive(i)}
                  onClick={() => go(item)}
                  className={cn('flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-2', i === current && 'bg-surface-2 outline-2 -outline-offset-2 outline-ink')}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    {item.hint && (
                      <span className="flex items-center gap-1.5 text-xs text-muted">
                        {item.kind === 'session' && <LevelDot level={sessionLevel(item.state ?? 'idle')} />}
                        <span className="min-w-0 truncate">{item.hint}</span>
                      </span>
                    )}
                  </span>
                  {KIND_WORD[item.kind] && <span className="shrink-0 text-xs text-muted">{KIND_WORD[item.kind]}</span>}
                </li>
              ))}
            </ul>
          </motion.div>
        </div>
      </motion.div>
    </MotionConfig>
  );
}
