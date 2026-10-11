import { Button, buttonClass, cn, ease, Segmented } from '@isnanme/ui';
import { CHAT_MAX_DOWNLOAD_BYTES, type ChatFileEntry, type ChatFolder } from '@portal/contracts';
import { ChevronRight, CornerLeftUp, Download, File, FileQuestion, FileSymlink, Folder, FolderOpen, RefreshCw, X } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useEffect, useId, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { errorText } from '@/lib/api';
import { chatApi } from './api';
import { DiffView, useReturnRefresh } from './DiffView';
import { HOME, useModal } from './shared';

export type FilesTab = 'files' | 'changes';

/** What the Files panel shows, kept by the page so it survives closing and reopening the panel. */
export interface FilesView {
  tab: FilesTab;
  /** The folder open in Files; null for the session's own folder. */
  path: string | null;
  /** The session's folder, once the first listing named it: where the breadcrumb starts. */
  root: string | null;
}

export const INITIAL_FILES_VIEW: FilesView = { tab: 'files', path: null, root: null };

const TABS: { value: FilesTab; label: string }[] = [
  { value: 'files', label: 'Files' },
  { value: 'changes', label: 'Changes' },
];

/** "/home/node/proj" reads "~/proj". */
export const tildify = (path: string) => (path === HOME ? '~' : path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path);

