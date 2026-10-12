import { Badge, Button, ConfirmDialog, Dialog, LoadError, RowsSkeleton, useToast, type BadgeTone } from '@isnanme/ui';
import type { RotationState, SecretRotationView, SecretVersionView } from '@portal/contracts';
import { useCallback, useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { secretsApi } from './api';

const STATE: Record<RotationState, { label: string; tone: BadgeTone }> = {
  confirmed: { label: 'Has it', tone: 'success' },
  pending: { label: 'Pending', tone: 'warning' },
  pinned: { label: 'Pinned', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
};
const name = (id: string) => id.slice(id.indexOf('/') + 1);
const DAY = 86_400_000;

/** "Expires in 9 days" within 14 days, "Expired" after, nothing otherwise (FR8). */
function expiry(at: string | null): { label: string; tone: BadgeTone } | null {
  if (!at) return null;
  const days = Math.ceil((new Date(at).getTime() - Date.now()) / DAY);
  if (days <= 0) return { label: 'Expired', tone: 'danger' };
  return days <= 14 ? { label: `Expires in ${days} day${days === 1 ? '' : 's'}`, tone: 'warning' } : null;
}

/**
 * A secret's versions and its latest rotation (Secrets & env FR16 to FR18): the tracker (which workspaces have the
 * new value, and when the old one is safe to revoke), and each version with where it is and "Revoke". Never a value.
 */
export function VersionsDialog({ open, poolId, entry, onClose }: { open: boolean; poolId: string; entry: { id: string; name: string }; onClose: () => void }) {
  const toast = useToast();
  const [versions, setVersions] = useState<SecretVersionView[] | null>(null);
  const [rotation, setRotation] = useState<SecretRotationView | null>(null);
  const [failed, setFailed] = useState(false);
  const [revoking, setRevoking] = useState<SecretVersionView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [v, r] = await Promise.all([secretsApi.versions(poolId, entry.id), secretsApi.rotations(poolId)]);
      setVersions(v);
      setRotation(r.find((x) => x.entryId === entry.id) ?? null);
    } catch {
      setFailed(true);
    }
  }, [poolId, entry.id]);
  useEffect(() => {
    if (!open) return;
    setVersions(null);
    void load();
  }, [open, load]);

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await secretsApi.revoke(poolId, revoking.id);
      toast(`v${revoking.version} revoked`);
      setRevoking(null);
      await load();
    } catch (e) {
      toast(errorText(e, 'Could not revoke it.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={open && !revoking} onClose={onClose} title={`${entry.name}: versions`}>
        {failed && <LoadError onRetry={load} />}
        {!versions && !failed && <RowsSkeleton rows={3} lines={2} trailing={false} />}
        {versions && (
          <div className="flex flex-col gap-4">
            {rotation && <Tracker rotation={rotation} />}
            <ul className="divide-y divide-line rounded-2xl border border-line">
              {versions.map((v) => {
                const exp = !v.revokedAt ? expiry(v.expiresAt) : null;
                return (
                  <li key={v.id} className="flex items-start gap-3 px-4 py-3 text-[13px]">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-semibold">v{v.version}</span>
                        {v.current && <Badge tone="success">Current</Badge>}
                        {v.revokedAt && <Badge tone="danger">Revoked</Badge>}
                        {exp && <Badge tone={exp.tone}>{exp.label}</Badge>}
                        {!v.stored && !v.revokedAt && <Badge tone="neutral">Cleared</Badge>}
                      </div>
                      <p className="mt-0.5 font-mono text-[12px] text-muted">
                        {v.hint} · {v.fingerprint} · {v.length} B
                      </p>
                      <p className="text-[12px] text-muted" title={formatDateTime(v.createdAt)}>
                        {timeAgo(v.createdAt)}
                        {v.workspaces.length ? ` · in ${v.workspaces.map(name).join(', ')}` : ''}
                        {v.pinned.length ? ` · pinned: ${v.pinned.map(name).join(', ')}` : ''}
                      </p>
                    </div>
                    {!v.current && !v.revokedAt && (
                      <Button variant="ghost" size="sm" onClick={() => setRevoking(v)}>
                        Revoke
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!revoking}
        title={`Revoke v${revoking?.version ?? ''}?`}
        description="It is never delivered again; workspaces pinned to it get the current value. Revoke it at the provider too: copies may remain."
        confirmLabel="Revoke"
        loading={busy}
        onConfirm={() => void revoke()}
        onClose={() => !busy && setRevoking(null)}
      />
    </>
  );
}

/** The latest rotation: how many workspaces have the new value, and whether the old one is safe to revoke at its provider. */
function Tracker({ rotation: r }: { rotation: SecretRotationView }) {
  const total = r.workspaces.length;
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-surface-2 px-4 py-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold">
          Rotated to v{r.toVersion}
          {r.urgent ? ' · urgent' : ''}
        </span>
        <span className="text-muted">
          {total > 0 ? `${r.counts.confirmed} of ${total} done · ` : ''}
          {timeAgo(r.startedAt)}
        </span>
        {r.safeAt && <Badge tone="success">Safe to revoke</Badge>}
        <InfoTip label="About safe to revoke">Safe to revoke covers the files the portal delivered. Transcripts, shell history and other copies may still hold the old value.</InfoTip>
      </div>
      {total > 0 && (
        <ul className="flex flex-col gap-1">
          {r.workspaces.map((w) => (
            <li key={w.workspaceId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-medium">{name(w.workspaceId)}</span>
              <Badge tone={STATE[w.state].tone}>{STATE[w.state].label}</Badge>
              {w.detail && <span className="text-muted">{w.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
