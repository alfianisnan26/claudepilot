import { Button, Dialog, Select, useToast } from '@isnanme/ui';
import type { PoolSummary } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useOrgs } from './OrgsProvider';
import { consentCredentials, moveTargets, orgErrorText } from './rules';
import { Alert } from './settingsUi';

/**
 * Move to organization for a set (D-111 D2, slice 5's transfer): pick an org the person is a member or up in, and for a Secrets & env set tick
 * the one-line warning (the org's owners and admins can read it). Its workspaces keep it. `orgId` fixes the org (Org settings' Move here).
 */
export function MoveSetDialog({ pool, orgId, onClose, onMoved }: { pool: PoolSummary | null; orgId?: string; onClose: () => void; onMoved: () => void }) {
  const toast = useToast();
  const { orgs } = useOrgs();
  const targets = orgId ? [orgId] : moveTargets(orgs, pool?.orgId);
  const [to, setTo] = useState('');
  const [ack, setAck] = useState(false);
  const [needsAck, setNeedsAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pool) return;
    setTo(targets[0] ?? '');
    setAck(false);
    setNeedsAck(pool.type === 'secrets');
    setError(null);
    // `targets` is read when the dialog opens.
  }, [pool?.id]);

  const move = async () => {
    if (!pool || !to) return;
    setBusy(true);
    setError(null);
    try {
      await api.orgs.movePool(pool.type, pool.id, { orgId: to as never, ...(needsAck ? { acknowledgeExposure: ack } : {}) });
      toast(`${pool.name} moved`);
      onMoved();
    } catch (e) {
      if (consentCredentials(e)) setNeedsAck(true);
      setError(orgErrorText(e, 'Couldn’t move it.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!pool}
      onClose={() => !busy && onClose()}
      size="sm"
      title="Move"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!to || (needsAck && !ack)} onClick={() => void move()} data-pool-move-confirm="">
            Move
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-pool-move="">
        <Alert text={error} />
        {targets.length === 0 ? (
          <p className="text-sm text-muted">No organization to move it to.</p>
        ) : (
          !orgId && (
            <Select
              label="Organization"
              value={to}
              onChange={setTo}
              options={targets.map((id) => ({ value: id, label: orgs?.find((o) => o.id === id)?.name ?? id }))}
            />
          )
        )}
        {pool && (
          <p className="text-sm [overflow-wrap:anywhere]">
            It will own <span className="font-semibold">{pool.name}</span>. Its workspaces keep it.
          </p>
        )}
        {needsAck && (
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" className="size-5 accent-accent" checked={ack} onChange={(e) => setAck(e.target.checked)} data-pool-move-ack="" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">Its owners and admins can read these credentials.</span>
          </label>
        )}
      </div>
    </Dialog>
  );
}
