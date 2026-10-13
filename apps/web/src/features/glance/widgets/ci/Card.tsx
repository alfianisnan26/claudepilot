import { StatusIcon } from '@/features/ci/parts';
import { useGlance } from '../shared/store';
import { CardFoot, CardList, CardRow, Stat, Stats } from '../shared/card';
import { shortAgo } from '../shared/format';
import { GlanceFailed, GlanceLine, GlanceSkeleton, StaleNote } from '../shared/states';
import { useNow } from '../shared/useNow';
import { ciView, holdsDeploy } from './model';
import { ciStore } from './store';

/** Home's CI: deploys waiting for your approval, failures that still stand, what runs now, and the last runs; a tap opens a run. */
export function CiCard() {
  const { data, failed, denied, stale, reload } = ciStore.use();
  const glance = useGlance();
  const now = useNow();
  if (!data) return failed ? <GlanceFailed reload={reload} denied={denied} /> : <GlanceSkeleton />;
  const v = ciView(data, glance.data);
  return (
    <>
      {stale && <StaleNote reload={reload} />}
      <Stats>
        <Stat value={v.deploys} label="To approve" tone={v.deploys ? 'danger' : undefined} to={v.deploys ? '/admin/home?glance=attention' : undefined} />
        <Stat value={v.failing} label="Failing" tone={v.failing ? 'danger' : undefined} />
        <Stat value={v.active} label="Running" tone={v.active ? 'accent' : undefined} />
      </Stats>
      {v.runs.length === 0 ? (
        <GlanceLine>No runs yet.</GlanceLine>
      ) : (
        <CardList label="Last runs">
          {v.runs.map((r) => {
            const held = holdsDeploy(r);
            const where = [r.branch ?? r.tag ?? 'tag', held ? 'waits for approval' : null, r.subject].filter(Boolean).join(' · ');
            return (
              <CardRow
                key={r.id}
                to={`/admin/ci/runs/${encodeURIComponent(r.id)}`}
                label={`${r.repo} ${r.pipeline} #${r.number}: ${held ? 'waiting for approval' : r.status}. ${where}`}
                lead={<StatusIcon status={held ? 'waiting' : r.status} className="[&_svg]:size-4" />}
                title={`${r.repo} · ${r.pipeline} #${r.number}`}
                meta={<span className="min-w-0 truncate">{where}</span>}
                trail={shortAgo(r.finishedAt ?? r.startedAt ?? r.createdAt, now)}
              />
            );
          })}
        </CardList>
      )}
      <CardFoot to="/admin/ci">All runs</CardFoot>
    </>
  );
}
