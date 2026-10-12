import { Button, ConfirmDialog, DiscardDialog, FormDialog, LoadError, RowsSkeleton, TextField, useToast } from '@isnanme/ui';
import { POOL_NAME_MAX, type PoolSummary } from '@portal/contracts';
import { ChevronLeft, FileSearch } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { api, ApiError, errorText } from '@/lib/api';
import { PreviewDialog } from './PreviewDialog';
import type { MultiPoolUi } from './types';

/**
 * The shared editor's state (foundation PRD §10): name, description, the type's content and a revision
 * note. Saving sends the content back as the API showed it, and the portal keeps write-only values the
 * editor never had. Every save of changed content is a new revision.
 */
export function usePoolDraft<C>(ui: MultiPoolUi<C>, pool: PoolSummary | null, open: boolean) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState<C>(() => ui.emptyContent());
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [initial, setInitial] = useState('');

  useEffect(() => {
    if (!open) return;
    const start = pool ? (pool.content as C) : ui.emptyContent();
    setName(pool?.name ?? '');
    setDescription(pool?.description ?? '');
    setContent(start);
    setNote('');
    setErrors({});
    setFormError(null);
    setInitial(JSON.stringify([pool?.name ?? '', pool?.description ?? '', start]));
  }, [open, pool, ui]);

  const dirty = JSON.stringify([name, description, content]) !== initial || note.trim() !== '';

  /** The saved pool, or null when the portal refused (the errors are set then). `draft` saves a revision nobody gets yet. */
  const save = async (opts: { draft?: boolean } = {}): Promise<PoolSummary | null> => {
    setSaving(true);
    setFormError(null);
    try {
      const body = { name, description, content, note, ...(opts.draft ? { draft: true } : {}), ...(pool ? { baseRevision: pool.latestRevision } : {}) };
      return pool ? await api.pools.update(ui.type, pool.id, body) : await api.pools.create(ui.type, body);
    } catch (e) {
      if (e instanceof ApiError && e.details && typeof e.details === 'object') setErrors(e.details as Record<string, string>);
      setFormError(errorText(e, 'Could not save it.'));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const clear = (field: string) => setErrors(({ [field]: _, ...rest }) => rest);
  return { name, setName, description, setDescription, content, setContent, note, setNote, errors, clear, formError, saving, dirty, save };
}

type Draft<C> = ReturnType<typeof usePoolDraft<C>>;

/** Name, description, the type's own editor, and the revision note: the same in a dialog or on a page. */
export function PoolEditorFields<C>({ ui, pool, draft, layout, reload }: { ui: MultiPoolUi<C>; pool: PoolSummary | null; draft: Draft<C>; layout: 'dialog' | 'page'; reload?: () => void }) {
  const Editor = ui.Editor;
  return (
    <div className="flex flex-col gap-4">
      <TextField
        label="Name"
        autoComplete="off"
        maxLength={POOL_NAME_MAX}
        value={draft.name}
        onChange={(e) => (draft.setName(e.target.value), draft.clear('name'))}
        error={draft.errors.name}
        data-autofocus
      />
      <TextField
        label="Description"
        optional
        autoComplete="off"
        maxLength={300}
        value={draft.description}
        onChange={(e) => (draft.setDescription(e.target.value), draft.clear('description'))}
        error={draft.errors.description}
      />
      <Editor value={draft.content} onChange={draft.setContent} errors={draft.errors} pool={pool} name={draft.name} disabled={draft.saving} layout={layout} reload={reload} dirty={draft.dirty} />
      <TextField
        label="Revision note"
        optional
        placeholder="What changed"
        autoComplete="off"
        maxLength={500}
        value={draft.note}
        onChange={(e) => draft.setNote(e.target.value)}
        error={draft.errors.note}
      />
    </div>
  );
}

/** The editor in a dialog: the default for every type. */
export function PoolEditorDialog<C>({
  ui,
  open,
  pool,
  onClose,
  onSaved,
}: {
  ui: MultiPoolUi<C>;
  open: boolean;
  /** Null for a new pool. */
  pool: PoolSummary | null;
  onClose: () => void;
  onSaved: (pool: PoolSummary) => void;
}) {
  const draft = usePoolDraft(ui, pool, open);
  const [previewing, setPreviewing] = useState(false);
  return (
    <>
      <FormDialog
        open={open}
        onClose={onClose}
        title={pool ? `Edit ${pool.name}` : `New ${ui.noun.one}`}
        description={ui.description}
        onSubmit={async () => {
          const saved = await draft.save();
          if (saved) onSaved(saved);
        }}
        submitLabel="Save"
        saving={draft.saving}
        error={draft.formError}
        dirty={draft.dirty}
        extraActions={
          <Button variant="ghost" icon={<FileSearch className="size-4" />} onClick={() => setPreviewing(true)} disabled={draft.saving}>
            Preview files
          </Button>
        }
      >
        <PoolEditorFields ui={ui} pool={pool} draft={draft} layout="dialog" />
      </FormDialog>
      <PreviewDialog open={previewing} onClose={() => setPreviewing(false)} type={ui.type} poolId={pool?.id ?? null} content={draft.content} />
    </>
  );
}

/**
 * The editor as a page of its own, for types whose editor holds lists (`editor: 'page'`), at
 * `/admin/pools/<tab>/new` and `/admin/pools/<tab>/<id>/edit`. Save and Cancel stay pinned at the
 * bottom, and leaving with changes asks first.
 */
export function PoolEditorPage<C>({ tabId, ui }: { tabId: string; ui: MultiPoolUi<C> }) {
  const { poolId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [pool, setPool] = useState<PoolSummary | null | undefined>(poolId ? undefined : null);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const back = `/admin/pools?tab=${tabId}`;

  const load = useCallback(async () => {
    if (!poolId) return setPool(null);
    setFailed(false);
    try {
      setPool(await api.pools.get(ui.type, poolId));
    } catch {
      setFailed(true);
    }
  }, [poolId, ui.type]);
  useEffect(() => void load(), [load]);

  const draft = usePoolDraft(ui, pool ?? null, pool !== undefined);
  const leave = () => (draft.dirty && !draft.saving ? setAsking(true) : navigate(back));
  const [publishing, setPublishing] = useState(false);
  /** Types with drafts save a draft or publish; the others just save. */
  const submit = async (e?: FormEvent, asDraft = false) => {
    e?.preventDefault();
    if (draft.saving) return;
    const saved = await draft.save({ draft: ui.drafts ? asDraft : false });
    if (!saved) return;
    // A saved draft stays out of delivery until it's published: say so, and keep the editor open on it.
    if (ui.drafts && asDraft) {
      toast(`${saved.name}: draft r${saved.latestRevision} saved`);
      if (!pool) navigate(`/admin/pools/${tabId}/${saved.id}/edit`, { replace: true });
      else void load();
      return;
    }
    toast(ui.drafts ? `${saved.name} published` : `${saved.name} saved`);
    navigate(back);
  };

  return (
    <>
      <Link to={back} className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink">
        <ChevronLeft className="size-4" />
        Pools
      </Link>
      <PageHeader title={pool ? `Edit ${pool.name}` : poolId ? 'Edit' : `New ${ui.noun.one}`} description={ui.description} />
      {failed && <LoadError onRetry={load} />}
      {pool === undefined && !failed && <RowsSkeleton rows={3} lines={2} trailing={false} />}
      {pool !== undefined && (
        <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-6">
          {draft.formError && (
            <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
              {draft.formError}
            </p>
          )}
          <PoolEditorFields ui={ui} pool={pool} draft={draft} layout="page" reload={load} />
          <div className="sticky bottom-[var(--tabbar-h,0px)] -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-bg/90 px-4 py-3 backdrop-blur-md sm:bottom-0 sm:mx-0 sm:px-0">
            <Button variant="ghost" icon={<FileSearch className="size-4" />} onClick={() => setPreviewing(true)} disabled={draft.saving} className="mr-auto" aria-label="Preview files">
              <span className={ui.drafts ? 'hidden sm:inline' : undefined}>Preview files</span>
            </Button>
            <Button variant="secondary" onClick={leave} disabled={draft.saving}>
              Cancel
            </Button>
            {ui.drafts ? (
              <>
                <Button variant="secondary" onClick={() => void submit(undefined, true)} disabled={draft.saving}>
                  Save draft
                </Button>
                <Button
                  loading={draft.saving}
                  onClick={() => (pool && pool.workspaces > 0 && ui.publishNote ? setPublishing(true) : void submit())}
                >
                  Publish
                </Button>
              </>
            ) : (
              <Button type="submit" loading={draft.saving}>
                Save
              </Button>
            )}
          </div>
        </form>
      )}
      <DiscardDialog open={asking} onKeep={() => setAsking(false)} onDiscard={() => navigate(back)} />
      <ConfirmDialog
        open={publishing}
        tone="primary"
        title={`Publish ${draft.name || 'this revision'}?`}
        description={ui.publishNote?.(pool?.workspaces ?? 0) ?? ''}
        confirmLabel="Publish"
        loading={draft.saving}
        onConfirm={() => void submit().then(() => setPublishing(false))}
        onClose={() => !draft.saving && setPublishing(false)}
      />
      <PreviewDialog open={previewing} onClose={() => setPreviewing(false)} type={ui.type} poolId={pool?.id ?? null} content={draft.content} />
    </>
  );
}
