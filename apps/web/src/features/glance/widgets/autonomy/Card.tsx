import { InfoTip } from '@/components/InfoTip';
import { LevelDot } from '../../ui';
import { CardList, CardRow, Stat, Stats } from '../shared/card';
import { shortAgo } from '../shared/format';
import { GlanceFailed, GlanceLine, GlanceSkeleton, StaleNote } from '../shared/states';
import { useNow } from '../shared/useNow';
import { autonomyView } from './model';
import { autonomyStore } from './store';

/** Home's Autonomy: the chats kept going, the ones left down first, each with its state and Keep going's last action; a tap opens the chat. */
export function AutonomyCard() {
  const { data, failed, denied, stale, reload } = autonomyStore.use();
  const now = useNow();
  if (!data) return failed ? <GlanceFailed reload={reload} denied={denied} /> : <GlanceSkeleton />;
  const v = autonomyView(data);
  return (
    <div data-autonomy="">
      {stale && <StaleNote reload={reload} />}
      {v.paused && (
        <p role="status" className="mb-1 flex items-center justify-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-400">
          Paused
          <InfoTip label="Why Keep going is paused">Keep going is switched off for the whole portal (Settings, Keep going): nothing is watched until it is on again.</InfoTip>
        </p>
      )}
      <Stats>
        <Stat value={v.watched} label="Watched" tone={v.watched ? 'accent' : undefined} />
        <Stat value={v.down} label="Down" tone={v.down ? 'danger' : undefined} />
        <Stat value={v.reported} label="Reported" tone={v.reported ? 'danger' : undefined} />
        <Stat value={v.actions} label="Today" />
      </Stats>
      {v.rows.length === 0 ? (
        <GlanceLine>No chat has Keep going on.</GlanceLine>
      ) : (
        <CardList label="Chats kept going">
          {v.rows.map((r) => {
            const meta = [r.state, r.what].filter(Boolean).join(' · ');
            return (
              <CardRow
                key={r.id}
                to={`/admin/sessions/${encodeURIComponent(r.id)}`}
                label={`${r.title}, ${r.workspace}: ${meta}`}
                lead={<LevelDot level={r.level} />}
                title={r.title}
                meta={<span className="min-w-0 truncate">{meta}</span>}
                trail={r.at ? shortAgo(r.at, now) : undefined}
              />
            );
          })}
        </CardList>
      )}
    </div>
  );
}
