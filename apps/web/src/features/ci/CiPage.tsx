import { Button, PageTabs } from '@isnanme/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { RemotesTab } from './RemotesTab';
import { RunsTab } from './RunsTab';

/**
 * CI (local-git-ci PRD §15): the runs of every remote, and the remotes workspaces host. A push to a remote runs the
 * pipelines in the repository's `.pilot` folder inside that workspace.
 */
export function CiPage() {
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const tab = params.get('tab') === 'remotes' ? 'remotes' : 'runs';
  const add = (
    <Button icon={<Plus className="size-4" />} onClick={() => (setCreating(true), tab === 'runs' && setParams({ tab: 'remotes' }, { replace: true }))}>
      <span className="hidden sm:inline">New remote</span>
      <span className="sm:hidden">New</span>
    </Button>
  );
  return (
    <>
      <PageHeader title="CI" description="A push to a workspace's remote runs the pipelines in the repository's .pilot folder, inside that workspace." action={add} />
      <PageTabs
        label="CI"
        stack="never"
        value={tab}
        onChange={(id) => setParams(id && id !== 'runs' ? { tab: id } : {}, { replace: true })}
        tabs={[
          { id: 'runs', label: 'Runs', content: <RunsTab onNewRemote={() => (setCreating(true), setParams({ tab: 'remotes' }, { replace: true }))} /> },
          { id: 'remotes', label: 'Remotes', content: <RemotesTab creating={creating} onCloseCreate={() => setCreating(false)} onNew={() => setCreating(true)} /> },
        ]}
      />
    </>
  );
}
