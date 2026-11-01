import { Button } from '@isnanme/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { RoutedTabs, useTabId } from '@/components/RoutedTabs';
import { RemotesTab } from './RemotesTab';
import { RunnersTab } from './RunnersTab';
import { RunsTab } from './RunsTab';

const BASE = '/admin/ci';
const TABS = ['runs', 'remotes', 'runners'] as const;

/**
 * CI (local-git-ci PRD §15): the runs of every remote (`/admin/ci`), the remotes workspaces host (`/admin/ci/remotes`), and the runners (§23)
 * that take runs by label (`/admin/ci/runners`). A push to a remote runs the pipelines in the repository's `.pilot` folder inside that workspace.
 */
export function CiPage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [addingRunner, setAddingRunner] = useState(false);
  const tab = useTabId(BASE, TABS);
  const toRemotes = () => navigate(`${BASE}/remotes`);
  // One primary action per screen (QA A2): the header's, never repeated by an empty state. Runs are not made by hand, so the Runs tab has
  // none; its empty state offers New remote while there is no remote yet (UX sweep 2026-11-01).
  const add =
    tab === 'runs' ? undefined : tab === 'runners' ? (
      <Button icon={<Plus className="size-4" />} aria-label="Add runner" onClick={() => setAddingRunner(true)}>
        <span className="hidden sm:inline">Add runner</span>
        <span className="sm:hidden">Add</span>
      </Button>
    ) : (
      <Button icon={<Plus className="size-4" />} aria-label="New remote" onClick={() => setCreating(true)}>
        <span className="hidden sm:inline">New remote</span>
        <span className="sm:hidden">New</span>
      </Button>
    );
  return (
    <>
      <PageHeader title="CI" description="A push to a workspace's remote runs the pipelines in the repository's .pilot folder, inside that workspace." action={add} />
      <RoutedTabs
        base={BASE}
        label="CI"
        tabs={[
          { id: 'runs', label: 'Runs', content: <RunsTab onNewRemote={() => (setCreating(true), toRemotes())} /> },
          { id: 'remotes', label: 'Remotes', content: <RemotesTab creating={creating} onCloseCreate={() => setCreating(false)} /> },
          { id: 'runners', label: 'Runners', content: <RunnersTab adding={addingRunner} onCloseAdd={() => setAddingRunner(false)} /> },
        ]}
      />
    </>
  );
}