const within = (path: string, dir: string) => path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`);
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

/** "850 B", "12 KB", "3.4 MB" (decimal units, like the 50 MB download limit). */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 999.5 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 9.95 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? '1 day ago' : `${d} days ago`;
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

interface FilesPanelProps {
  sessionId: string;
  view: FilesView;
  onView: Dispatch<SetStateAction<FilesView>>;
  onClose: () => void;
}

/**
 * The session's workspace folder and what changed in it: Files browses the folder (tap a folder to
 * open it, a file to download it) and Changes shows the git diff. The same content fills the side
 * panel on wide screens and the sheet below them. Each tab loads when first shown and then stays,
 * refreshing in place when you come back to it.
 */
export function FilesPanel({ sessionId, view, onView, onClose, closeLabel, titleId }: FilesPanelProps & { closeLabel: string; titleId?: string }) {
  const [seen, setSeen] = useState<Record<FilesTab, boolean>>({ files: view.tab === 'files', changes: view.tab === 'changes' });
  if (!seen[view.tab]) setSeen({ ...seen, [view.tab]: true }); // first time on this tab: mount it in this same render
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-semibold">
            Files
          </h2>
          <p className="truncate font-mono text-[11px] text-muted">{view.root ? tildify(view.root) : 'The session’s folder'}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink tap:size-11"
        >
          <X className="size-[18px]" />
        </button>
      </div>
      <div className="shrink-0 px-3 pt-3 pb-1">
        <Segmented label="Show" value={view.tab} options={TABS} onChange={(tab) => onView((v) => ({ ...v, tab }))} />
      </div>
      <div className="relative min-h-0 flex-1">
        {seen.files && <FolderView sessionId={sessionId} view={view} onView={onView} active={view.tab === 'files'} />}
        {seen.changes && <DiffView sessionId={sessionId} active={view.tab === 'changes'} />}
      </div>
    </div>
  );
}

const ROW = 'flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left';
const ROW_ACTION = cn(ROW, 'hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-offset-[-2px]');

/** The Files tab: a breadcrumb from the session's folder, then folders and files. */
function FolderView({ sessionId, view, onView, active }: Omit<FilesPanelProps, 'onClose'> & { active: boolean }) {
  const [folder, setFolder] = useState<ChatFolder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  /** The link that was opened as a folder, so a failure can offer to download it instead. */
  const [via, setVia] = useState<ChatFileEntry | null>(null);
  const { path, root } = view;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    chatApi.files(sessionId, path ?? undefined).then(
      (f) => {
        if (!alive) return;
        setFolder(f);
        setLoading(false);
        if (path === null) onView((v) => (v.root === f.path ? v : { ...v, root: f.path }));
      },
      (e: unknown) => {
        if (!alive) return;
        setError(errorText(e, 'Couldn’t open that folder.'));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [sessionId, path, reload, onView]);

  useReturnRefresh(active, () => setReload((n) => n + 1));

  const go = (to: string, link: ChatFileEntry | null = null) => {
    setVia(link);
    onView((v) => ({ ...v, path: to }));
  };
  const at = path ?? root;
  const shown = folder && (path === null || folder.path === path) ? folder : null;
  const atRoot = at === null || root === null || at === root;
  const up = !atRoot && at && root && within(at, root) ? parentOf(at) : null;

  return (
    <section hidden={!active} aria-label="Files" className="absolute inset-0 flex flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line py-1.5 pr-2 pl-2">
        <button
          type="button"
          disabled={!up}
          onClick={() => up && go(up)}
          aria-label="Up one folder"
          title="Up one folder"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink disabled:pointer-events-none disabled:opacity-35 tap:size-11"
        >
          <CornerLeftUp className="size-4" />
        </button>
        <Breadcrumb path={at} root={root} onGo={(p) => go(p)} />
        <button
          type="button"
          onClick={() => setReload((n) => n + 1)}
          aria-label="Refresh"
          title="Refresh"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink tap:size-11"
        >
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={loading || undefined}>
        {error ? (
          <div role="alert" className="m-4 rounded-2xl border border-line bg-surface p-4">
            <p className="text-[13.5px] text-ink-soft">{error}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setReload((n) => n + 1)}>
                Try again
              </Button>
              {via && via.path === at && (
                <a href={chatApi.downloadUrl(sessionId, via.path)} download={via.name} className={buttonClass('secondary', 'sm')}>
                  <Download className="size-4" aria-hidden="true" />
                  Download instead
                </a>
              )}
              {up && (
                <Button size="sm" variant="secondary" onClick={() => go(up)}>
                  Back
                </Button>
              )}
              {atRoot && root !== HOME && (
                <Button size="sm" variant="secondary" onClick={() => onView((v) => ({ ...v, path: HOME, root: HOME }))}>
                  Open the home folder
                </Button>
              )}
            </div>
          </div>
        ) : !shown ? (
          <ListSkeleton />
        ) : shown.entries.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-ink-soft">
              <FolderOpen className="size-6" />
            </span>
            <p className="mt-4 text-sm font-semibold">This folder is empty</p>
          </div>
        ) : (
          <>
            <ul className={cn('divide-y divide-line', loading && 'opacity-60 transition-opacity')}>
              {shown.entries.map((e) => (
                <EntryRow key={e.name} entry={e} sessionId={sessionId} onOpen={(entry) => go(entry.path, entry.type === 'symlink' ? entry : null)} />
              ))}
            </ul>
            {shown.truncated && <p className="px-4 py-3 text-center text-[12px] text-muted">Showing the first {shown.entries.length} items.</p>}
          </>
        )}
      </div>
    </section>
  );
}

/** Where you are, from the session's folder: each crumb opens its folder; the last is where you are. */
function Breadcrumb({ path, root, onGo }: { path: string | null; root: string | null; onGo: (path: string) => void }) {
  const ref = useRef<HTMLOListElement>(null);
  // Keep the deepest folder in view on narrow screens.
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path]);
  if (!path) return <div className="min-w-0 flex-1 px-1 text-[13px] text-muted">…</div>;
  const base = root && within(path, root) ? root : '/';
  const crumbs = [{ label: base === '/' ? '/' : base === HOME ? '~' : base.slice(base.lastIndexOf('/') + 1), path: base }];
  let acc = base;
  for (const part of path.slice(base.length).split('/').filter(Boolean)) {
    acc = acc === '/' ? `/${part}` : `${acc}/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return (
    <nav aria-label="Folder" className="min-w-0 flex-1">
      <ol ref={ref} className="no-scrollbar flex items-center overflow-x-auto font-mono text-[13px] whitespace-nowrap">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={c.path} className="flex shrink-0 items-center">
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted/70" aria-hidden="true" />}
              {last ? (
                <span aria-current="page" title={c.path} className="px-1.5 py-1 font-semibold text-ink">
                  {c.label}
                </span>
              ) : (
                <button type="button" onClick={() => onGo(c.path)} title={c.path} className="rounded-md px-1.5 py-1 text-muted hover:bg-surface-2 hover:text-ink">
                  {c.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const ENTRY_ICON: Record<ChatFileEntry['type'], typeof File> = { dir: Folder, file: File, symlink: FileSymlink, other: FileQuestion };

/** One entry: a folder or link opens, a file downloads; anything else (or too large) just reads. */
function EntryRow({ entry: e, sessionId, onOpen }: { entry: ChatFileEntry; sessionId: string; onOpen: (e: ChatFileEntry) => void }) {
  const Icon = ENTRY_ICON[e.type] ?? FileQuestion;
  const tooLarge = e.type === 'file' && e.size !== null && e.size > CHAT_MAX_DOWNLOAD_BYTES;
  const meta = [
    e.type === 'file' && e.size !== null && formatSize(e.size),
    tooLarge && 'too large to download',
    e.type === 'symlink' && 'link',
    e.type === 'other' && 'special file',
  ].filter((m): m is string => !!m);
  const body = (trailing?: ReactNode) => (
    <>
      <Icon className={cn('size-[18px] shrink-0', e.type === 'dir' ? 'text-ink-soft' : 'text-muted')} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{e.name}</span>
        <span className="block truncate text-[11.5px] text-muted tabular-nums">
          {meta.join(' · ')}
          {meta.length > 0 && e.modifiedAt && ' · '}
          {e.modifiedAt && (
            <time dateTime={e.modifiedAt} title={new Date(e.modifiedAt).toLocaleString()}>
              {relativeTime(e.modifiedAt)}
            </time>
          )}
        </span>
      </span>
      {trailing}
    </>
  );
  if (e.type === 'dir' || e.type === 'symlink') {
    return (
      <li>
        <button type="button" onClick={() => onOpen(e)} title={e.name} className={ROW_ACTION}>
          {body(<ChevronRight className="size-4 shrink-0 text-muted/70" aria-hidden="true" />)}
        </button>
      </li>
    );
  }
  if (e.type === 'file' && !tooLarge) {
    return (
      <li>
        <a href={chatApi.downloadUrl(sessionId, e.path)} download={e.name} title={`Download ${e.name}`} className={ROW_ACTION}>
          {body(<Download className="size-4 shrink-0 text-muted" aria-hidden="true" />)}
          <span className="sr-only">Download</span>
        </a>
      </li>
    );
  }
  return (
    <li>
      <div title={e.name} className={ROW}>
        {body()}
      </div>
    </li>
  );
}

function ListSkeleton() {
  return (
    <ul aria-busy="true" aria-label="Loading" className="divide-y divide-line">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className={ROW}>
          <span className="skeleton size-[18px] shrink-0 rounded" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className={cn('skeleton h-3.5 rounded-full', i % 2 ? 'w-2/5' : 'w-3/5')} />
            <span className="skeleton h-2.5 w-1/4 rounded-full" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The Files panel below 1280 px: full screen on phones, a sheet from the right from 640 px.
 * A modal: focus moves in, Escape or × closes, and focus returns to the Files button (⋯ on phones).
 */
export function FilesSheet({ open, ...props }: FilesPanelProps & { open: boolean }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <MotionConfig reducedMotion="user">
      <AnimatePresence>{open && <Sheet key="files" {...props} />}</AnimatePresence>
    </MotionConfig>,
    document.body,
  );
}

function Sheet(props: FilesPanelProps) {
  const ref = useModal<HTMLDivElement>(props.onClose);
  const titleId = useId();
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <motion.div
        className="absolute inset-0 bg-black/35"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={props.onClose}
        aria-hidden="true"
      />
      <motion.div
        ref={ref}
        id="files-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%', transition: { duration: 0.18, ease } }}
        transition={{ duration: 0.24, ease }}
        className="relative flex h-full w-full flex-col bg-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-lift outline-none sm:w-[400px] sm:border-l sm:border-line"
      >
        <FilesPanel {...props} closeLabel="Close files" titleId={titleId} />
      </motion.div>
    </div>
  );
}
