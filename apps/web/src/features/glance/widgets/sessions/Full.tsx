import { buttonClass } from '@isnanme/ui';
import type { GlanceSession } from '@portal/contracts';
import { Link } from 'react-router';
import { ClaudeSwatch } from '@/lib/usage';
import { GlanceList, GlanceRow, LevelDot } from '../../ui';
import type { GlanceFullProps } from '../../types';
import { compactCount, shortAgo } from '../shared/format';
import { claudeKey } from '../shared/readings';
import { GlanceFailed, GlanceLine, GlanceSkeleton, StaleNote } from '../shared/states';
import { useEngaged, useSteadyRows } from '../shared/steady';
import { useGlance } from '../shared/store';
import { useNow } from '../shared/useNow';
import { sessionLevel, sessionSubline, sessionTitle } from './model';

const NONE: GlanceSession[] = [];
const keyOf = (s: GlanceSession) => s.id;

/** Sessions: what runs, what waits for you, what you used last. One tap opens the session. */
export function SessionsFull({ close }: GlanceFullProps) {
  const { data, failed, denied, stale, reload } = useGlance();
  const now = useNow();
  // The list stays exactly as it is while the pointer is over it or focus is in it: a row never moves under a press, and a new one waits.
  const { engaged, bind } = useEngaged();
  const rows = useSteadyRows(data?.sessions.items ?? NONE, keyOf, engaged, true);
  if (!data) return failed ? <GlanceFailed reload={reload} denied={denied} /> : <GlanceSkeleton />;
  const s = data.sessions;
  if (!s.ok) return <GlanceFailed reload={reload} message="Could not read agents." />;
  const listedOpen = s.items.filter((x) => x.state !== 'ended').length;
  const more = s.open - listedOpen;
  return (
    <>
      {stale && <StaleNote reload={reload} />}
      {rows.length === 0 ? (
        <GlanceLine
          action={
            <Link to="/admin/sessions?new=1" onClick={close} className={buttonClass('primary', 'sm')}>
              New session
            </Link>
          }
        >
          No agents.
        </GlanceLine>
      ) : (
        <div {...bind}>
          <GlanceList label="Agents">
            {rows.map(({ row: x, gone }) => {
              const line = sessionSubline(x);
              return (
                <GlanceRow key={x.id} className={`p-0 ${gone ? 'opacity-60' : ''}`}>
                  <Link
                    to={`/admin/sessions/${encodeURIComponent(x.id)}`}
                    onClick={close}
                    aria-label={sessionTitle(x)}
                    className="press -mx-2 flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-2"
                  >
                    <LevelDot level={sessionLevel(x.state)} className={x.state === 'waiting' ? 'ring-2 ring-current/25' : undefined} />
                    <span className="min-w-0 flex-1">
                      <span dir="auto" title={x.title} className={`block truncate text-sm font-semibold ${x.state === 'ended' ? 'text-muted' : ''}`}>
                        {x.title}
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                        {x.claudeId || x.claudeName ? <ClaudeSwatch claudeId={claudeKey(x)} /> : null}
                        <span className="shrink-0 font-medium text-ink-soft">{line.state}</span>
                        <span dir="auto" className="min-w-0 truncate">
                          {line.rest}
                        </span>
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted tabular-nums" title={new Date(x.lastActivityAt).toLocaleString()}>
                      {shortAgo(x.lastActivityAt, now)}
                    </span>
                  </Link>
                </GlanceRow>
              );
            })}
          </GlanceList>
        </div>
      )}
      {more > 0 && (
        <Link to="/admin/sessions" onClick={close} className="press mt-1 flex min-h-11 items-center justify-center rounded-xl text-xs text-muted hover:bg-surface-2 hover:text-ink">
          +{compactCount(more)} more
        </Link>
      )}
    </>
  );
}
