import { quotaWidget } from './widgets/quota/widget';
import { sessionsWidget } from './widgets/sessions/widget';
import { agentsWidget } from './widgets/agents/widget';
import { attentionWidget } from './widgets/attention/widget';
import { shortcutsWidget } from './widgets/shortcuts/widget';
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
];

export const widgetById = (id: string): GlanceWidget | undefined => GLANCE_WIDGETS.find((w) => w.id === id);
