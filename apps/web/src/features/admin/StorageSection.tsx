import { Badge, Button, ConfirmDialog, useToast, type BadgeTone } from '@isnanme/ui';
import type { SystemStatus, TrustState } from '@portal/contracts';
import { Database, KeyRound, Play, ShieldPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { SettingRow } from '@/components/SettingRow';
import { api, errorText } from '@/lib/api';
import { useLive } from '@/lib/live';
import { timeAgo } from '@/lib/format';
import { SetUpKeyDialog, UnlockDialog } from './KeyDialogs';

const STATE: Record<TrustState, { label: string; tone: BadgeTone; row: 'accent' | 'warning' | 'danger'; summary: string }> = {
  ok: { label: 'OK', tone: 'success', row: 'accent', summary: 'Secrets are encrypted and deliveries to workspaces can run.' },
  locked: { label: 'Locked', tone: 'warning', row: 'warning', summary: 'Secrets stay sealed and nothing is delivered to workspaces.' },
  frozen: { label: 'Frozen', tone: 'danger', row: 'danger', summary: 'Nothing is delivered to workspaces until this is resolved.' },
};

const KEY_SOURCE = { panel: 'this panel (in memory until restart)', file: 'PORTAL_SECRET_KEY_FILE', env: 'PORTAL_SECRET_KEY' } as const;

/**
 * The portal's database as one settings row (foundation PRD §6.5): its state as a badge, the one
 * thing to do about it as the button, and the details behind the ⓘ.
 */
export function StorageRow() {
  const toast = useToast();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [keyDialog, setKeyDialog] = useState<'setup' | 'reset' | 'unlock' | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setStatus(await api.system());
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useLive('system', () => void load());

  const resume = async () => {
    setBusy(true);
    try {
      setStatus(await api.resumeDelivery());
      setConfirm(false);
      toast('Delivery resumed');
    } catch (e) {
      toast(errorText(e, 'Could not resume delivery.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const state = status ? STATE[status.trust.state] : null;
  const action = !status ? null : status.secretKey.canSetUp ? (
    <Button size="sm" icon={<ShieldPlus className="size-4" />} onClick={() => setKeyDialog('setup')}>
      Set up
    </Button>
  ) : status.secretKey.canUnlock ? (
    <Button size="sm" icon={<KeyRound className="size-4" />} onClick={() => setKeyDialog('unlock')}>
      Unlock
    </Button>
  ) : status.resumable ? (
    <Button size="sm" variant="secondary" icon={<Play className="size-4" />} onClick={() => setConfirm(true)}>
      Resume
    </Button>
  ) : null;

  return (
    <>
      <SettingRow
        icon={<Database className="size-5" />}
        tone={state?.row ?? 'neutral'}
        label={
          <>
            Storage
            {state && <Badge tone={state.tone}>{state.label}</Badge>}
            {status && (
              <InfoTip label="About storage">
                <span className="block">{state!.summary}</span>
                {status.trust.reasons.map((r) => (
                  <span key={r.code} className="mt-1.5 block">
                    {r.message}
                  </span>
                ))}
                <span className="mt-1.5 block text-muted">
                  {status.secretKey.source ? `Key from ${KEY_SOURCE[status.secretKey.source]}. ` : ''}
                  Portal {status.portalId?.slice(0, 8) ?? '–'} · schema {status.schemaVersion ?? '–'}
                </span>
              </InfoTip>
            )}
          </>
        }
        sub={
          failed ? (
            <button type="button" className="underline underline-offset-2" onClick={() => void load()}>
              Couldn’t load. Retry
            </button>
          ) : !status ? (
            'Checking…'
          ) : status.lastBackupAt ? (
            `Backup ${timeAgo(status.lastBackupAt)} · ${status.backups} kept`
          ) : (
            'No backup yet'
          )
        }
        trailing={action}
      />

      <SetUpKeyDialog
        open={keyDialog === 'setup' || keyDialog === 'reset'}
        mode={keyDialog === 'reset' ? 'reset' : 'setup'}
        keyFile={status?.secretKey.keyFile ?? null}
        onClose={() => setKeyDialog(null)}
        onDone={(next) => {
          setStatus(next);
          setKeyDialog(null);
          toast('Encryption set up');
        }}
      />
      <UnlockDialog
        open={keyDialog === 'unlock'}
        canReset={status?.secretKey.canReset}
        onReset={() => setKeyDialog('reset')}
        onClose={() => setKeyDialog(null)}
        onDone={(next, savedTo) => {
          setStatus(next);
          setKeyDialog(null);
          toast(savedTo ? 'Unlocked; key saved to the key file' : 'Unlocked');
        }}
      />
      <ConfirmDialog
        open={confirm}
        tone="primary"
        title="Resume delivery?"
        description="The portal starts writing to workspaces again from what this database holds. Check that the workspaces look right first."
        confirmLabel="Resume"
        loading={busy}
        onConfirm={() => void resume()}
        onClose={() => !busy && setConfirm(false)}
      />
    </>
  );
}
