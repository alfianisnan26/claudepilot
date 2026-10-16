import { Dialog } from '@isnanme/ui';
import type { VaultSummary } from '@portal/contracts';
import { File as FileIcon, FileText, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { knowledgeApi } from './api';
import { useLoad } from './hooks';

/** Jump to a note by a few letters of its name, an alias or its path (Ctrl or Cmd + K). */
export function QuickSwitcher({ open, vault, onClose, onOpen }: { open: boolean; vault: VaultSummary; onClose: () => void; onOpen: (path: string) => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 90);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (open) {
      setQ('');
      setDebounced('');
      setAt(0);
      setTimeout(() => input.current?.focus(), 30);
    }
  }, [open]);
  const hits = useLoad(`quick|${vault.id}|${debounced}`, () => knowledgeApi.quick(vault.id, debounced), open);
  const list = hits.data ?? [];
  const go = (path: string) => {
    onClose();
    onOpen(path);
  };
  return (
    <Dialog open={open} onClose={onClose} title="Open" size="sm">
      <div className="-mt-1 flex items-center gap-2 rounded-xl bg-surface-2 px-3">
        <Search className="size-4 shrink-0 text-muted" aria-hidden="true" />
        <input
          ref={input}
          value={q}
          onChange={(e) => (setQ(e.target.value), setAt(0))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setAt((i) => Math.min(list.length - 1, i + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setAt((i) => Math.max(0, i - 1)));
            else if (e.key === 'Enter' && list[at]) go(list[at]!.path);
          }}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Note name"
          placeholder="Note name"
          className="h-11 min-w-0 flex-1 bg-transparent text-[16px] outline-hidden placeholder:text-muted"
        />
      </div>
      <ul className="mt-2 max-h-[50dvh] overflow-y-auto" role="listbox">
        {list.map((h, i) => (
          <li key={h.path} role="option" aria-selected={i === at}>
            <button type="button" onClick={() => go(h.path)} className={`press flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left ${i === at ? 'bg-surface-2' : 'hover:bg-surface-2/70'}`}>
              {h.kind === 'note' ? <FileText className="size-4 shrink-0 text-muted" aria-hidden="true" /> : <FileIcon className="size-4 shrink-0 text-muted" aria-hidden="true" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14.5px] font-medium">{h.alias ? `${h.alias} → ${h.name}` : h.name}</span>
                {h.path.includes('/') && <span className="block truncate text-[12px] text-muted">{h.path.slice(0, h.path.lastIndexOf('/'))}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
