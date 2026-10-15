// The tickets module's settings (the shared settings registry, settings-policies PRD). T-270: how long a ticket's session must be dead
// before the orphan sweep moves the ticket to the track's live successor or back to the agents' queue.

import { TICKET_SETTING_KEYS } from '@portal/contracts';
import { defineSetting, defineSettingGroup } from '../settings/registry.js';

defineSettingGroup('tickets', 'Tickets', 44);

defineSetting({
  key: TICKET_SETTING_KEYS.orphanAfterMin,
  type: 'number',
  default: 3,
  min: 1,
  max: 1440,
  scope: 'global',
  group: 'tickets',
  order: 10,
  label: 'Orphan delay',
  help: 'Minutes a ticket’s session must have ended (or be gone) before the portal moves the ticket by itself: to the live session that continues that track, else back to the agents’ queue. A session that comes back within this time keeps its tickets.',
});

defineSetting({
  key: TICKET_SETTING_KEYS.agentOpenPerWorkspace,
  type: 'number',
  default: 600,
  min: 50,
  max: 5000,
  scope: 'global',
  group: 'tickets',
  order: 20,
  label: 'Open agent tickets per workspace',
  help: 'How many open tickets agents may have made in one workspace before the portal refuses another (FR20, the queue is protected from a looping agent). Several programs can share a workspace; a person is never limited.',
});
