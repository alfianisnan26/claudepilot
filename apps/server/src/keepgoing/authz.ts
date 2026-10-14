// What Keep going's routes need (the authorization seam's `declarePolicies`). Reading a chat's policy needs `view` on the chat; setting it
// needs `operate`, and the route itself refuses an agent (a chat may not keep itself going) and a token below admin: only a person or an
// admin token sets a policy (T-259, T-104 item 7). Slice 2: the Home card's list is the caller's own (`self`: the route keeps the chats the
// caller may view), and the Portal MCP tool `session_keepgoing_set` needs `operate` on the chat (admin tokens only, by its scope; turning it
// on is confirmed first; a chat the token may not operate answers like an unknown one).

import type { ToolPolicies } from '@portal/contracts';
import { declarePolicies, declareToolPolicies } from '../authz/seam.js';

export const KEEPGOING_TOOL_POLICIES = {
  session_keepgoing_set: { kind: 'objects', checks: [{ type: 'session', verb: 'operate', arg: 'session_id' }], confirm: true, audit: 'keepgoing.set' },
} satisfies ToolPolicies;

export function declareKeepGoingPolicies(): void {
  declarePolicies('keepgoing', {
    'GET /api/chat/sessions/:id/keep-going': { kind: 'objects', checks: [{ type: 'session', verb: 'view', from: 'path', param: 'id' }] },
    'PUT /api/chat/sessions/:id/keep-going': { kind: 'objects', checks: [{ type: 'session', verb: 'operate', from: 'path', param: 'id' }], audit: 'keepgoing.set' },
    'GET /api/keepgoing': { kind: 'self' },
  });
  declareToolPolicies('keepgoing', KEEPGOING_TOOL_POLICIES);
}
