import { Badge, Button, Spinner, useToast } from '@isnanme/ui';
import type { BrowserStatus, Workspace, WorkspacePoolAssignment } from '@portal/contracts';
import { MonitorPlay, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { errorText } from '@/lib/api';
import { useLive } from '@/lib/live';
import { browserApi, type BrowserConfigurationStatus } from './api';
import { STATE } from './labels';

/**
 * The browser row's detail in a workspace's Configuration: its state in one word, the live view, and what
 * went wrong when something did (the install, the container). Nothing when there is nothing to say.
 */
export function BrowserConfiguration({ workspace, assignments }: { workspace: Workspace; assignments: WorkspacePoolAssignment[] }) {
  const toast = useToast();
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [config, setConfig] = useState<BrowserConfigurationStatus | null>(null);
  const [retrying, setRetrying] = useState(false);
  const id = workspace.id;
  const assigned = assignments.some((a) => a.state === 'assigned');

  const load = useCallback(async () => {
    if (!assigned) return;
    const [s, c] = await Promise.allSettled([browserApi.status(id), browserApi.configuration(id)]);
    if (s.status === 'fulfilled') setStatus(s.value);
    if (c.status === 'fulfilled') setConfig(c.value);
  }, [id, assigned]);
  useEffect(() => void load(), [load, workspace.status]);
  useLive('pools', () => void load(), assigned);

  if (!assigned) return null;
  const state = status ? STATE[status.state] : null;
  const failed = config?.install?.state === 'failed';
  const installing = config?.install?.state === 'installing';
  const running = workspace.status === 'running';

  const retry = async () => {
    setRetrying(true);
    try {
      await browserApi.retryInstall(id);
      toast('Installing again');
    } catch (e) {
      toast(errorText(e, 'Could not start it.'), 'error');
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        {state && <Badge tone={state.tone}>{state.label}</Badge>}
        {installing && (
          <span className="inline-flex items-center gap-1.5 text-muted">
            <Spinner className="size-3" /> Installing tools
          </span>
        )}
        {status?.sandbox === 'off' && <Badge tone="warning">Sandbox off</Badge>}
        {running && status && status.state !== 'none' && status.state !== 'workspace_stopped' && status.state !== 'restart_needed' && (
          <Link to={`/admin/workspaces/${id}/browser`} className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-semibold text-accent hover:bg-accent-soft">
            <MonitorPlay className="size-4" /> Open
          </Link>
        )}
      </div>
      {status?.state === 'error' && status.detail && <p className="text-danger">{status.detail}</p>}
      {status && status.state !== 'error' && status.detail && <p className="text-muted">{status.detail}</p>}
      {failed && (
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-danger">Tools install failed{config?.install?.error ? `: ${config.install.error}` : ''}</p>
          <Button variant="secondary" size="sm" onClick={() => void retry()} disabled={!running || retrying} icon={retrying ? <Spinner className="size-3" /> : <RotateCw className="size-3.5" />}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
