// What each notifications and platform route needs (the authorization seam's `declarePolicies`, adoption rule 5). Everything here is the
// caller's own (`self`), except "Notify when done", which needs a right on the session, and `act`, which is its own door on top of the
// session guard: a single-use token bound to the user, and `can(operate)` on the session when the answer arrives.

import { declarePolicies, declareToolPolicies } from '../authz/seam.js';

export function declareNotifyPolicies(): void {
  declarePolicies('notify', {
    'GET /api/notify': { kind: 'self' },
    'GET /api/notify/prefs': { kind: 'self' },
    'PUT /api/notify/prefs': { kind: 'self', audit: 'notify.prefs' },
    'POST /api/notify/push': { kind: 'self' },
    'GET /api/notify/destinations': { kind: 'self' },
    'POST /api/notify/destinations': { kind: 'self', audit: 'notify.channel' },
    'PATCH /api/notify/destinations/:id': { kind: 'self' },
    'DELETE /api/notify/destinations/:id': { kind: 'self', audit: 'notify.channel' },
    'POST /api/notify/destinations/:id/test': { kind: 'self', audit: 'notify.test' },
    'POST /api/notify/destinations/:id/secret': { kind: 'self', reauth: true, audit: 'notify.channel' },
    'GET /api/notify/log': { kind: 'self' },
    'GET /api/notify/history': { kind: 'self' },
    'POST /api/notify/history/read': { kind: 'self' },
    'DELETE /api/notify/history': { kind: 'self' },
    'GET /api/notify/mutes': { kind: 'self' },
    'GET /api/notify/mutes/offer/:ref': { kind: 'self' },
    'POST /api/notify/mutes': { kind: 'self', audit: 'notify.mute' },
    'DELETE /api/notify/mutes/:id': { kind: 'self', audit: 'notify.mute' },
    'DELETE /api/notify/mutes': { kind: 'self', audit: 'notify.mute' },
    'GET /api/notify/sessions/:id': { kind: 'objects', checks: [{ type: 'session', verb: 'view', from: 'path', param: 'id' }] },
    'PUT /api/notify/sessions/:id': { kind: 'objects', checks: [{ type: 'session', verb: 'operate', from: 'path', param: 'id' }] },
    'POST /api/notify/act': { kind: 'self', audit: 'notify.action' },
  });
  declarePolicies('platform', {
    'GET /api/platform/audit': { kind: 'self' },
  });
  // The one Portal MCP tool: the token owner's own destinations and Inbox count, read only.
  declareToolPolicies('notify', { notify_status: { kind: 'self' } });
}
