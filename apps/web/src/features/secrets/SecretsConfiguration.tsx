import { Badge, Button, Spinner } from '@isnanme/ui';
import type { SecretsMigrationCheck, Workspace, WorkspacePoolAssignment, WorkspaceSecrets } from '@portal/contracts';
import { FolderSearch, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { errorText } from '@/lib/api';
import { useLive } from '@/lib/live';
import { secretsApi } from './api';

/**
 * The Secrets row's detail in a workspace's Configuration (PRD §12): what its sets deliver, by name only,
 * when changes apply, what the deny rules cover, names still on their way out (A6), and the migration
 * check of the home folder (FR15).
 */
export function SecretsConfiguration({ workspace, assignments }: { workspace: Workspace; assignments: WorkspacePoolAssignment[] }) {
  const [data, setData] = useState<WorkspaceSecrets | null>(null);
  const [check, setCheck] = useState<SecretsMigrationCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const running = workspace.status === 'running';
  const id = workspace.id;

  const load = useCallback(async () => {
    try {
      setData(await secretsApi.workspace(id));
    } catch {
      setData(null);
    }
  }, [id]);
  useEffect(() => void load(), [load, assignments.length]);
  useLive('pools', () => void load());

  const runCheck = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    try {
      setCheck(await secretsApi.check(id));
    } catch (e) {
      setCheckError(errorText(e, 'Could not check.'));
    } finally {
      setChecking(false);
    }
  }, [id]);
  // Once per opening while it runs: one exec that reports names only.
  useEffect(() => {
    if (running) void runCheck();
  }, [running, runCheck]);

  const sets = data?.sets ?? [];
  const delivering = sets.some((s) => s.variables.length || s.files.length);
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      {sets.map((s) => (
        <div key={s.poolId} className="flex flex-col gap-1">
          {sets.length > 1 && <p className="font-semibold text-ink-soft">{s.poolName}</p>}
          <Names label="Variables" names={[...s.variables, ...s.pointers, ...s.exposed]} />
          <Names label="Files" names={s.files} mark={new Set(s.exposed)} />
          {s.needsValue.length > 0 && (
            <p className="text-ink-soft">
              <Badge tone="warning">Needs value</Badge> <span className="font-mono text-[12px]">{s.needsValue.join(', ')}</span> not delivered until a value is saved.
            </p>
          )}
        </div>
      ))}
      {data && data.removing.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl bg-flame-soft px-3 py-2 text-ink-soft">
          <RotateCcw className="mt-0.5 size-4 shrink-0" />
          <span>
            Restart to finish removing {data.removing.length} variable{data.removing.length === 1 ? '' : 's'} (<span className="font-mono text-[12px]">{data.removing.join(', ')}</span>): sessions that
            started before keep a blank value until they end.
          </span>
        </p>
      )}
      {delivering && (
        <ul className="flex flex-col gap-1 text-muted">
          <li>Claude Code gets changes at its next command. Open terminals need a new shell, or <code className="font-mono text-[12px]">. /etc/claudepilot/secrets/env.sh</code>; running servers need a restart.</li>
          <li>
            <Badge tone="neutral">Guidance</Badge> Deny rules stop Claude’s Read and Edit tools on these files{data?.exposesVariables ? ' and on process environments' : ''}, not every command.
          </li>
        </ul>
      )}
      <div className="flex flex-col gap-1.5 rounded-xl bg-surface-2 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <FolderSearch className="size-4 shrink-0 text-muted" />
          <p className="flex-1 font-semibold text-ink-soft">Home folder credentials</p>
          <Button variant="ghost" size="sm" onClick={() => void runCheck()} disabled={!running || checking}>
            {checking ? <Spinner className="size-3" /> : 'Check again'}
          </Button>
        </div>
        {!running ? (
          <p className="text-muted">Checked while the workspace runs.</p>
        ) : checkError ? (
          <p className="text-danger">{checkError}</p>
        ) : !check ? (
          <p className="text-muted">Checking…</p>
        ) : !check.findings || check.findings.length === 0 ? (
          <p className="text-muted">None found: nothing in the home folder competes with the portal’s.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {check.findings.map((f) => (
              <li key={f.id}>
                <span className="font-mono text-[12px] text-ink">{f.label}</span>
                <span className="block text-muted">{f.cleanup}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Names({ label, names, mark }: { label: string; names: string[]; mark?: Set<string> }) {
  if (names.length === 0) return null;
  return (
    <p className="text-ink-soft">
      <span className="text-muted">{label}: </span>
      <span className="font-mono text-[12px]">
        {names.map((n, i) => (
          <span key={n}>
            {i > 0 && ', '}
            {n}
            {mark?.has(n) && <span className="text-muted"> (also a variable)</span>}
          </span>
        ))}
      </span>
    </p>
  );
}
