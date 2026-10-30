// Who may call the VS Code extension's routes (docs/prd/vscode-extension.md §5). The route table's default deny is enforced once the real
// layer lands; declaring now costs nothing. Bearer routes are `bearer: true` (FR51 of identity-onboarding): a device-flow token, never a
// cookie, and never a route that needs reauth, a platform right or sharing.

import { declarePolicies } from '../authz/seam.js';

export function declareVscodePolicies(): void {
  declarePolicies('vscode', {
    'GET /api/vscode/version': { kind: 'public', why: 'The extension checks the API version before it signs in.' },
    'POST /api/vscode/device': { kind: 'public', why: 'RFC 8628 start: hands out a code a signed-in person must approve; limited per address and in number.' },
    'POST /api/vscode/token': { kind: 'public', why: 'RFC 8628 poll: the 256-bit device code is the door; the token is issued once, after the person approved.' },
    'GET /api/vscode/pending': { kind: 'signed-in' },
    'POST /api/vscode/approve': { kind: 'signed-in', audit: 'vscode.approved' },
    'GET /api/vscode/me': { kind: 'bearer', why: 'The token describes itself.', bearer: true },
    'POST /api/vscode/logout': { kind: 'bearer', why: 'The token revokes itself.', bearer: true, audit: 'vscode.signed_out' },
    'GET /api/vscode/agents': { kind: 'signed-in', filter: 'session', bearer: true },
    'GET /api/vscode/tickets': { kind: 'signed-in', filter: 'ticket', bearer: true },
    'GET /api/vscode/workspaces': { kind: 'signed-in', filter: 'workspace', bearer: true },
    'GET /api/vscode/status': { kind: 'signed-in', filter: 'session', bearer: true },
    'GET /api/vscode/approvals': { kind: 'signed-in', filter: 'session', bearer: true },
    'GET /api/vscode/sessions/:id/events': { kind: 'objects', checks: [{ type: 'session', verb: 'view', from: 'path', param: 'id' }], bearer: true },
    'POST /api/vscode/sessions/:id/send': { kind: 'objects', checks: [{ type: 'session', verb: 'operate', from: 'path', param: 'id' }], bearer: true, audit: 'vscode.sent' },
    'POST /api/vscode/sessions/:id/respond': { kind: 'objects', checks: [{ type: 'session', verb: 'operate', from: 'path', param: 'id' }], bearer: true, audit: 'vscode.answered' },
  });
}
