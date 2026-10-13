import { Boxes } from 'lucide-react';
import { lazy, useMemo } from 'react';
import type { GlanceCompact, GlanceWidget } from '../../types';
import { workspacesCompact, workspacesView } from './model';
import { workspacesStore } from './store';

const WorkspacesCard = lazy(() => import('./Card').then((m) => ({ default: m.WorkspacesCard })));

function useWorkspacesCompact(): GlanceCompact {
  const { data, failed } = workspacesStore.use();
  return useMemo(() => workspacesCompact(data ? workspacesView(data.list, data.usage) : null, failed), [data, failed]);
}

/** Running, stopped and failing workspaces, CPU and memory where measured, Claude Code against its pin (PRD glance-widgets §18). */
export const workspacesWidget: GlanceWidget = {
  id: 'workspaces',
  label: 'Workspaces',
  icon: Boxes,
  about: 'Which workspaces run, are stopped or are failing, with CPU and memory where measured and the Claude Code each runs against its pin.',
  href: '/admin/workspaces',
  defaultHidden: true,
  useCompact: useWorkspacesCompact,
  Full: WorkspacesCard,
  Card: WorkspacesCard,
};
