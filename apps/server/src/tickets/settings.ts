// The tickets module's settings (the shared settings registry, settings-policies PRD). T-270: how long a ticket's session must be dead
// before the orphan sweep moves the ticket to the track's live successor or back to the agents' queue.

import { TICKET_BUCKET_ROUTES_DEFAULT, TICKET_SETTING_KEYS } from '@portal/contracts';
import { defineSetting, defineSettingGroup } from '../settings/registry.js';
import { AGENT_ASSIGN_USER_TAGS_DEFAULT } from './authz.js';

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

// FR9g (D-85): which lead sessions are peers (comment on each other's tickets). Owner only (the settings route); no agent tool writes it,
// so an agent cannot join a group by renaming itself (review 2026-10-18 of the title-track version).
defineSetting({
  key: TICKET_SETTING_KEYS.leadPeerGroups,
  type: 'string',
  default: '',
  max: 2000,
  scope: 'global',
  group: 'tickets',
  order: 40,
  label: 'Peer leads',
  help: 'Groups of lead session ids that may comment on each other\'s tickets (D-85): groups separated by ";", ids by ",". A session continuing a listed one counts as it. Empty: no peers.',
});

// T-2881: the bucket a ticket filed without one goes to, by its tags. Owner only (the settings route); no agent tool writes it.
defineSetting({
  key: TICKET_SETTING_KEYS.bucketRoutes,
  type: 'string',
  default: TICKET_BUCKET_ROUTES_DEFAULT,
  max: 1000,
  scope: 'global',
  group: 'tickets',
  order: 50,
  label: 'Bucket by tag',
  help: 'Where a ticket filed without a bucket goes, by its tags: rules separated by ";", each "KEY: tag, tag, prefix-*". An exact tag beats a prefix-*; two buckets tied decide nothing, and then the parent ticket, the workspace, the session\'s ticket and finally PILOT decide. Empty: no tag rules.',
});

// D-62 (T-483): an agent may put a ticket on a person only with one of these tags. Owner only (the settings route); no agent tool writes it.
defineSetting({
  key: TICKET_SETTING_KEYS.agentAssignUserTags,
  type: 'string',
  default: AGENT_ASSIGN_USER_TAGS_DEFAULT,
  protective: AGENT_ASSIGN_USER_TAGS_DEFAULT,
  confirmText: 'Agents may then assign more tickets to a person.',
  max: 200,
  scope: 'global',
  group: 'tickets',
  order: 30,
  label: 'Agent to person',
  help: 'Tags (comma separated) that let an agent assign a ticket to a person (D-62). Without one the portal refuses and points the agent to the written default. Empty: agents never assign to a person. A person, the page and admin tokens are never limited.',
});
