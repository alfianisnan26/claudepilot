import { Badge, Button, ConfirmDialog, Dialog, LoadError, Menu, RowsSkeleton, Select, SwitchRow, TextArea, TextField, useToast, type MenuItem } from '@isnanme/ui';
import type { McpCatalogEntry, McpCatalogVersion } from '@portal/contracts';
import { Ban, ChevronLeft, CircleCheck, FlaskConical, Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { errorText } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';
import { mcpApi } from './api';
import { KIND_ICON } from './CatalogPage';
import { EntryDialog, type EntryDialogMode } from './EntryDialog';
import { authLabel, KIND_LABEL, REVIEW } from './labels';
import { CodeBlock, Disclosure, MONO } from './parts';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * One catalog entry and its versions (`/admin/pools/mcp/catalog/:entryId`). A draft's review shows the
 * exact command or URL untruncated, the risky patterns, and every secret it needs, and takes "I reviewed
 * the command and its source" before Approve (US2, FR3). Approved versions can be tried in a set,
 * deprecated or revoked (FR4, FR13, FR13b).
 */
export function EntryPage() {
  const { entryId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [entry, setEntry] = useState<McpCatalogEntry | null>(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<EntryDialogMode | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [revoking, setRevoking] = useState<McpCatalogVersion | null>(null);
  const [trying, setTrying] = useState<McpCatalogVersion | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setEntry(await mcpApi.entry(entryId));
    } catch {
      setFailed(true);
    }
  }, [entryId]);
  useEffect(() => void load(), [load]);
  useLive('pools', () => void load());

  const act = async (run: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await run();
      toast(done);
      await load();
      return true;
    } catch (e) {
      toast(errorText(e, 'Could not change it.'), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const Icon = entry ? KIND_ICON[entry.kind] : null;
  const items: MenuItem[] = entry
    ? [
        { label: 'New version', icon: <Plus className="size-4" />, onSelect: () => setDialog({ kind: 'version', entry }) },
        { label: 'Rename', icon: <Pencil className="size-4" />, onSelect: () => setRenaming(true) },
        { label: 'Delete', icon: <Trash2 className="size-4" />, onSelect: () => setRemoving(true), danger: true, disabled: entry.sets.length > 0 || entry.versions.some((v) => v.reviewState !== 'draft') },
      ]
    : [];

  return (
    <>
      <Link to="/admin/pools/mcp/catalog" className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink">
        <ChevronLeft className="size-4" />
        Catalog
      </Link>
      {failed && <LoadError onRetry={load} />}
      {!entry && !failed && <RowsSkeleton rows={3} lines={2} trailing={false} />}
      {entry && Icon && (
        <>
          <PageHeader
            title={
              <span className="inline-flex items-center gap-2.5">
                <Icon className="size-6 text-accent" />
                {entry.displayName}
              </span>
            }
            description={entry.description || undefined}
            action={<Menu label={`Actions for ${entry.displayName}`} items={items} />}
          />
          <div className="mb-5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
            <span>
              Key <span style={{ fontFamily: MONO }}>{entry.key}</span>
            </span>
            <span>{KIND_LABEL[entry.kind]}</span>
            {entry.sets.length > 0 ? <span>In {entry.sets.map((s) => s.poolName).join(', ')}</span> : <span>In no set yet</span>}
            {entry.workspaces > 0 && <span>{plural(entry.workspaces, 'workspace')}</span>}
          </div>
          <div className="flex flex-col gap-2.5">
            {entry.versions.map((v) => (
              <VersionRow
                key={v.id}
                entry={entry}
                version={v}
                busy={busy}
                onEdit={() => setDialog({ kind: 'draft', entry, version: v })}
                onDelete={() => void act(() => mcpApi.removeVersion(entry.id, v.id), `${v.version} deleted`)}
                onApprove={(note) => act(() => mcpApi.approve(entry.id, v.id, { reviewed: true, note }), `${entry.displayName} ${v.version} approved`)}
                onDeprecate={() => void act(() => mcpApi.deprecate(entry.id, v.id), `${v.version} deprecated`)}
                onRevoke={() => setRevoking(v)}
                onTry={() => setTrying(v)}
              />
            ))}
          </div>
        </>
      )}
      <EntryDialog
        mode={dialog}
        onClose={() => setDialog(null)}
        onSaved={(e) => {
          setDialog(null);
          setEntry(e);
          toast('Draft saved');
        }}
      />
      {entry && <RenameDialog entry={entry} open={renaming} onClose={() => setRenaming(false)} onDone={(e) => (setRenaming(false), setEntry(e), toast('Saved'))} />}
      {entry && <TryDialog entry={entry} version={trying} onClose={() => setTrying(null)} />}
      <ConfirmDialog
        open={!!revoking}
        title={`Revoke ${entry?.displayName ?? ''} ${revoking?.version ?? ''}?`}
        description={
          revoking
            ? `It leaves ${plural(revoking.workspaces, 'workspace')} now, pinned ones included, and its running processes stop. Its tools stay blocked for 14 days or until an approved version replaces it.`
            : ''
        }
        confirmLabel="Revoke"
        loading={busy}
        onConfirm={() => {
          if (!entry || !revoking) return;
          void act(() => mcpApi.revoke(entry.id, revoking.id), `${entry.displayName} ${revoking.version} revoked`).then((ok) => ok && setRevoking(null));
        }}
        onClose={() => !busy && setRevoking(null)}
      />
      <ConfirmDialog
        open={removing}
        title={`Delete ${entry?.displayName ?? ''}?`}
        description="The entry and its drafts are deleted. No set uses it."
        confirmLabel="Delete"
        loading={busy}
        onConfirm={() => entry && void act(() => mcpApi.remove(entry.id), `${entry.displayName} deleted`).then((ok) => ok && navigate('/admin/pools/mcp/catalog'))}
        onClose={() => !busy && setRemoving(false)}
      />
    </>
  );
}

function VersionRow({
  entry,
  version: v,
  busy,
  onEdit,
  onDelete,
  onApprove,
  onDeprecate,
  onRevoke,
  onTry,
}: {
  entry: McpCatalogEntry;
  version: McpCatalogVersion;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onApprove: (note: string) => Promise<boolean>;
  onDeprecate: () => void;
  onRevoke: () => void;
  onTry: () => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  const [note, setNote] = useState('');
  const review = REVIEW[v.reviewState];
  const auth = authLabel(v);
  const risky = v.flags.filter((f) => f.code !== 'not_pinned');
  return (
    <Disclosure
      defaultOpen={v.reviewState === 'draft'}
      tone={v.reviewState === 'revoked' ? 'danger' : undefined}
      summary={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold" style={{ fontFamily: MONO }}>
            {v.version}
          </span>
          <Badge tone={review.tone}>{review.label}</Badge>
          {risky.length > 0 && <Badge tone="danger">{plural(risky.length, 'risk')}</Badge>}
          <span className="text-[12px] text-muted" title={formatDateTime(v.updatedAt)}>
            {v.reviewState === 'draft' ? `added ${timeAgo(v.createdAt)}` : v.reviewedAt ? `approved ${timeAgo(v.reviewedAt)}` : ''}
            {v.workspaces > 0 ? ` · ${plural(v.workspaces, 'workspace')}` : ''}
          </span>
        </span>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold text-ink-soft">{entry.kind === 'remote' ? 'Connects to' : 'Runs'}</span>
          <CodeBlock value={v.command} />
          {entry.kind === 'npm' && <p className="text-[12px] text-muted">Pre-installed into each workspace from the public registry; the same command runs on first use.</p>}
          {auth && <p className="text-[12px] text-muted">{auth}</p>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {v.flags.length === 0 ? (
            <span className="text-[12.5px] text-muted">No risky patterns found.</span>
          ) : (
            v.flags.map((f) => (
              <Badge key={f.code} tone={f.code === 'not_pinned' || f.code === 'query' ? 'warning' : 'danger'}>
                <ShieldAlert className="size-3" />
                {f.label}
              </Badge>
            ))
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold text-ink-soft">{entry.kind === 'remote' ? 'Headers' : 'Variables'}</span>
          {v.slots.length === 0 ? (
            <p className="text-[12.5px] text-muted">None.</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {v.slots.map((s) => (
                <li key={s.name} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-[13px]">
                  <span className="font-medium" style={{ fontFamily: MONO }}>
                    {s.name}
                  </span>
                  {s.secret ? <Badge tone="warning">Secret</Badge> : <Badge>Setting</Badge>}
                  {s.required && <span className="text-[12px] text-muted">required</span>}
                  {s.target === 'path' && <span className="text-[12px] text-muted">gets the file’s path</span>}
                  {s.template && <span className="text-[12px] text-muted" style={{ fontFamily: MONO }}>{s.template}</span>}
                  {s.default && <span className="text-[12px] text-muted">default {s.default}</span>}
                  {s.description && <span className="w-full text-[12px] text-muted">{s.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        {v.reviewNote && <p className="text-[12.5px] text-ink-soft">Review note: {v.reviewNote}</p>}
        {v.revokedAt && <p className="text-[12.5px] text-danger">Revoked {formatDateTime(v.revokedAt)}.</p>}

        {v.reviewState === 'draft' && (
          <div className="flex flex-col gap-3 rounded-xl bg-surface-2 p-3">
            <TextArea label="Review note" optional rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            <SwitchRow label="I reviewed the command and its source" description="Approving makes this exact version available to sets. It can’t change afterwards." checked={reviewed} onChange={setReviewed} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={onDelete} disabled={busy}>
                Delete
              </Button>
              <Button size="sm" variant="secondary" icon={<Pencil className="size-4" />} onClick={onEdit} disabled={busy}>
                Edit
              </Button>
              <Button size="sm" icon={<CircleCheck className="size-4" />} disabled={!reviewed || busy} onClick={() => void onApprove(note).then((ok) => ok && setReviewed(false))}>
                Approve
              </Button>
            </div>
          </div>
        )}
        {(v.reviewState === 'approved' || v.reviewState === 'deprecated') && (
          <div className="flex flex-wrap justify-end gap-2">
            {v.reviewState === 'approved' && entry.sets.length > 0 && (
              <Button size="sm" variant="secondary" icon={<FlaskConical className="size-4" />} onClick={onTry} disabled={busy}>
                Try in set
              </Button>
            )}
            {v.reviewState === 'approved' && (
              <Button size="sm" variant="ghost" onClick={onDeprecate} disabled={busy}>
                Deprecate
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<Ban className="size-4" />} onClick={onRevoke} disabled={busy}>
              Revoke
            </Button>
          </div>
        )}
      </div>
    </Disclosure>
  );
}

/** Name and description change without a review: they never reach a workspace. */
function RenameDialog({ entry, open, onClose, onDone }: { entry: McpCatalogEntry; open: boolean; onClose: () => void; onDone: (e: McpCatalogEntry) => void }) {
  const [name, setName] = useState(entry.displayName);
  const [description, setDescription] = useState(entry.description);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) (setName(entry.displayName), setDescription(entry.description), setError(null));
  }, [open, entry]);
  return (
    <Dialog
      open={open}
      onClose={() => !saving && onClose()}
      size="sm"
      title={`Rename ${entry.displayName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                onDone(await mcpApi.update(entry.id, { displayName: name, description }));
              } catch (e) {
                setError(errorText(e, 'Could not save it.'));
              } finally {
                setSaving(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" data-autofocus />
        <TextField label="Description" optional value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} autoComplete="off" />
        {error && (
          <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** "Try in set" (FR4): a held revision of a set with this version, for pinned trial workspaces. */
function TryDialog({ entry, version, onClose }: { entry: McpCatalogEntry; version: McpCatalogVersion | null; onClose: () => void }) {
  const toast = useToast();
  const [poolId, setPoolId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (version) (setPoolId(entry.sets[0]?.poolId ?? ''), setError(null));
  }, [version, entry]);
  return (
    <Dialog
      open={!!version}
      onClose={() => !saving && onClose()}
      size="sm"
      title={`Try ${entry.displayName} ${version?.version ?? ''}`}
      description="Makes a revision of the set with this version, held back: pin trial workspaces to it in Revisions, then make it current or leave it."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            loading={saving}
            disabled={!poolId}
            onClick={async () => {
              if (!version) return;
              setSaving(true);
              try {
                const p = await mcpApi.tryInSet(poolId, entry.id, version.version);
                toast(`${p.name} r${p.latestRevision} is ready to try`);
                onClose();
              } catch (e) {
                setError(errorText(e, 'Could not make it.'));
              } finally {
                setSaving(false);
              }
            }}
          >
            Make revision
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select label="Set" value={poolId} onChange={setPoolId} options={entry.sets.map((s) => ({ value: s.poolId, label: `${s.poolName} (uses ${s.versions.join(', ')})` }))} />
        {error && (
          <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
