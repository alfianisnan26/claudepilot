import { Titled } from './Titled';
import { Badge, Button, Section, useToast } from '@isnanme/ui';
import type { NotifyOverview } from '@portal/contracts';
import { Smartphone } from 'lucide-react';
import { useState } from 'react';
import { errorText } from '@/lib/api';
import { notifyApi } from './api';
import { ClampedText } from './ClampedText';
import { ERROR_TEXT } from './matrix';
import { SUPPORT_TEXT } from './push';
import { loadNotifyOverview } from './store';
import { usePush } from './usePush';

const TONE = { unsupported: 'neutral', install: 'warning', blocked: 'danger', off: 'neutral', on: 'success' } as const;

/** This browser: its state, "Turn on" (the only place the permission is asked), "Send test". */
export function ThisDevice({ overview }: { overview: NotifyOverview }) {
  const toast = useToast();
  const push = usePush();
  const [testing, setTesting] = useState(false);
  const text = SUPPORT_TEXT[push.support];
  const canTurnOn = push.support === 'off' && overview.state === 'ready' && !!overview.vapidPublicKey;

  const test = async () => {
    if (!push.device) return;
    setTesting(true);
    try {
      const r = await notifyApi.test(push.device.id);
      if (r.ok) toast('Test sent');
      else toast(r.error ? (ERROR_TEXT[r.error] ?? 'The test did not go through.') : 'The test did not go through.', 'error');
      await loadNotifyOverview();
    } catch (e) {
      toast(errorText(e, 'Could not send the test.'), 'error');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Section title={<Titled title="This device">Notifications arrive here even when the portal is closed. The message never carries text from a prompt, a reply or a command.</Titled>} visibleTitle>
      <div className="rounded-2xl border border-line bg-surface px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-soft">
            <Smartphone className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 font-semibold">
              <span className="min-w-0"><ClampedText>{push.device?.name ?? 'This browser'}</ClampedText></span>
              <Badge tone={TONE[push.support]} className="shrink-0">{text.label}</Badge>
            </div>
            <p className="text-[13px] text-muted">
              {push.device
                ? push.device.lastError
                  ? `Last error ${push.device.lastError}`
                  : push.device.lastOkAt
                    ? `Last delivery ${new Date(push.device.lastOkAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`
                    : 'Nothing sent yet'
                : (text.help ?? 'Not receiving notifications yet.')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {push.support === 'on' && (
              <>
                <Button variant="secondary" loading={testing} disabled={!push.device} onClick={() => void test()}>
                  Send test
                </Button>
                <Button variant="ghost" loading={push.busy} onClick={() => void push.turnOff()}>
                  Turn off
                </Button>
              </>
            )}
            {push.support === 'off' && (
              <Button disabled={!canTurnOn} loading={push.busy} onClick={() => void push.turnOn()}>
                Turn on
              </Button>
            )}
          </div>
        </div>
        {push.error && (
          <p role="alert" className="mt-2 text-[13px] text-danger">
            {push.error}
          </p>
        )}
        {push.support === 'off' && !overview.vapidPublicKey && overview.state === 'ready' && <p className="mt-2 text-[13px] text-muted">The portal is making its push key. Try again in a moment.</p>}
      </div>
    </Section>
  );
}
