import { Button, PageTabs } from '@isnanme/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { RemotesTab } from './RemotesTab';
import { RunnersTab } from './RunnersTab';
import { RunsTab } from './RunsTab';

/**
 * CI (local-git-ci PRD §15): the runs of every remote, the remotes workspaces host, and the runners (§23) that take runs by label. A push to a
 * remote runs the pipelines in the repository's `.pilot` folder inside that workspace.
 */
export function CiPage() {
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [addingRunner, setAddingRunner] = useState(false);
  const tab = params.get('tab') === 'remotes' ? 'remotes' : params.get('tab') === 'runners' ? 'runners' : 'runs';
  const go = (id: string) => setParams(id !== 'runs' ? { tab: id } : {}, { replace: true });
  const add =
    tab === 'runners' ? (
      <Button icon={<Plus className="size-4" />} onClick={() => setAddingRunner(true)}>
        <span className="hidden sm:inline">Add runner</span>
        <span className="sm:hidden">Add</span>
      </Button>
    ) : (
      <Button icon={<Plus className="size-4" />} onClick={() => (setCreating(true), tab === 'runs' && go('remotes'))}>
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
        onChange={(id) => id && go(id)}
        tabs={[
          { id: 'runs', label: 'Runs', content: <RunsTab onNewRemote={() => (setCreating(true), go('remotes'))} /> },
          { id: 'remotes', label: 'Remotes', content: <RemotesTab creating={creating} onCloseCreate={() => setCreating(false)} onNew={() => setCreating(true)} /> },
          { id: 'runners', label: 'Runners', content: <RunnersTab adding={addingRunner} onCloseAdd={() => setAddingRunner(false)} onAdd={() => setAddingRunner(true)} /> },
        ]}
      />
    </>
  );
}
