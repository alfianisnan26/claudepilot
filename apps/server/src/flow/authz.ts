// What the flow watchdog's route needs (the authorization seam's `declarePolicies`). The snapshot names lead sessions and tickets of every
// program, so it is a platform admin's (`settings` `manage`, as the Flow settings are): a person, or an admin's token; never an agent (a lead
// may not read who the watchdog is about to tell). Anyone else gets the same 404 as an unknown route.

import { declarePolicies } from '../authz/seam.js';

export function declareFlowPolicies(): void {
  declarePolicies('flow', {
    'GET /api/flow': { kind: 'platform', area: 'settings', verb: 'manage' },
  });
}
