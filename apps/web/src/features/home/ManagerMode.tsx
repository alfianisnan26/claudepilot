import { Button, cn, useToast } from '@isnanme/ui';
import type { ManagerStatus } from '@portal/contracts';
import { Bot, LayoutDashboard, Power } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { api, errorText } from '@/lib/api';

const SessionPage = lazy(() => import('@/features/chat/SessionPage').then((m) => ({ default: m.SessionPage })));

export type HomeMode = 'dashboard' | 'manager';
const MODE_KEY = 'home.mode';

export function readHomeMode(): HomeMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'manager' ? 'manager' : 'dashboard';
  } catch {
    return 'dashboard';
  }
}
export function saveHomeMode(m: HomeMode): void {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    // storage unavailable: the choice lasts this page only
  }
}

/** The Dashboard | Manager switch (D-80, T-968 S3): icon-only on a phone, 44 px. */
export function HomeModeSwitch({ mode, onMode }: { mode: HomeMode; onMode: (m: HomeMode) => void }) {
  return (
    <div role="group" aria-label="Home mode" className="flex rounded-full border border-line p-0.5">
      {(
        [
          ['dashboard', 'Dashboard', LayoutDashboard],
          ['manager', 'Manager', Bot],
        ] as const
      ).map(([m, label, Icon]) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          aria-label={label}
          onClick={() => onMode(m)}
          className={cn('press flex min-h-10 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold', mode === m ? 'bg-ink text-bg' : 'text-ink-soft hover:text-ink')}
        >
          <Icon className="size-4" aria-hidden="true" />
          <span className="max-sm:sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Manager mode (D-80, T-968): the person's ONE General Manager. It is its own session, made by the portal on Enable, never in the Sessions
 * list, working only through the pilot's tools as this person (no files, no shell, no web), there to watch and steer the crews and their
 * leads: the coordinator's job, not ticket work. Enabled, Home shows its chat at full height (Back returns to the dashboard); not yet, one
 * card to turn it on and choose where it runs.
 */
export function ManagerMode({ onBack }: { onBack: () => void }) {
  const toast = useToast();
  const [st, setSt] = useState<ManagerStatus | null>(null);
  const [where, setWhere] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.managerStatus();
      setSt(s);
      setWhere((w) => w || s.candidates[0]?.id || '');
    } catch (e) {
      toast(errorText(e, 'Couldn’t read the manager.'), 'error');
    }
  }, [toast]);
  useEffect(() => void load(), [load]);

  const enable = async () => {
    setBusy(true);
    try {
      setSt(await api.enableManager(where || undefined));
      toast('General Manager is on');
    } catch (e) {
      toast(errorText(e, 'Couldn’t turn it on.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (st?.enabled && st.sessionId)
    return (
      <Suspense fallback={<div className="skeleton h-28 rounded-[24px]" />}>
        <SessionPage sessionId={st.sessionId} onBack={onBack} />
      </Suspense>
    );

  return (
    <Card className="p-4 sm:p-5" data-manager-enable="">
      <h2 className="mb-1 flex items-center gap-1 text-[15px] font-semibold">
        General Manager
        <InfoTip label="About the General Manager">
          Your one chat for the whole pilot. It watches every crew and its lead, routes work, follows CI and deploys, and turns what you report
          into tickets. It manages; it does not work tickets itself. It acts only through the pilot’s tools, as you: no files, no shell, no
          web. Production, a release approval, deleting data and credentials stay your decision in its chat.
        </InfoTip>
      </h2>
      {st === null ? (
        <div className="skeleton mt-2 h-10 rounded-xl" />
      ) : st.candidates.length === 0 ? (
        <p className="text-sm text-muted">It runs on a Claude in one of your workspaces: start a workspace with a signed-in Claude first.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1 text-sm font-semibold text-ink-soft">
              Runs on
              <InfoTip label="About where it runs">The workspace whose Claudes it uses (auto move works as for any session). It gets an empty folder there and no tool to touch it.</InfoTip>
            </span>
            <select value={where} onChange={(e) => setWhere(e.target.value)} className="h-12 w-full rounded-2xl border border-line bg-surface px-3 text-[15px]">
              {st.candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <Button size="lg" loading={busy} onClick={() => void enable()} icon={<Power className="size-4" />} className="w-full">
            Enable
          </Button>
        </div>
      )}
    </Card>
  );
}
