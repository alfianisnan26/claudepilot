import { cn, RowsSkeleton } from '@isnanme/ui';
import type { VaultSummary, VaultTreeEntry } from '@portal/contracts';
import { Bot, ChevronLeft, ChevronRight, File as FileIcon, FileText, Folder, Image as ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { formatBytes, timeAgo } from '@/lib/format';
import { knowledgeApi } from './api';
import { useLoad } from './hooks';
import { displayName } from './labels';

const MAX_ROWS = 300;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/** Folders and notes, one level at a time. */
export function NotesPane({
  vault,
  folder,
  tick,
  current,
  onFolder,
  onOpen,
}: {
  vault: VaultSummary;
  folder: string;
  tick: number;
  current: string;
  onFolder: (folder: string) => void;
  onOpen: (path: string) => void;
}) {
  const [shown, setShown] = useState(MAX_ROWS);
  const tree = useLoad(`tree|${vault.id}|${folder}|${tick}`, () => knowledgeApi.tree(vault.id, folder));
  const entries = tree.data?.entries ?? null;
  const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {folder && (
        <div className="flex shrink-0 items-center px-3 pb-1">
          <button type="button" onClick={() => onFolder(parent)} className="press flex min-w-0 flex-1 items-center gap-1 rounded-lg py-1.5 text-left text-[14px] font-semibold text-ink-soft hover:text-ink" aria-label="Up one folder">
            <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{folder}</span>
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 [scrollbar-width:thin]">
        {!entries ? (
          <RowsSkeleton rows={6} lines={1} />
        ) : entries.length === 0 ? (
          <p className="px-2 py-6 text-center text-[14px] text-muted">{vault.indexState === 'scanning' ? 'Indexing…' : 'Empty'}</p>
        ) : (
          <ul className="flex flex-col">
            {entries.slice(0, shown).map((e) => (
              <Row key={`${e.kind}|${e.path}`} entry={e} vault={vault} active={e.kind === 'note' && e.path === current} showFolder={false} onFolder={onFolder} onOpen={onOpen} />
            ))}
          </ul>
        )}
        {entries && entries.length > shown && (
          <button type="button" onClick={() => setShown((n) => n + MAX_ROWS)} className="press mt-1 w-full rounded-xl py-2 text-[13.5px] font-semibold text-muted hover:bg-surface-2">
            Show more ({entries.length - shown})
          </button>
        )}
      </div>
    </div>
  );
}

export function Row({ entry: e, vault, active, showFolder, onFolder, onOpen }: { entry: VaultTreeEntry; vault: VaultSummary; active: boolean; showFolder: boolean; onFolder: (f: string) => void; onOpen: (p: string) => void }) {
  const base = 'press flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left hover:bg-surface-2/70 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden';
  if (e.kind === 'folder')
    return (
      <li>
        <button type="button" onClick={() => onFolder(e.path)} className={base}>
          <Folder className="size-[18px] shrink-0 text-muted" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium">{e.name}</span>
          <span className="shrink-0 text-[12px] text-muted">{e.count}</span>
          <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden="true" />
        </button>
      </li>
    );
  if (e.kind === 'file') {
    const Icon = IMAGE.test(e.path) ? ImageIcon : FileIcon;
    return (
      <li>
        <a href={knowledgeApi.fileUrl(vault.id, e.path)} target="_blank" rel="noopener noreferrer" className={base}>
          <Icon className="size-[18px] shrink-0 text-muted" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[14.5px] text-ink-soft">{e.path.split('/').pop()}</span>
          <span className="shrink-0 text-[12px] text-muted">{e.size !== undefined ? formatBytes(e.size) : ''}</span>
        </a>
      </li>
    );
  }
  const folder = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
  return (
    <li>
      <button type="button" onClick={() => onOpen(e.path)} aria-current={active ? 'true' : undefined} className={cn(base, active && 'bg-surface-2')}>
        <FileText className="size-[18px] shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] font-medium">{displayName(e.name, e.title, vault.settings.labels)}</span>
          {showFolder && folder && <span className="block truncate text-[12px] text-muted">{folder}</span>}
        </span>
        {e.agent && <Bot className="size-3.5 shrink-0 text-muted" aria-label="Written by an agent" />}
        {e.mtime && <span className="shrink-0 text-[12px] text-muted">{timeAgo(e.mtime)}</span>}
      </button>
    </li>
  );
}
