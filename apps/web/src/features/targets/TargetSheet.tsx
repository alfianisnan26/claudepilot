import { Badge, Button, ConfirmDialog, Dialog, LoadError, Menu, useToast, type MenuItem } from '@isnanme/ui';
import type { ConnectEvent, ConnectNodeView, ConnectRemoveBlocked, ConnectTargetView } from '@portal/contracts';
import { ChevronDown, KeyRound, PauseCircle, PlayCircle, Plus, Settings2, ShieldOff, Terminal, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorText } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { connectApi } from './api';
import { Dot } from './Dot';
import { canAddNode } from './wizard';
import { TargetSettingsDialog } from './SettingsSheet';
import { rowLine } from './view';

const nodeDot = (n: ConnectNodeView) => (n.state === 'revoked' ? 'offline' : n.link === 'connected' ? 'connected' : 'offline');

/** One target in full: nodes, its commands, settings, events and Remove last. A full-screen sheet on phones (the Dialog's). */
export function TargetSheet({
  target,
  onClose,
  onChanged,
  onCommand,
  denied,
}: {
  target: ConnectTargetView | null;
  onClose: () => void;
  onChanged: () => void;
  onCommand: (t: ConnectTargetView, upgrade?: boolean) => void;
  /** The server said this person may not change targets (403): every action is disabled with the reason. */
  denied?: string | null;
}) {
  const toast = useToast();
  const [revoking, setRevoking] = useState<ConnectNodeView | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const [removing, setRemoving] = useState(false);

  const run = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast(done);
      onChanged();
    } catch (e) {
      toast(errorText(e, `Could not ${label}.`), 'error');
    }
  };

  const nodeItems = (n: ConnectNodeView): MenuItem[] => [
    {
      label: n.drained ? 'Place workspaces here' : 'Drain',
      icon: n.drained ? <PlayCircle className="size-4" /> : <PauseCircle className="size-4" />,
      onSelect: () => void run('change the node', () => connectApi.updateNode(n.id, { drained: !n.drained })),
      disabled: !!denied || n.state === 'revoked',
    },
    { label: 'Rotate key', icon: <KeyRound className="size-4" />, onSelect: () => void run('rotate the key', () => connectApi.rotateNode(n.id), 'Key rotation asked'), disabled: !!denied || n.link !== 'connected' },
    { label: 'Revoke', icon: <ShieldOff className="size-4" />, onSelect: () => setRevoking(n), danger: true, disabled: !!denied || n.state === 'revoked' },
  ];

  const t = target;
  return (
    <>
      <Dialog open={!!t} onClose={onClose} title={t?.label ?? ''} description={t ? rowLine(t) : undefined}>
        {t && (
          <div className="flex min-w-0 flex-col gap-5">
            {denied && (
              <p role="status" className="text-[13px] font-medium text-ink-soft">
                {denied}
              </p>
            )}
            {t.problem && t.link !== 'connected' && <p className="text-[13px] text-danger [overflow-wrap:anywhere]">{t.problem}</p>}

            {t.nodes.length > 0 && (
              <section aria-label="Nodes">
                <h3 className="mb-1 text-sm font-semibold text-ink-soft">Nodes</h3>
                <ul className="divide-y divide-line rounded-2xl border border-line">
                  {t.nodes.map((n) => (
                    <li key={n.id} className="flex min-w-0 items-center gap-3 px-3 py-2">
                      <Dot kind={nodeDot(n)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="min-w-0 truncate text-sm font-semibold" title={n.name}>
                            {n.name}
                          </p>
                          {n.drained && <Badge>Drained</Badge>}
                          {n.state === 'revoked' && <Badge tone="danger">Revoked</Badge>}
                          {n.incompatible && <Badge tone="danger">Incompatible</Badge>}
                          {n.outdated && !n.incompatible && n.state === 'enrolled' && (
                            <button type="button" className="press shrink-0 rounded-full" aria-label={`Outdated: show the upgrade command for ${n.name}`} onClick={() => onCommand(t, true)} disabled={!!denied}>
                              <Badge tone="warning">Outdated</Badge>
                            </button>
                          )}
                        </div>
                        <p className="truncate text-[13px] tabular-nums text-muted">{nodeLine(n)}</p>
                      </div>
                      <Menu label={`Actions for ${n.name}`} items={nodeItems(n)} />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" icon={<Terminal className="size-4" />} onClick={() => onCommand(t)} disabled={!!denied}>
                Command
              </Button>
              {canAddNode(t.kind) && t.nodes.some((n) => n.state === 'enrolled') && (
                <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => onCommand(t)} disabled={!!denied}>
                  Add node
                </Button>
              )}
              <Button variant="secondary" icon={<Settings2 className="size-4" />} onClick={() => setSettings(true)} disabled={!!denied}>
                Settings
              </Button>
            </div>

            <Events targetId={t.id} />

            <div className="border-t border-line pt-3">
              <Button variant="ghost" className="!text-danger" icon={<Trash2 className="size-4" />} onClick={() => setRemoving(true)} disabled={!!denied}>
                Remove
              </Button>
            </div>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!revoking}
        title={`Revoke ${revoking?.name ?? ''}?`}
        description="It disconnects now and can’t come back with its key. Its workspaces stay where they are."
        confirmLabel="Revoke"
        loading={revokeBusy}
        onConfirm={async () => {
          if (!revoking) return;
          setRevokeBusy(true);
          await run('revoke the node', () => connectApi.revokeNode(revoking.id), `${revoking.name} revoked`);
          setRevokeBusy(false);
          setRevoking(null);
        }}
        onClose={() => !revokeBusy && setRevoking(null)}
      />
      {t && <TargetSettingsDialog open={settings} target={t} onClose={() => setSettings(false)} onSaved={onChanged} />}
      {t && (
        <RemoveDialog
          open={removing}
          target={t}
          onClose={() => setRemoving(false)}
          onRemoved={() => {
            setRemoving(false);
            onClose();
            onChanged();
          }}
        />
      )}
    </>
  );
}

function nodeLine(n: ConnectNodeView): string {
  const parts: (string | false | null)[] = [
    n.link === 'connected' ? 'Connected' : n.lastSeenAt ? `Seen ${timeAgo(n.lastSeenAt)}` : 'Not seen',
    n.agentVersion && `v${n.agentVersion}`,
    n.link === 'connected' && n.rttMs != null && `${Math.round(n.rttMs)} ms`,
    n.os && n.arch ? `${n.os}/${n.arch}` : n.os,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Remove: one question when the target has workspaces, the default being the safe one. */
function RemoveDialog({ open, target, onClose, onRemoved }: { open: boolean; target: ConnectTargetView; onClose: () => void; onRemoved: () => void }) {
  const toast = useToast();
  const [choice, setChoice] = useState<'keep' | 'remove'>('keep');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<ConnectRemoveBlocked | null>(null);
  useEffect(() => {
    if (open) (setChoice('keep'), setBlocked(null));
  }, [open]);
  const has = target.workspaces > 0 || !!blocked;
  const connected = blocked?.connected ?? (target.link !== 'offline' && target.link !== 'pending');

  const go = async () => {
    setBusy(true);
    try {
      await connectApi.remove(target.id, has ? choice : undefined);
      toast(`${target.label} removed`);
      onRemoved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 428 && e.details) setBlocked(e.details as ConnectRemoveBlocked);
      else toast(errorText(e, 'Could not remove it.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!has)
    return (
      <ConfirmDialog
        open={open}
        title={`Remove ${target.label}?`}
        description="Nothing on the host is deleted."
        confirmLabel="Remove"
        loading={busy}
        onConfirm={() => void go()}
        onClose={() => !busy && onClose()}
      />
    );
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={`Remove ${target.label}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void go()}>
            Remove
          </Button>
        </>
      }
    >
      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="sr-only">What happens to its workspaces</legend>
        <Choice checked={choice === 'keep'} onChange={() => setChoice('keep')} label="Keep them on the host" />
        <Choice checked={choice === 'remove'} onChange={() => setChoice('remove')} label="Remove them too" disabled={!connected} hint={connected ? undefined : 'It must be connected.'} />
        <p className="mt-2 text-[13px] text-ink-soft">Nothing on the host is deleted unless you choose it.</p>
      </fieldset>
    </Dialog>
  );
}

function Choice({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean; hint?: string }) {
  return (
    <label className={`flex min-h-11 items-center gap-3 text-sm font-medium ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <input type="radio" name="remove-choice" className="size-5 shrink-0 accent-[var(--color-primary)]" checked={checked} onChange={onChange} disabled={disabled} />
      <span className="min-w-0">
        {label}
        {hint && <span className="block text-[13px] font-normal text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/** Events: collapsed, loaded when opened. */
function Events({ targetId }: { targetId: string }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<ConnectEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    setFailed(false);
    try {
      setEvents(await connectApi.events(targetId));
    } catch {
      setFailed(true);
    }
  }, [targetId]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  return (
    <section className="rounded-2xl border border-line">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="press flex min-h-11 w-full items-center gap-2 rounded-2xl px-4 py-2 text-left">
        <h3 className="flex-1 text-sm font-semibold text-ink-soft">Events</h3>
        <ChevronDown className={`size-4 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-line px-4 py-2">
          {failed && <LoadError onRetry={load} className="flex flex-col items-start gap-3" />}
          {!events && !failed && <div className="h-24 animate-pulse rounded-xl bg-surface-2" aria-label="Loading events" />}
          {events && events.length === 0 && <p className="py-2 text-[13px] text-muted">No events yet</p>}
          {events && events.length > 0 && (
            <ul className="max-h-64 divide-y divide-line overflow-auto">
              {events.map((e) => (
                <li key={e.id} className="flex min-w-0 items-baseline gap-3 py-2 text-[13px]">
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    <span className="font-medium">{e.type}</span>
                    <span className="text-muted"> · {e.actor}</span>
                  </span>
                  <time dateTime={e.at} title={formatDateTime(e.at)} className="shrink-0 tabular-nums text-muted">
                    {timeAgo(e.at)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
