import { InfoTip } from '@/components/InfoTip';
import { LevelDot } from '../../ui';
import { Stat, Stats } from '../shared/card';
import { shortAgo } from '../shared/format';
import { GlanceFailed, GlanceLine, GlanceSkeleton, StaleNote } from '../shared/states';
import { useNow } from '../shared/useNow';
import { actionLevel, actionLine, flowView, quietLine } from './model';
import { flowStore } from './store';

/** Home's Flow: the counts over the programs (the stall as a status line) and the watchdog's last five actions (T-1966). */
export function FlowCard() {
  const { data, failed, denied, stale, reload } = flowStore.use();
  const now = useNow();
  if (!data) return failed ? <GlanceFailed reload={reload} denied={denied} /> : <GlanceSkeleton />;
  const v = flowView(data);
  return (
    <div data-flow="">
      {stale && <StaleNote reload={reload} />}
      {!v.enabled && (
        <p role="status" className="mb-1 flex items-center justify-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-400">
          Off
          <InfoTip label="Why Flow is off">The flow watchdog is switched off (Settings, Flow): nothing is looked at until it is on again.</InfoTip>
        </p>
      )}
      {v.paused.length > 0 && (
        <p role="status" data-flow-paused="" className="mb-1 flex items-center justify-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-400 [overflow-wrap:anywhere]">
          Paused · {v.paused.join(', ')}
          <InfoTip label="Why Flow is paused">
            A pause holds these programs (Settings, Flow, Paused; or Keep going paused for all chats or for the program): they are still counted, but no lead is told and you are not notified.
          </InfoTip>
        </p>
      )}
      {v.stalledIn.length > 0 && (
        <p role="status" data-flow-stalled="" className="mb-1 flex items-center justify-center gap-1.5 text-xs font-semibold text-danger [overflow-wrap:anywhere]">
          <LevelDot level="critical" />
          Stalled · {v.stalledIn.join(', ')}
          <InfoTip label="What stalled means">No ticket was done in the stall window while tickets wait in review. You are notified once if it lasts after the leads were told.</InfoTip>
        </p>
      )}
      {(v.idleLanes ?? 0) > 0 && (
        <p role="status" data-flow-idle-lanes="" className="mb-1 flex items-center justify-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400 [overflow-wrap:anywhere]">
          <LevelDot level="warn" />
          Idle lanes · {v.idleLanes}
          <InfoTip label="What idle lanes means">Workers of a lead that do not move its work: builders idle past the lane threshold, or any worker idle for hours (it holds a slot), while its unit has conflicts, PRs to open or open tickets. The lead is told which to use or end, and what waits.</InfoTip>
        </p>
      )}
      {v.unread.length > 0 && (
        <p role="status" data-flow-unread="" className="mb-1 flex items-center justify-center gap-1 text-xs font-semibold text-muted [overflow-wrap:anywhere]">
          Unavailable · {v.unread.join(', ')}
          <InfoTip label="Why unavailable">The last round could not read these programs (their tickets or sessions), so their counts are unknown, not zero. The portal log says why; the next round tries again.</InfoTip>
        </p>
      )}
      {/* Four figures fit one row at 390 px; the stall and idle lanes are status lines above. */}
      <Stats>
        <Stat value={v.merge} label="Merge" tone={v.merge ? 'accent' : undefined} />
        <Stat value={v.qa} label="No QA" tone={v.qa ? 'accent' : undefined} />
        <Stat value={v.idle} label="Idle" tone={v.idle ? 'accent' : undefined} />
        <Stat value={v.bypass} label="Bypass" tone={v.bypass ? 'danger' : undefined} />
      </Stats>
      {v.actions.length === 0 ? (
        quietLine(v) && <GlanceLine>{quietLine(v)}</GlanceLine>
      ) : (
        <ul aria-label="Last actions" className="flex flex-col">
          {v.actions.map((a, i) => (
            <li key={`${a.at}-${i}`} className="flex min-h-11 min-w-0 items-center gap-3 py-1" title={a.note}>
              <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
                <LevelDot level={actionLevel(a)} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold [overflow-wrap:anywhere]">{actionLine(a)}</span>
                <span className="block truncate text-xs text-muted">{a.program}</span>
              </span>
              <span className="shrink-0 text-xs text-muted tabular-nums">{shortAgo(a.at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
