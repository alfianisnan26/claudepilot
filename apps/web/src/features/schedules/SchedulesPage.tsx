import { Badge, Button, useToast } from '@isnanme/ui';
import type { AppPortSession, PortalLoop, Trigger } from '@portal/contracts';
import { AppWindow, CalendarClock, RefreshCw, Repeat, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { api, errorText } from '@/lib/api';
import { timeAgo } from '@/lib/format';

/** `every 30 s`, `every 6 h`, `daily`. */
export function everyText(ms: number): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return ms === 86_400_000 ? 'daily' : `every ${ms / 86_400_000} d`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `every ${ms / 3_600_000} h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `every ${ms / 60_000} min`;
  return `every ${Math.round(ms / 1000)} s`;
}

function Section({ id, title, tip, children }: { id: string; title: string; tip: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-6 first:mt-0">
      <h2 id={id} className="mb-2 flex items-center gap-1 px-1 text-[13px] font-semibold text-muted">
        {title}
        <InfoTip label={`About ${title}`}>{tip}</InfoTip>
      </h2>
      <Card>{children}</Card>
    </section>
  );
}

const Empty = ({ text }: { text: string }) => <p className="px-4 py-4 text-sm text-muted sm:px-5">{text}</p>;
const Loading = () => <div className="skeleton m-4 h-10 rounded-xl" />;

/**
 * Schedules (owner, 2026-10-18: "list of scheduler as well", "list of running browser proxy session"; T-965): what runs by itself in one
 * place. The cron triggers (their next and last run), the portal's own background loops (each measured on every run: when, how long, ok or
 * the failure), and the open app sessions (App mode hosts with a live cookie, each one can be ended). Numbers come from the server; a loop
 * that has not run yet says so.
 */
export function SchedulesPage() {
  const toast = useToast();
  const [loops, setLoops] = useState<PortalLoop[] | null>(null);
  const [triggers, setTriggers] = useState<Trigger[] | null>(null);
  const [apps, setApps] = useState<AppPortSession[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const [l, t, a] = await Promise.allSettled([api.portalLoops(), api.triggers(), api.appSessions()]);
    setLoops(l.status === 'fulfilled' ? l.value : []);
    setTriggers(t.status === 'fulfilled' ? t.value.filter((x) => x.source === 'cron') : []);
    setApps(a.status === 'fulfilled' ? a.value : []);
    for (const r of [l, t, a]) if (r.status === 'rejected') toast(errorText(r.reason, 'Couldn’t load everything.'), 'error');
    setBusy(false);
  }, [toast]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const close = async (s: AppPortSession) => {
    try {
      await api.closeAppSession(s.id);
      toast('App session ended');
      await load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t end it.'), 'error');
    }
  };

  return (
    <div data-schedules-page="">
      <PageHeader
        title="Schedules"
        description="What runs by itself: cron triggers, the portal’s own loops and the apps open in App mode. Refreshes every 30 seconds."
        action={
          <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void load()} loading={busy}>
            <RefreshCw className="size-[18px]" />
          </Button>
        }
      />

      <Section id="sched-triggers" title="Cron triggers" tip="Triggers that start an agent or a ticket on a schedule. Make and change them under Triggers.">
        {triggers === null ? (
          <Loading />
        ) : triggers.length === 0 ? (
          <Empty text="No cron triggers." />
        ) : (
          <ul className="divide-y divide-line">
            {triggers.map((t) => (
              <li key={t.id} className="flex min-h-14 items-center gap-3 px-4 py-2 sm:px-5">
                <CalendarClock className="size-4 shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium [overflow-wrap:anywhere]">{t.name}</span>
                  <span className="block text-[12.5px] text-muted [overflow-wrap:anywhere]">
                    <code>{t.cron?.expr}</code> {t.cron?.tz} · next {t.nextRunAt ? timeAgo(t.nextRunAt) : 'none'} · last {t.lastRunAt ? timeAgo(t.lastRunAt) : 'never'} · {t.runsToday} today
                  </span>
                </span>
                <Badge tone={t.enabled ? 'success' : 'neutral'}>{t.enabled ? 'On' : 'Off'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="sched-loops" title="Portal loops" tip="The portal’s own background work. Each run is measured: when it last ran, how long it took, and whether it failed. Since the portal’s last start.">
        {loops === null ? (
          <Loading />
        ) : loops.length === 0 ? (
          <Empty text="No loops reported." />
        ) : (
          <ul className="divide-y divide-line">
            {loops.map((l) => (
              <li key={l.id} className="flex min-h-14 items-center gap-3 px-4 py-2 sm:px-5">
                <Repeat className="size-4 shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium [overflow-wrap:anywhere]">{l.what}</span>
                  <span className="block text-[12.5px] text-muted [overflow-wrap:anywhere]">
                    {everyText(l.everyMs)} · {l.lastRunAt ? `last ${timeAgo(l.lastRunAt)}${l.lastMs !== null ? `, ${l.lastMs} ms` : ''}` : 'not run yet'} · {l.runs} runs
                    {l.failures ? `, ${l.failures} failed` : ''}
                    {l.lastOk === false && l.lastError ? ` · ${l.lastError}` : ''}
                  </span>
                </span>
                <Badge tone={l.lastOk === false ? 'danger' : l.lastOk ? 'success' : 'neutral'}>{l.lastOk === false ? 'Failed' : l.lastOk ? 'OK' : 'Waiting'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="sched-apps" title="Open apps" tip="Apps opened in App mode (Browser, App) whose sign-in on the app’s own address still lives. Ending one signs that address out at once.">
        {apps === null ? (
          <Loading />
        ) : apps.length === 0 ? (
          <Empty text="No app is open." />
        ) : (
          <ul className="divide-y divide-line">
            {apps.map((s) => (
              <li key={s.id} className="flex min-h-14 items-center gap-3 px-4 py-2 sm:px-5">
                <AppWindow className="size-4 shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <a href={`https://${s.host}/`} target="_blank" rel="noreferrer" className="block font-medium [overflow-wrap:anywhere] hover:text-accent">
                    {s.host}
                  </a>
                  <span className="block text-[12.5px] text-muted [overflow-wrap:anywhere]">
                    {s.workspaceId} · port {s.port} · {s.openedBy === 'ui' ? 'server code' : s.openedBy}
                    {s.lastUsedAt ? ` · used ${timeAgo(s.lastUsedAt)}` : ''} · ends {timeAgo(s.expiresAt)}
                  </span>
                </span>
                <Button variant="ghost" size="icon" aria-label={`End ${s.host}`} onClick={() => void close(s)}>
                  <Trash2 className="size-[18px]" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
