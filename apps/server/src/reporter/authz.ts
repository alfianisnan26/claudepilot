// Who may call the UI reporter's routes and tools (docs/prd/ui-reporter-server.md). Three doors:
//   - the owner's routes under /api (the portal cookie, the usual CSRF), checked on the bucket or the ticket through the seam;
//   - the widget's public files and pages under /reporter/v1 (the SDK script, axe, the embed page, the status), which hold no secret;
//   - the panel's API under /reporter/v1, whose door is the `cprt_` token: scoped to one bucket and one origin, hashed at rest, re-checked
//     on every call against the bucket's sites and switch, and acting as the person who approved it (capped at operate by the seam).
// A refusal is the same 404 as a missing object everywhere.

import type { RoutePolicies, ToolPolicies } from '@portal/contracts';
import { declarePolicies, declareToolPolicies } from '../authz/seam.js';

const bucketPath = (verb: 'view' | 'manage') => ({ type: 'ticket_bucket' as const, verb, from: 'path' as const, param: 'key' });
const TOKEN = 'The cprt_ token (256 bits, hashed at rest): one bucket, one origin, re-checked against the bucket switch and its sites on every call.';

export const REPORTER_OWNER_POLICIES = {
  'GET /api/reporter/buckets/:key/config': { kind: 'objects', checks: [bucketPath('view')] },
  'PUT /api/reporter/buckets/:key/config': { kind: 'objects', checks: [bucketPath('manage')], audit: 'reporter.config_updated' },
  'GET /api/reporter/deployments': { kind: 'objects', checks: [{ type: 'ticket_bucket', verb: 'view', from: 'query', param: 'bucket' }] },
  'POST /api/reporter/deployments': {
    kind: 'handler',
    checks: ['a Portal MCP token (cpat_) with the operate scope', 'operate on the bucket whose site serves that repo and environment'],
    audit: 'reporter.deployment_recorded',
  },
  'GET /api/tickets/:id/reporter-evidence': { kind: 'objects', checks: [{ type: 'ticket', verb: 'view', from: 'path', param: 'id' }] },
} satisfies RoutePolicies;

export const REPORTER_WIDGET_POLICIES = {
  'GET /reporter/v1/reporter.js': { kind: 'public', why: 'The pinned SDK build: the same bytes for everyone, no secret.' },
  'GET /reporter/v1/axe.js': { kind: 'public', why: 'The pinned axe-core build the SDK loads at capture time; no secret.' },
  'GET /reporter/v1/embed': { kind: 'public', why: 'The panel page; framed only by an allowed origin of an enabled bucket (CSP frame-ancestors). It holds no data until the token.' },
  'GET /reporter/v1/status': { kind: 'public', why: 'Whether a bucket and origin may use the widget; one answer for every refusal, so nothing is enumerated.' },
  'GET /reporter/v1/connect': { kind: 'public', why: 'The connect popup: a signed-in person sees what they approve, anyone else a sign-in link. Minting is the POST.' },
  'POST /reporter/v1/connect': { kind: 'signed-in', audit: 'reporter.connected' },
  'POST /reporter/v1/connect/claim': {
    kind: 'public',
    why: 'The panel claims an approval the popup held (its opener was lost): same-origin only, one use, two minutes, and only with the verifier whose SHA-256 is the nonce the person approved; anything else is the same `pending`.',
  },
  'GET /reporter/v1/me': { kind: 'bearer', why: TOKEN },
  'DELETE /reporter/v1/me': { kind: 'bearer', why: `${TOKEN} Sign out: the token revokes itself, nothing else.` },
  'GET /reporter/v1/tickets': { kind: 'bearer', why: TOKEN },
  'POST /reporter/v1/tickets': { kind: 'bearer', why: TOKEN },
  'GET /reporter/v1/tickets/:key': { kind: 'bearer', why: TOKEN },
  'POST /reporter/v1/tickets/:key/captures': { kind: 'bearer', why: TOKEN },
  'POST /reporter/v1/tickets/:key/attachments': { kind: 'bearer', why: TOKEN },
  'GET /reporter/v1/tickets/:key/captures/:captureId/screenshot': { kind: 'bearer', why: TOKEN },
  'GET /reporter/v1/tickets/:key/comments': { kind: 'bearer', why: TOKEN },
  'POST /reporter/v1/tickets/:key/comments': { kind: 'bearer', why: TOKEN },
  'GET /reporter/v1/reviews': { kind: 'bearer', why: TOKEN },
  'POST /reporter/v1/reviews': { kind: 'bearer', why: TOKEN },
  'GET /reporter/v1/reviews/:id': { kind: 'bearer', why: TOKEN },
  'PATCH /reporter/v1/reviews/:id': { kind: 'bearer', why: TOKEN },
  'DELETE /reporter/v1/reviews/:id': { kind: 'bearer', why: TOKEN },
  'POST /reporter/v1/reviews/:id/comments': { kind: 'bearer', why: TOKEN },
  'PATCH /reporter/v1/reviews/:id/comments/:captureId': { kind: 'bearer', why: TOKEN },
  'DELETE /reporter/v1/reviews/:id/comments/:captureId': { kind: 'bearer', why: TOKEN },
  'POST /reporter/v1/reviews/:id/attachments': { kind: 'bearer', why: TOKEN },
  'GET /reporter/v1/reviews/:id/comments/:captureId/screenshot': { kind: 'bearer', why: TOKEN },
  'POST /reporter/v1/reviews/:id/submit': { kind: 'bearer', why: TOKEN },
  'POST /reporter/v1/duplicates': { kind: 'bearer', why: TOKEN },
  'GET /reporter/v1/events': { kind: 'bearer', why: TOKEN },
  'GET /reporter/v1/session-targets': { kind: 'bearer', why: TOKEN },
  'POST /reporter/v1/observed-build': { kind: 'bearer', why: TOKEN },
  'GET /reporter/v1/sessions': { kind: 'bearer', why: TOKEN },
  'GET /reporter/v1/knowledge': { kind: 'bearer', why: TOKEN },
  'GET /reporter/v1/knowledge/note': { kind: 'bearer', why: TOKEN },
} satisfies RoutePolicies;

export const REPORTER_TOOL_POLICIES = {
  reporter_evidence: { kind: 'objects', checks: [{ type: 'ticket', verb: 'view', arg: 'id', notFound: 'No such ticket.' }] },
  reporter_record_deployment: { kind: 'objects', checks: [{ type: 'ticket_bucket', verb: 'operate', arg: 'bucket', notFound: 'No such bucket.' }], audit: 'reporter.deployment_recorded' },
} satisfies ToolPolicies;

export function declareReporterPolicies(): void {
  declarePolicies('reporter', { ...REPORTER_OWNER_POLICIES, ...REPORTER_WIDGET_POLICIES });
  declareToolPolicies('reporter', REPORTER_TOOL_POLICIES);
}
