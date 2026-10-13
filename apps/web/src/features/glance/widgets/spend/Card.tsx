import { InfoTip } from '@/components/InfoTip';
import { CardFoot } from '../shared/card';
import { GlanceFailed, GlanceSkeleton, StaleNote } from '../shared/states';
import { spendView, type SpendFigure } from './model';
import { spendStore } from './store';

/** Home's Usage: what the recorded requests cost and used today and this week (dollars are an estimate, and say so). */
export function SpendCard() {
  const { data, failed, denied, stale, reload } = spendStore.use();
  if (!data) return failed ? <GlanceFailed reload={reload} denied={denied} /> : <GlanceSkeleton />;
  const v = spendView(data);
  return (
    <>
      {stale && <StaleNote reload={reload} />}
      <dl className="grid grid-cols-2 gap-2">
        <Period label="Today" f={v.today} />
        <Period label="This week" f={v.week} />
      </dl>
      <p className="mt-2 flex items-center justify-center gap-1 text-xs text-muted">
        Month <span className="font-semibold text-ink tabular-nums">{v.month.cost}</span> est.
        <InfoTip label="About these figures">
          Dollars are Claude Code’s own price estimate (for a plan, what the use would cost at API prices, not a bill). Tokens are input, output and cache writes of the requests the portal recorded; terminal use is not recorded. Days and weeks (from Monday) follow the time zone {v.timezone}.
        </InfoTip>
      </p>
      <CardFoot to="/admin/usage">Usage</CardFoot>
    </>
  );
}

function Period({ label, f }: { label: string; f: SpendFigure | null }) {
  return (
    <div className="min-w-0 rounded-2xl bg-surface-2 px-3 py-2.5">
      <dt className="text-xs text-muted">{label}</dt>
      {f ? (
        <dd className="min-w-0">
          <span className="flex items-baseline gap-1">
            <span className="truncate text-xl leading-7 font-bold tabular-nums">{f.cost}</span>
            <span className="text-[11px] text-muted">est.</span>
          </span>
          <span className="block truncate text-xs text-muted tabular-nums">
            {f.tokens} tokens · {f.requests} {f.requests === 1 ? 'request' : 'requests'}
          </span>
        </dd>
      ) : (
        <dd className="flex items-center text-xl leading-7 font-bold text-muted">
          -<InfoTip label={`Why ${label.toLowerCase()} is not available`}>This portal does not report it yet.</InfoTip>
        </dd>
      )}
    </div>
  );
}
