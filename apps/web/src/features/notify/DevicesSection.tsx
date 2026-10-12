import { Titled } from './Titled';
import { Badge, Button, ConfirmDialog, Menu, Section, useToast, type MenuItem } from '@isnanme/ui';
import type { NotifyDestination, NotifyOverview } from '@portal/contracts';
import { Hash, MessageSquare, Plus, Smartphone, Webhook } from 'lucide-react';
import { useState } from 'react';
import { errorText } from '@/lib/api';
import { notifyApi } from './api';
import { ClampedText } from './ClampedText';
import { ChannelDialog } from './ChannelDialog';
import { EditDialog } from './EditDialog';
import { ERROR_TEXT, stateOf } from './matrix';
import { SecretDialog } from './SecretDialog';
import { loadNotifyOverview } from './store';
import { thisDeviceId } from './deviceId';

const ICON = { push: Smartphone, webhook: Webhook, discord: MessageSquare, slack: Hash } as const;
const TYPE = { push: 'Device', webhook: 'Webhook', discord: 'Discord', slack: 'Slack' } as const;

/** The other devices and the channels: a row each (name, host, state, last error code) and a ⋯ menu. */
export function DevicesSection({ overview }: { overview: NotifyOverview }) {
  const toast = useToast();
  const mine = thisDeviceId();
  const devices = overview.destinations.filter((d) => d.type === 'push' && d.id !== mine);
  const channels = overview.destinations.filter((d) => d.type !== 'push');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<NotifyDestination | null>(null);
  const [removing, setRemoving] = useState<NotifyDestination | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [busyRemove, setBusyRemove] = useState(false);

  const test = async (d: NotifyDestination) => {
    try {
      const r = await notifyApi.test(d.id);
      if (r.ok) toast(`Test sent to ${d.name}`);
      else toast(r.error ? `${d.name}: ${ERROR_TEXT[r.error] ?? r.error}` : 'The test did not go through.', 'error');
      await loadNotifyOverview();
    } catch (e) {
      toast(errorText(e, 'Could not send the test.'), 'error');
    }
  };
  const rotate = async (d: NotifyDestination) => {
    try {
      const r = await notifyApi.rotateSecret(d.id);
      setSecret({ name: d.name, value: r.signingSecret });
    } catch (e) {
      toast(errorText(e, 'Could not make a new secret.'), 'error');
    }
  };
  const remove = async () => {
    if (!removing) return;
    setBusyRemove(true);
    try {
      await notifyApi.remove(removing.id);
      toast(`${removing.name} removed`);
      setRemoving(null);
      await loadNotifyOverview();
    } catch (e) {
      toast(errorText(e, 'Could not remove it.'), 'error');
      setRemoving(null);
    } finally {
      setBusyRemove(false);
    }
  };

  const menu = (d: NotifyDestination): MenuItem[] => [
    { label: 'Send test', onSelect: () => void test(d) },
    { label: 'Edit…', onSelect: () => setEditing(d) },
    ...(d.type === 'webhook' && d.signed ? [{ label: 'New signing secret…', onSelect: () => void rotate(d) }] : []),
    { label: 'Remove…', danger: true, onSelect: () => setRemoving(d) },
  ];

  const row = (d: NotifyDestination) => {
    const Icon = ICON[d.type];
    const st = stateOf(d);
    return (
      <li key={d.id} className="flex items-center gap-3 px-4 py-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-soft">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 font-semibold">
            <span className="min-w-0"><ClampedText>{d.name}</ClampedText></span>
            <Badge tone={st.tone} className="shrink-0">{st.label}</Badge>
          </div>
          <p className="line-clamp-2 text-[13px] break-words text-muted">
            {TYPE[d.type]}
            {d.hint ? ` · ${d.hint}` : ''}
            {d.lastError && (
              <>
                {' · '}
                <code className="font-mono text-[12px] text-danger" title={ERROR_TEXT[d.lastError]}>
                  {d.lastError}
                </code>
              </>
            )}
          </p>
        </div>
        <Menu label={`${d.name} actions`} items={menu(d)} />
      </li>
    );
  };

  return (
    <>
      {devices.length > 0 && (
        <Section title={<Titled title="Devices">Other browsers and phones that receive notifications for you.</Titled>} visibleTitle>
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">{devices.map(row)}</ul>
        </Section>
      )}
      <Section
        title={<Titled title="Channels">A signed webhook, a Discord channel or a Slack channel. The address is a secret: the portal keeps it sealed and never shows it again. It must be a public https address.</Titled>}
        visibleTitle
        action={
          <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            Add channel
          </Button>
        }
      >
        {channels.length === 0 ? (
          <p className="px-1 text-[13.5px] text-muted">None yet.</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">{channels.map(row)}</ul>
        )}
      </Section>
      <ChannelDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(c) => {
          setAdding(false);
          void loadNotifyOverview();
          if (c.signingSecret) setSecret({ name: c.destination.name, value: c.signingSecret });
          else toast(`${c.destination.name} added`);
        }}
      />
      <EditDialog destination={editing} onClose={() => setEditing(null)} />
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
      <ConfirmDialog open={!!removing} title={`Remove ${removing?.name ?? ''}`} description="It stops receiving notifications, and answers waiting for it are cancelled." confirmLabel="Remove" loading={busyRemove} onConfirm={() => void remove()} onClose={() => setRemoving(null)} />
    </>
  );
}
