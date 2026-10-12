import { Button, Dialog, Select } from '@isnanme/ui';
import type { AccountPool, MultiPoolType, Workspace } from '@portal/contracts';
import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { multiPoolTabs } from '@/features/pools/registry';
import { api, errorText } from '@/lib/api';

const ACCOUNT = 'account';

/**
 * Bulk assignment (foundation PRD §10): one pool to every selected workspace, picking the type, then
 * the pool. An account pool replaces each workspace's own (Account Pool PRD §13: the override is
 * confirmed here once for all of them); a pool of another type is added next to what they have.
 */
export function BulkAssignDialog({
  workspaces,
  accountPools,
  onClose,
  onDone,
}: {
  /** The selection; null while closed. */
  workspaces: Workspace[] | null;
  accountPools: AccountPool[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const tabs = multiPoolTabs();
  const [type, setType] = useState<string>(ACCOUNT);
  const [poolId, setPoolId] = useState('');
  const [pools, setPools] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const open = !!workspaces;

  useEffect(() => {
    if (!open) return;
    setType(ACCOUNT);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setPoolId('');
    if (type === ACCOUNT) return setPools(accountPools);
    setPools(null);
    let current = true;
    api.pools.list(type as MultiPoolType).then(
      (list) => current && setPools(list),
      (e: unknown) => current && setError(errorText(e, 'Could not load the pools.')),
    );
    return () => void (current = false);
  }, [open, type, accountPools]);

  const count = workspaces?.length ?? 0;
  const save = async () => {
    if (!workspaces || !poolId) return;
    setSaving(true);
    setError(null);
    const name = pools?.find((p) => p.id === poolId)?.name ?? 'The pool';
    try {
      if (type === ACCOUNT) {
        // One at a time: each change ends that workspace's chat sessions first and re-picks an account.
        const failed: string[] = [];
        for (const w of workspaces) await api.accounts.assign(w.id, { poolId, confirmOverride: true }).catch(() => failed.push(w.name));
        if (failed.length) setError(`Could not assign it to ${failed.join(', ')}.`);
        else onDone(`${name} assigned to ${count} workspace${count === 1 ? '' : 's'}`);
      } else {
        const r = await api.pools.assign(type as MultiPoolType, poolId, workspaces.map((w) => w.id));
        onDone(r.assigned.length ? `${name} assigned to ${r.assigned.length} workspace${r.assigned.length === 1 ? '' : 's'}` : `They all have ${name} already`);
      }
    } catch (e) {
      setError(errorText(e, 'Could not assign it.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => !saving && onClose()}
      size="sm"
      title="Assign pool"
      description={`To ${count} selected workspace${count === 1 ? '' : 's'}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant={type === ACCOUNT ? 'danger' : 'primary'} loading={saving} disabled={!poolId} onClick={() => void save()}>
            {type === ACCOUNT ? 'Assign and override sign-ins' : 'Assign'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select
          label="Type"
          value={type}
          onChange={setType}
          options={[{ value: ACCOUNT, label: 'Account pool' }, ...tabs.map((t) => ({ value: t.pool.type, label: t.label }))]}
        />
        <Select
          label="Pool"
          value={poolId}
          onChange={setPoolId}
          placeholder={pools === null ? 'Loading…' : pools.length === 0 ? 'No pools of this type yet' : 'Pick a pool'}
          options={(pools ?? []).map((p) => ({ value: p.id, label: p.name }))}
          disabled={!pools?.length}
        />
        {type === ACCOUNT && (
          <div className="flex items-start gap-3 rounded-2xl bg-flame-soft px-4 py-3 text-[13px]">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-flame" />
            <p className="min-w-0 text-ink-soft">
              Workspaces may have their own sign-in. From their next request, Claude Code uses the pool’s key instead, usage is billed to the
              pool’s account, and their chat sessions end first.
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
