import { Bot } from 'lucide-react';
import { lazy } from 'react';
import type { GlanceWidget } from '../../types';
import { useAgentsCompact } from './useAgents';

/** The workers sessions started and the sub-agents running inside them, as a tree under their session, with Stop (PRD glance-widgets §6.3). */
export const agentsWidget: GlanceWidget = {
  id: 'agents',
  label: 'Agents',
  icon: Bot,
  about: 'The workers your agents started and the sub-agents running inside them, under the agent they belong to. Stop one right here.',
  href: '/admin/sessions',
  useCompact: useAgentsCompact,
  Full: lazy(() => import('./Full').then((m) => ({ default: m.AgentsFull }))),
};
