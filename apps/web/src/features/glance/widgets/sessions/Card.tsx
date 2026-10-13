import { buttonClass } from '@isnanme/ui';
import { workspaceLabel } from '@portal/contracts';
import { Pin } from 'lucide-react';
import { Link } from 'react-router';
import { ClaudeSwatch } from '@/lib/usage';
import { LevelDot } from '../../ui';
import { CardFoot, CardList, CardRow, Stat, Stats } from '../shared/card';
import { plural, shortAgo } from '../shared/format';
import { claudeKey } from '../shared/readings';
import { GlanceFailed, GlanceLine, GlanceSkeleton, StaleNote } from '../shared/states';
import { useGlance } from '../shared/store';
import { useNow } from '../shared/useNow';
import { SESSION_WORD, sessionLevel } from './model';

/**
 * Home's Sessions: the open sessions a person started, pinned first and then the latest, each with its state (and the agents running under
 * it), its Claude, where it runs and its branch, and how long ago it last did something. One tap opens it.
 */
export function SessionsCard() {
  const { data, failed, denied, stale, reload } = useGlance();
  const now = useNow();
  if (!data) return failed ? <GlanceFailed reload={reload} denied={denied} /> : <GlanceSkeleton />;
  const s = data.sessions;
  if (!s.ok) return <GlanceFailed reload={reload} message="Could not read sessions." />;
  return (
    <>
      {stale && <StaleNote reload={reload} />}
      <Stats>
        <Stat value={s.running} label="Running" tone={s.running ? 'accent' : undefined} />
        <Stat value={s.waiting} label="Waiting" tone={s.waiting ? 'danger' : undefined} to={s.waiting ? '/admin/sessions' : undefined} />
        <Stat value={s.open} label="Open" />
      </Stats>
      {s.recent.length === 0 ? (
        <GlanceLine
          action={
            <Link to="/admin/sessions?new=1" className={buttonClass('primary', 'sm')}>
              New session
            </Link>
          }
        >
          No sessions.
        </GlanceLine>
      ) : (
        <CardList label="Latest sessions">
          {s.recent.map((x) => {
            const state = `${SESSION_WORD[x.state]}${x.agents ? ` · ${plural(x.agents, 'agent')}` : ''}`;
            const where = [x.claudeName, workspaceLabel(x.workspaceId), x.branch].filter(Boolean).join(' · ');
            return (
              <CardRow
                key={x.id}
                to={`/admin/sessions/${encodeURIComponent(x.id)}`}
                label={`${x.title}: ${state.toLowerCase()}${x.pinned ? ', pinned' : ''}. ${where}`}
                lead={<LevelDot level={sessionLevel(x.state)} className={x.state === 'waiting' ? 'ring-2 ring-current/25' : undefined} />}
                title={
                  <span className="flex min-w-0 items-center gap-1">
                    {x.pinned && <Pin className="size-3 shrink-0 text-muted" aria-hidden="true" />}
                    <span className="truncate">{x.title}</span>
                  </span>
                }
                meta={
                  <>
                    <span className="shrink-0 font-medium text-ink-soft">{state}</span>
                    {x.claudeId || x.claudeName ? <ClaudeSwatch claudeId={claudeKey(x)} /> : null}
                    <span className="min-w-0 truncate">{where}</span>
                  </>
                }
                trail={shortAgo(x.lastActivityAt, now)}
              />
            );
          })}
        </CardList>
      )}
      <CardFoot to="/admin/sessions">All sessions</CardFoot>
    </>
  );
}
