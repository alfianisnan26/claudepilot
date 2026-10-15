// What each auto transfer route and tool needs (the authorization seam's `declarePolicies`, adoption rule 5). The choices, the per-Claude
// settings, the cards and the trail are the caller's own (`self`; the routes filter by the caller and check `can` on the Claude); a chat's
// state needs `view` on it and its mode `operate`.

import { declarePolicies, declareToolPolicies } from '../authz/seam.js';

export function declareAutoTransferPolicies(): void {
  declarePolicies('autotransfer', {
    'GET /api/autotransfer': { kind: 'self' },
    'PUT /api/autotransfer/prefs': { kind: 'self', audit: 'autotransfer.prefs' },
    'PUT /api/autotransfer/claudes/:claudeId': { kind: 'objects', checks: [{ type: 'claude', verb: 'operate', from: 'path', param: 'claudeId' }], audit: 'autotransfer.claude' },
    'GET /api/autotransfer/sessions/:id': { kind: 'objects', checks: [{ type: 'session', verb: 'view', from: 'path', param: 'id' }] },
    'PUT /api/autotransfer/sessions/:id': { kind: 'objects', checks: [{ type: 'session', verb: 'operate', from: 'path', param: 'id' }], audit: 'autotransfer.mode_set' },
    'POST /api/autotransfer/suggestions/:id/move': { kind: 'self', audit: 'autotransfer.moved' },
    'POST /api/autotransfer/suggestions/:id/later': { kind: 'self', audit: 'autotransfer.declined' },
    'POST /api/autotransfer/suggestions/:id/always': { kind: 'self', audit: 'autotransfer.mode_set' },
    'GET /api/autotransfer/events': { kind: 'self' },
    'GET /api/autotransfer/state': { kind: 'self' },
    // T-460: which of the caller's own Claudes auto move would leave now (the usage report is already filtered to what the caller may use).
    'GET /api/autotransfer/leaving': { kind: 'self' },
  });
  // The one Portal MCP tool: a chat's state and recent events, read only. Nothing changes a mode or moves a chat over MCP.
  declareToolPolicies('autotransfer', { autotransfer_status: { kind: 'objects', checks: [{ type: 'session', verb: 'view', arg: 'session_id', notFound: 'No such session.' }] } });
}
