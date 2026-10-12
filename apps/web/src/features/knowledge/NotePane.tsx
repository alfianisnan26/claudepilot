import { ConfirmDialog, copyText, Menu, RowsSkeleton, useToast, type MenuItem } from '@isnanme/ui';
import type { NoteView, VaultSummary } from '@portal/contracts';
import { AlertTriangle, ArrowLeft, Bot, Check, ExternalLink, Eye, History, Link2, Loader2, PanelRight, Pencil, TextCursorInput, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@isnanme/ui';
import { InfoTip } from '@/components/InfoTip';
import { knowledgeApi, errorText } from './api';
import { HistoryDialog, NoteNameDialog } from './dialogs';
import type { NoteEnv } from './env';
import { useLoad, useRefresh } from './hooks';
import { displayName, obsidianUrl } from './labels';
import { NoteEditor, type EditorHandle, type EditStatus } from './NoteEditor';
import { NoteMarkdown } from './NoteMarkdown';
import { headingId } from './remarkObsidian';

type Env = Pick<NoteEnv, 'href' | 'open' | 'create' | 'tag' | 'entityHref'>;

/** The open note: a preview or the editor, with its title bar and menu. */
export function NotePane({
  vault,
  path,
  edit,
  tick,
  scroll,
  env,
  onBack,
  onEdit,
  onPanel,
  panelOpen,
  onLoaded,
  onChanged,
  onRenamed,
  onDeleted,
}: {
  vault: VaultSummary;
  path: string;
  edit: boolean;
  tick: number;
  /** Scroll to this heading when `n` changes. */
  scroll: { heading: string; n: number } | null;
  env: Env;
  /** Phone: back to the list. */
  onBack: (() => void) | null;
  onEdit: (on: boolean) => void;
  /** The links and outline panel: a sheet below 1280 px, a column above. */
  onPanel: () => void;
  panelOpen: boolean;
  onLoaded: (note: NoteView | null) => void;
  onChanged: () => void;
  onRenamed: (path: string) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const editor = useRef<EditorHandle>(null);
  const [status, setStatus] = useState<EditStatus>('saved');
  const [renaming, setRenaming] = useState(false);
  const [history, setHistory] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const note = useLoad(`note|${vault.id}|${path}|${tick}`, () => knowledgeApi.note(vault.id, path));
  const view = note.data;

  useEffect(() => onLoaded(view), [view, onLoaded]);
  useRefresh(() => void note.reload(), 15_000);

  // Back from the editor saves first.
  const leaveEdit = useCallback(async () => {
    await editor.current?.flush();
    onEdit(false);
    onChanged();
    void note.reload();
  }, [onEdit, onChanged, note]);

  // A heading asked for from the outline or a `[[Note#Heading]]` link.
  useEffect(() => {
    if (!scroll || !view || edit) return;
    const id = setTimeout(() => document.getElementById(headingId(scroll.heading))?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    return () => clearTimeout(id);
  }, [scroll, view, edit]);

  const name = view ? displayName(view.name, view.title, vault.settings.labels) : (path.split('/').pop() ?? '').replace(/\.md$/i, '');
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const readOnly = vault.readOnly || !!view?.readOnly;

  const noteEnv = useMemo(() => env, [env]);
  const items: MenuItem[] = [
    ...(!readOnly ? [{ label: 'Rename', icon: <TextCursorInput className="size-4" />, onSelect: () => setRenaming(true) }] : []),
    ...(!readOnly ? [{ label: 'History', icon: <History className="size-4" />, onSelect: () => setHistory(true) }] : []),
    { label: 'Copy link', icon: <Link2 className="size-4" />, onSelect: () => void copyText(`[[${view?.name ?? name}]]`).then((ok) => ok && toast('Copied')) },
    { label: 'Open in Obsidian', icon: <ExternalLink className="size-4" />, onSelect: () => window.open(obsidianUrl(vault.name, path), '_blank', 'noopener') },
    ...(!readOnly ? [{ label: 'Delete', icon: <Trash2 className="size-4" />, onSelect: () => setDeleting(true), danger: true }] : []),
  ];

  const iconBtn = 'press inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-1.5 sm:px-3">
        {onBack && (
          <button type="button" aria-label="Back" onClick={() => (edit ? void leaveEdit().then(onBack) : onBack())} className={iconBtn}>
            <ArrowLeft className="size-[18px]" />
          </button>
        )}
        <div className="min-w-0 flex-1 px-1">
          <button type="button" disabled={readOnly || !view} onClick={() => setRenaming(true)} className="block max-w-full truncate text-left text-[15.5px] font-semibold enabled:hover:text-ink-soft" title={readOnly ? undefined : 'Rename'}>
            {name}
          </button>
          {folder && <p className="truncate text-[11.5px] leading-tight text-muted">{folder}</p>}
        </div>
        {edit && <SaveMark status={status} />}
        {!readOnly && view && (
          <button
            type="button"
            aria-label={edit ? 'Preview' : 'Edit'}
            title={edit ? 'Preview' : 'Edit'}
            onClick={() => (edit ? void leaveEdit() : onEdit(true))}
            className={cn(iconBtn, edit && 'bg-surface-2 text-ink')}
          >
            {edit ? <Eye className="size-[18px]" /> : <Pencil className="size-[18px]" />}
          </button>
        )}
        {view && (
          <button type="button" aria-label="Links and outline" aria-pressed={panelOpen} title="Links and outline" onClick={onPanel} className={cn(iconBtn, 'relative', panelOpen && 'bg-surface-2 text-ink')}>
            <PanelRight className="size-[18px]" />
            {view.backlinkCount > 0 && <span className="absolute top-0.5 right-0 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 font-bold text-white">{view.backlinkCount}</span>}
          </button>
        )}
        <Menu label="Note actions" items={items} align="right" />
      </header>

      <div className="min-h-0 flex-1">
        {note.error && !view ? (
          <p className="px-4 py-10 text-center text-[14px] text-muted">{note.error.message}</p>
        ) : !view ? (
          <div className="p-5">
            <RowsSkeleton rows={4} lines={2} />
          </div>
        ) : edit ? (
          <div className="mx-auto h-full w-full max-w-[46rem]">
            <NoteEditor
              ref={editor}
              key={`${vault.id}|${path}`}
              vaultId={vault.id}
              path={view.path}
              view={view}
              attachments={vault.settings.attachmentsFolder}
              onStatus={setStatus}
              onSaved={() => void note.reload()}
            />
          </div>
        ) : (
          <div className="h-full overflow-y-auto overscroll-contain">
            <article className="mx-auto w-full max-w-[46rem] px-4 pt-4 pb-24 sm:px-8 sm:pt-6">
              <Chips view={view} onTag={env.tag} />
              {view.content.slice(view.frontmatter.bodyOffset).trim() ? (
                <NoteMarkdown text={view.content.slice(view.frontmatter.bodyOffset)} note={view} env={noteEnv} />
              ) : (
                !readOnly && (
                  <button type="button" onClick={() => onEdit(true)} className="press mt-2 rounded-xl border border-dashed border-line px-4 py-6 text-[14px] text-muted hover:text-ink">
                    Empty. Start writing
                  </button>
                )
              )}
            </article>
          </div>
        )}
      </div>

      <NoteNameDialog
        open={renaming}
        title="Rename"
        initial={view?.path.replace(/\.md$/i, '') ?? path.replace(/\.md$/i, '')}
        submitLabel="Rename"
        onClose={() => setRenaming(false)}
        onSubmit={async (to) => {
          const r = await knowledgeApi.renameNote(vault.id, path, to);
          setRenaming(false);
          if (r.rewritten.length) toast(`${r.rewritten.length} ${r.rewritten.length === 1 ? 'link' : 'links'} updated`);
          onRenamed(r.path);
        }}
      />
      <HistoryDialog open={history} vaultId={vault.id} path={path} onClose={() => setHistory(false)} onRestored={() => (setHistory(false), void note.reload(), onChanged())} />
      <ConfirmDialog
        open={deleting}
        title={`Delete ${name}?`}
        description="It stays in history for 30 days."
        confirmLabel="Delete"
        onClose={() => setDeleting(false)}
        onConfirm={() => {
          void knowledgeApi
            .deleteNote(vault.id, path)
            .then(() => {
              setDeleting(false);
              toast('Deleted');
              onDeleted();
            })
            .catch((e) => {
              setDeleting(false);
              toast(errorText(e, 'Could not delete it.'), 'error');
            });
        }}
      />
    </div>
  );
}

function SaveMark({ status }: { status: EditStatus }) {
  const common = 'inline-flex size-7 shrink-0 items-center justify-center text-muted';
  if (status === 'saving') return <span className={common} role="status" aria-label="Saving"><Loader2 className="size-4 animate-spin" /></span>;
  if (status === 'dirty') return <span className={common} role="status" aria-label="Unsaved"><span className="size-2 rounded-full bg-amber-500" /></span>;
  if (status === 'conflict' || status === 'error') return <span className={cn(common, 'text-amber-600')} role="status" aria-label={status === 'conflict' ? 'Changed elsewhere' : 'Not saved'}><AlertTriangle className="size-4" /></span>;
  return <span className={common} role="status" aria-label="Saved"><Check className="size-4" /></span>;
}

function Chips({ view, onTag }: { view: NoteView; onTag: (t: string) => void }) {
  const marks = view.agentOnly || view.secretShaped;
  if (view.tags.length === 0 && !marks) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      {view.agentOnly && (
        <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[12px] font-semibold text-ink-soft" title="Written by an agent">
          <Bot className="size-3.5" aria-hidden="true" />
          Agent
        </span>
      )}
      {view.secretShaped && (
        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-500">
          <AlertTriangle className="size-4" aria-label="Looks like it contains a secret" />
          <InfoTip label="About this warning">This text looks like it contains a key or token. Notes aren’t encrypted.</InfoTip>
        </span>
      )}
      {view.tags.map((t) => (
        <button key={t} type="button" onClick={() => onTag(t)} className="cursor-pointer rounded-md bg-accent-soft px-1.5 py-0.5 text-[12px] font-medium text-accent">
          #{t}
        </button>
      ))}
    </div>
  );
}
