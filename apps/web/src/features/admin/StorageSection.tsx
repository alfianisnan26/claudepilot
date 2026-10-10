import { Badge, Button, ConfirmDialog, LoadError, Section, useToast, type BadgeTone } from '@isnanme/ui';
import type { SystemStatus, TrustState } from '@portal/contracts';
import { Database, KeyRound, Play, ShieldPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/Card';
import { api, errorText } from '@/lib/api';
import { useLive } from '@/lib/live';
import { formatDateTime, timeAgo } from '@/lib/format';
import { SetUpKeyDialog, UnlockDialog } from './KeyDialogs';

const STATE: Record<TrustState, { label: string; tone: BadgeTone; summary: string }> = {
  ok: { label: 'OK', tone: 'success', summary: 'Secrets are encrypted and deliveries to workspaces can run.' },
  locked: { label: 'Locked', tone: 'warning', summary: 'Secrets stay sealed and nothing is delivered to workspaces.' },
  frozen: { label: 'Frozen', tone: 'danger', summary: 'Nothing is delivered to workspaces until this is resolved.' },
};

/** The portal's database: whether it trusts its own state (foundation PRD §6.5), and its backups. */
export function StorageSection() {
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

  return (
    <Section title="Storage" description="The portal's database, its secret key and backups.">
      {failed && <LoadError onRetry={load} />}
      {!status && !failed && <div className="skeleton h-24 rounded-[24px]" aria-busy="true" />}
      {status && (
        <Card className="p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-soft">
              <Database className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">Database</p>
                <Badge tone={STATE[status.trust.state].tone}>{STATE[status.trust.state].label}</Badge>
              </div>
              <p className="mt-0.5 text-[13px] text-muted">{STATE[status.trust.state].summary}</p>
            </div>
          </div>

          {status.trust.reasons.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2">
              {status.trust.reasons.map((r) => (
                <li key={r.code} className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[13px] text-ink-soft">
                  {r.message}
                </li>
              ))}
            </ul>
          )}

          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-line pt-4 text-[13px] sm:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-muted">Portal ID</dt>
              <dd className="truncate font-mono text-ink-soft" title={status.portalId ?? undefined}>
                {status.portalId ? status.portalId.slice(0, 8) : '–'}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Schema</dt>
              <dd className="text-ink-soft">{status.schemaVersion ?? '–'}</dd>
            </div>
            <div>
              <dt className="text-muted">Last backup</dt>
              <dd className="text-ink-soft" title={status.lastBackupAt ? formatDateTime(status.lastBackupAt) : undefined}>
                {status.lastBackupAt ? `${timeAgo(status.lastBackupAt)} · ${status.backups} kept` : 'None yet'}
              </dd>
            </div>
          </dl>

          {(status.resumable || status.secretKey.canSetUp || status.secretKey.canUnlock) && (
            <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4 sm:flex-row">
              {status.secretKey.canSetUp && (
                <Button icon={<ShieldPlus className="size-4" />} onClick={() => setKeyDialog('setup')}>
                  Set up encryption
                </Button>
              )}
              {status.secretKey.canUnlock && (
                <Button icon={<KeyRound className="size-4" />} onClick={() => setKeyDialog('unlock')}>
                  Unlock
                </Button>
              )}
              {status.resumable && (
                <Button variant="secondary" icon={<Play className="size-4" />} onClick={() => setConfirm(true)}>
                  Resume delivery
                </Button>
              )}
            </div>
          )}
          {status.secretKey.source && (
            <p className="mt-3 text-[12px] text-muted">
              Key from{' '}
              {status.secretKey.source === 'panel'
                ? 'this panel (in memory until the portal restarts)'
                : status.secretKey.source === 'file'
                  ? 'PORTAL_SECRET_KEY_FILE'
                  : 'PORTAL_SECRET_KEY'}
              .
            </p>
          )}
        </Card>
      )}

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
    </Section>
  );
}
