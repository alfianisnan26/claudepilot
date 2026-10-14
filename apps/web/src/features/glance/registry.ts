import { quotaWidget } from './widgets/quota/widget';
import { sessionsWidget } from './widgets/sessions/widget';
import { agentsWidget } from './widgets/agents/widget';
import { attentionWidget } from './widgets/attention/widget';
import { shortcutsWidget } from './widgets/shortcuts/widget';
import { workspacesWidget } from './widgets/workspaces/widget';
import { ticketsWidget } from './widgets/tickets/widget';
import { ciWidget } from './widgets/ci/widget';
import { spendWidget } from './widgets/spend/widget';
import { autonomyWidget } from './widgets/autonomy/widget';
import type { GlanceWidget } from './types';

/**
 * Every glance widget, in the order a person sees them until they reorder them in Settings. Adding one is one import and one
 * line here; nothing else in the frame, the header, the dock or Settings knows any widget by name.
 */
export const GLANCE_WIDGETS: readonly GlanceWidget[] = [
  quotaWidget,
  sessionsWidget,
  agentsWidget,
  attentionWidget,
  shortcutsWidget,
  // Made for the Home page: off in the strips until switched on in Settings > Glance.
  workspacesWidget,
  ticketsWidget,
  ciWidget,
  spendWidget,
  autonomyWidget,
];

export const widgetById = (id: string): GlanceWidget | undefined => GLANCE_WIDGETS.find((w) => w.id === id);
