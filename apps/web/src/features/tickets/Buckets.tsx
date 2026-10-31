import { Button, ConfirmDialog, FormDialog, Select, TextField } from '@isnanme/ui';
import { TICKET_BUCKET_KEY, type TicketBucket, type Workspace } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { ReporterDialog } from '@/features/reporter/ReporterDialog';
import { api, errorText } from '@/lib/api';
import { ticketsApi } from './api';
import { mergeText } from './labels';

const NEW = '__new__';


const tagList = (raw: string) =>
  raw
    .split(/[,\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

/**
 * Buckets (T-1098): make one, or change one's name, description, default workspace, default tags and vault. A bucket's key is the prefix of
 * its tickets' ids (KONF-12) and never changes once made.
 */
export function BucketsDialog({
  open,
  buckets,
  onClose,
  onChanged,
}: {
  open: boolean;
  buckets: TicketBucket[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [pick, setPick] = useState(NEW);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [tags, setTags] = useState('');
  const [vaultId, setVaultId] = useState('');
  // T-1967: merge the picked bucket into another (its tickets move, their old keys keep working, the bucket goes).
  const [mergeInto, setMergeInto] = useState('');
  // A merge cannot be undone: the primary button asks first (UI check of T-1967).
  const [confirming, setConfirming] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // The UI reporter's settings for the picked bucket (its own dialog, in this one's place while open).
  const [reporterFor, setReporterFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPick(NEW);
    setReporterFor(null);
    setError(null);
    let current = true;
    api.workspaces.list().then(
      (list) => current && setWorkspaces(list),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [open]);

  // The fields follow the bucket picked (empty for a new one).
  useEffect(() => {
    const b = buckets.find((x) => x.key === pick);
    setKey(b?.key ?? '');
    setName(b?.name ?? '');
    setDescription(b?.description ?? '');
    setWorkspaceId(b?.defaultWorkspaceId ?? '');
    setTags(b?.defaultTags.join(', ') ?? '');
    setVaultId(b?.vaultId ?? '');
    setMergeInto('');
  }, [pick, buckets]);

  const isNew = pick === NEW;
  const keyOk = TICKET_BUCKET_KEY.test(key.trim().toUpperCase());

  const merge = async () => {
    setSaving(true);
    setError(null);
    try {
      await ticketsApi.mergeBucket(pick, { into: mergeInto });
      setConfirming(false);
      onChanged();
      onClose();
    } catch (e) {
      setConfirming(false);
      setError(errorText(e, 'That didn’t work.'));
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    if (!isNew && mergeInto) return setConfirming(true);
    setSaving(true);
    setError(null);
    try {
      const fields = {
        name: name.trim(),
        description,
        defaultWorkspaceId: workspaceId || null,
        defaultTags: tagList(tags),
        vaultId: vaultId.trim() || null,
      };
      if (isNew) await ticketsApi.createBucket({ key: key.trim().toUpperCase(), ...fields });
      else await ticketsApi.updateBucket(pick, fields);
      onChanged();
      onClose();
    } catch (e) {
      setError(errorText(e, 'That didn’t work.'));
    } finally {
      setSaving(false);
    }
  };

  const picked = buckets.find((b) => b.key === pick);
  const moving = picked?.total ?? picked?.open;
  return (
    <>
      <FormDialog
        open={open && !reporterFor}
        onClose={onClose}
        title="Buckets"
        onSubmit={submit}
        submitLabel={isNew ? 'Create' : mergeInto ? `Merge into ${mergeInto}` : 'Save'}
        saving={saving}
        error={error}
        dirty={!!name.trim()}
      >
        <div className="flex flex-col gap-4">
          <Select
            label="Bucket"
            value={pick}
            onChange={setPick}
            options={[{ value: NEW, label: 'New bucket' }, ...buckets.map((b) => ({ value: b.key, label: `${b.key} · ${b.name}` }))]}
          />
          <TextField
            label="Key"
            placeholder="KONF"
            maxLength={6}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            disabled={!isNew}
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            hint="Id prefix (KONF-12). Fixed once made."
            error={isNew && key && !keyOk ? '2 to 6 capital letters.' : undefined}
          />
          {!isNew && (
            <Select
              label="Merge into"
              optional
              hint="Its tickets move there; their old ids keep working. This bucket goes."
              value={mergeInto}
              onChange={setMergeInto}
              options={[{ value: '', label: 'None' }, ...buckets.filter((b) => b.key !== pick).map((b) => ({ value: b.key, label: `${b.key} · ${b.name}` }))]}
            />
          )}
          {/* A merge changes none of these: they hide while a target is picked. */}
          {!mergeInto && (
            <>
              <TextField label="Name" placeholder="Konfersi" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
              <TextField label="Description" optional maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
              <Select
                label="Default workspace"
                optional
                value={workspaceId}
                onChange={setWorkspaceId}
                options={[{ value: '', label: 'Any' }, ...workspaces.map((w) => ({ value: w.id, label: w.id }))]}
              />
              <TextField
                label="Default tags"
                optional
                placeholder="konfersi"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
              <TextField label="Vault" optional autoComplete="off" spellCheck={false} value={vaultId} onChange={(e) => setVaultId(e.target.value)} />
              {!isNew && (
                <Button variant="secondary" onClick={() => setReporterFor(pick)}>
                  Reporter…
                </Button>
              )}
            </>
          )}
        </div>
      </FormDialog>
      <ReporterDialog bucket={open ? reporterFor : null} onClose={() => setReporterFor(null)} />
      <ConfirmDialog
        open={confirming}
        title={`Merge ${pick} into ${mergeInto}?`}
        description={mergeText(pick, mergeInto, moving)}
        confirmLabel="Merge"
        loading={saving}
        onConfirm={merge}
        onClose={() => !saving && setConfirming(false)}
      />
    </>
  );
}
