import { cn } from '@isnanme/ui';
import { InfoTip } from '@/components/InfoTip';
import { LevelDot } from '../../ui';
import { CardFoot, CardList, CardRow, Stat, Stats } from '../shared/card';
import { GlanceFailed, GlanceLine, GlanceSkeleton, StaleNote } from '../shared/states';
import { pctOf, workspacesView, type WorkspaceRow } from './model';
import { workspacesStore } from './store';

const STATUS_WORD: Record<WorkspaceRow['status'], string> = {
  creating: 'Creating',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  stopped: 'Stopped',
  error: 'Failed',
  unreachable: 'Unreachable',
  unavailable: 'Unavailable',
};

/** How many rows a card lists; the rest are a tap away on the Workspaces page. */
const MAX = 6;

/**
 * Home's Workspaces: running, stopped and failing, the failing ones first; CPU and memory where the portal measured them (a running
 * workspace's last push), and the Claude Code it runs against the version its image pins.
 */
export function WorkspacesCard() {
  const { data, failed, denied, stale, reload } = workspacesStore.use();
  if (!data) return failed ? <GlanceFailed reload={reload} denied={denied} /> : <GlanceSkeleton />;
  const v = workspacesView(data.list, data.usage);
  if (v.total === 0) return <GlanceLine>No workspaces.</GlanceLine>;
  return (
    <>
      {stale && <StaleNote reload={reload} />}
      <Stats>
        <Stat value={v.running} label="Running" tone={v.running ? 'accent' : undefined} />
        <Stat value={v.stopped} label="Stopped" />
        <Stat value={v.failing} label="Failing" tone={v.failing ? 'danger' : undefined} />
      </Stats>
      <CardList label="Workspaces">
        {v.rows.slice(0, MAX).map((w) => (
          <CardRow
            key={w.id}
            to="/admin/workspaces"
            label={`${w.name} on ${w.target}: ${STATUS_WORD[w.status].toLowerCase()}${w.cpu !== null ? `, CPU ${pctOf(w.cpu)}` : ''}${w.memory !== null ? `, memory ${pctOf(w.memory)}` : ''}${w.running ? `, Claude Code ${w.running}` : ''}${w.differs ? ` (pinned ${w.pinned})` : ''}`}
            lead={<LevelDot level={w.level} />}
            title={w.name}
            meta={
              <>
                <span className="shrink-0 font-medium text-ink-soft">{STATUS_WORD[w.status]}</span>
                <span className="min-w-0 truncate">{w.bucket === 'failing' && w.detail ? w.detail : w.target}</span>
              </>
            }
            trail={<Figures w={w} />}
          />
        ))}
      </CardList>
      <CardFoot to="/admin/workspaces">{v.total > MAX ? `All ${v.total} workspaces` : 'Workspaces'}</CardFoot>
      {v.drift > 0 && (
        <p className="flex items-center justify-center gap-1 text-xs text-muted">
          {v.drift === 1 ? '1 runs' : `${v.drift} run`} another Claude Code than pinned
          <InfoTip label="About the Claude Code version">The version running in the workspace differs from the one its image was built with (the pin). Claude Code may have updated itself.</InfoTip>
        </p>
      )}
    </>
  );
}

/** CPU and memory where measured, then the Claude Code version (marked when it differs from the pin). Nothing is shown for what was not measured. */
function Figures({ w }: { w: WorkspaceRow }) {
  return (
    <span className="flex flex-col items-end gap-0.5 leading-4">
      {(w.cpu !== null || w.memory !== null) && (
        <span className="tabular-nums">
          {w.cpu !== null && <span className={cn(w.cpu > 0.9 && 'font-semibold text-danger')}>CPU {pctOf(w.cpu)}</span>}
          {w.cpu !== null && w.memory !== null && ' · '}
          {w.memory !== null && <span className={cn(w.memory > 0.9 && 'font-semibold text-danger')}>RAM {pctOf(w.memory)}</span>}
        </span>
      )}
      {w.running && <span className={cn('font-mono text-[11px]', w.differs && 'font-semibold text-ink')}>{w.differs ? `${w.running} ≠ ${w.pinned}` : w.running}</span>}
    </span>
  );
}
