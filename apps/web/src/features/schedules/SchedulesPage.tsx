import { Badge, Button, Segmented, Switch, useToast } from '@isnanme/ui';
import type { AppPortSession, ScheduleKind, ScheduleRow } from '@portal/contracts';
import { Activity, AppWindow, CalendarClock, Play, RefreshCw, Repeat, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { api, errorText } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import {
  attentionCount,
  canRunNow,
  canSwitch,
  detailText,
  type KindFilter,
  type ListLoad,
  settleList,
  STATE_LABEL,
  STATE_TONE,
  triggerIdOf,
  visibleRows,
} from './model';

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

/** A failed load says so, never the empty text; the reason is in an InfoTip, with a Retry button (T-965 UX finding). */
function LoadError({ what, message, onRetry, busy }: { what: string; message: string; onRetry: () => void; busy: boolean }) {
  return (
    <div role="alert" data-load-error={what} className="flex min-h-14 items-center gap-2 px-4 py-2 sm:px-5">
      <p className="flex min-w-0 flex-1 items-center gap-1 text-sm text-danger">
        Couldn’t load {what}.<InfoTip label={`Why ${what} did not load`}>{message}</InfoTip>
      </p>
      <Button variant="secondary" className="min-h-11" onClick={onRetry} loading={busy}>
        Retry
      </Button>
    </div>
  );
}

/** One list's body by its load: the skeleton, the error with Retry, the empty text, or the rows. */
function ListBody<T>(p: {
  load: ListLoad<T>;
  what: string;
  empty: string;
  onRetry: () => void;
  busy: boolean;
  children: (items: T[]) => React.ReactNode;
}) {
  const { load } = p;
  if (load.status === 'loading') return <Loading />;
  if (load.status === 'error') return <LoadError what={p.what} message={load.message} onRetry={p.onRetry} busy={p.busy} />;
  return load.items.length === 0 ? <Empty text={p.empty} /> : p.children(load.items);
}

const KIND_ICON: Record<ScheduleKind, typeof Repeat> = { loop: Repeat, trigger: CalendarClock, helper: Activity };
const FILTERS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'loop', label: 'Loops' },
  { value: 'trigger', label: 'Triggers' },
  { value: 'helper', label: 'Helpers' },
];
const EMPTY: Record<KindFilter, string> = {
  all: 'Nothing runs by itself.',
  loop: 'No loops reported.',
  trigger: 'No triggers.',
  helper: 'No helper has reported.',
};

/**
 * Schedules (owner, 2026-10-18: "list of scheduler as well", "list of running browser proxy session"; T-965): what runs by itself in one
 * place, from `GET /api/schedules`: the portal's own loops, every trigger (cron, a failed CI run, a webhook) and the helpers outside the portal
 * that send a heartbeat (the supervisor). Failing and late ones first; a trigger can be switched on or off and run now (the trigger routes,
 * which check the person's right on that trigger). Below, the open app sessions (App mode hosts with a live cookie, each one can be ended).
 */
export function SchedulesPage() {
  const toast = useToast();
  const [jobs, setJobs] = useState<ListLoad<ScheduleRow>>({ status: 'loading' });
  const [apps, setApps] = useState<ListLoad<AppPortSession>>({ status: 'loading' });
  const [kind, setKind] = useState<KindFilter>('all');
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    const [s, a] = await Promise.allSettled([api.schedules(), api.appSessions()]);
    setJobs(settleList(s, (e) => errorText(e, 'No answer from the portal.')));
    setApps(settleList(a, (e) => errorText(e, 'No answer from the portal.')));
    setBusy(false);
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const rows = jobs.status === 'ready' ? jobs.items : null;
  const shown = useMemo<ListLoad<ScheduleRow>>(
    () => (rows ? { status: 'ready', items: visibleRows(rows, kind) } : jobs),
    [rows, jobs, kind],
  );
  const late = rows ? attentionCount(rows) : 0;

  const act = async (r: ScheduleRow, what: 'switch' | 'run') => {
    setActing(r.id);
    try {
      if (what === 'switch') {
        await api.setTriggerEnabled(triggerIdOf(r), !r.enabled);
        toast(r.enabled ? `${r.name} is off` : `${r.name} is on`);
      } else {
        await api.runTrigger(triggerIdOf(r));
        toast(`${r.name} started`);
      }
      await load();
    } catch (e) {
      toast(errorText(e, what === 'switch' ? 'Couldn’t switch it.' : 'Couldn’t run it.'), 'error');
    } finally {
      setActing(null);
    }
  };

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
        description={`What runs by itself: the portal’s loops, triggers and helpers, and the apps open in App mode. Refreshes every 30 seconds.${late ? ` ${late} need a look.` : ''}`}
        action={
          <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void load()} loading={busy}>
            <RefreshCw className="size-[18px]" />
          </Button>
        }
      />

      <div className="mb-3">
        <Segmented<KindFilter> label="Show" value={kind} onChange={setKind} options={FILTERS} />
      </div>

      <Section
        id="sched-jobs"
        title="Jobs"
        tip="Loops: the portal’s own background work. Triggers: start an agent or a ticket on a schedule, a failed CI run or a webhook. Helpers: programs outside the portal that report with a heartbeat. Failing and late ones come first; late means no run or heartbeat for two intervals."
      >
        <ListBody load={shown} what="jobs" empty={EMPTY[kind]} onRetry={() => void load()} busy={busy}>
          {(items) => (
            <ul className="divide-y divide-line" data-schedule-list="">
              {items.map((r) => {
                const Icon = KIND_ICON[r.kind];
                return (
                  <li
                    key={r.id}
                    data-schedule-row={r.id}
                    data-state={r.state}
                    className="flex min-h-14 items-center gap-3 px-4 py-2 sm:px-5"
                  >
                    <Icon className="size-4 shrink-0 text-muted" role="img" aria-label={r.kind} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{r.name}</span>
                        <Badge tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state]}</Badge>
                        {r.description ? <InfoTip label={`About ${r.name}`}>{r.description}</InfoTip> : null}
                      </span>
                      <span className="block text-[12.5px] text-muted [overflow-wrap:anywhere]">
                        {detailText(r, (iso) => timeAgo(iso))}
                      </span>
                    </span>
                    {canRunNow(r) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Run ${r.name} now`}
                        disabled={acting !== null}
                        loading={acting === r.id}
                        onClick={() => void act(r, 'run')}
                      >
                        <Play className="size-[18px]" />
                      </Button>
                    ) : null}
                    {canSwitch(r) ? (
                      <Switch
                        checked={!!r.enabled}
                        label={`${r.name} on`}
                        disabled={acting !== null}
                        onChange={() => void act(r, 'switch')}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </ListBody>
      </Section>

      <Section id="sched-apps" title="Open apps" tip="Apps opened in App mode (Browser, App) whose sign-in on the app’s own address still lives. Ending one signs that address out at once.">
        <ListBody load={apps} what="open apps" empty="No app is open." onRetry={() => void load()} busy={busy}>
          {(items) => (
            <ul className="divide-y divide-line">
              {items.map((s) => (
                <li key={s.id} className="flex min-h-14 items-center gap-3 px-4 py-2 sm:px-5">
                  <AppWindow className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <a
                      href={`https://${s.host}/`}
                      target="_blank"
                      rel="noreferrer"
                      className="block font-medium [overflow-wrap:anywhere] hover:text-accent"
                    >
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
        </ListBody>
      </Section>
    </div>
  );
}
