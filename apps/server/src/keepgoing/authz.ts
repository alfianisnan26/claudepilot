// What Keep going's routes need (the authorization seam's `declarePolicies`). Reading a chat's policy needs `view` on the chat; setting it
// needs `operate`, and the route itself refuses an agent (a chat may not keep itself going) and a token below admin: only a person or an
// admin token sets a policy (T-259, T-104 item 7).

import { declarePolicies } from '../authz/seam.js';

export function declareKeepGoingPolicies(): void {
  declarePolicies('keepgoing', {
    'GET /api/chat/sessions/:id/keep-going': { kind: 'objects', checks: [{ type: 'session', verb: 'view', from: 'path', param: 'id' }] },
    'PUT /api/chat/sessions/:id/keep-going': { kind: 'objects', checks: [{ type: 'session', verb: 'operate', from: 'path', param: 'id' }], audit: 'keepgoing.set' },
  });
}
