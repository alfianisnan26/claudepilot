// What the triggers' routes and tools need (the authorization seam: a resolver for `trigger`, `declarePolicies`, `declareToolPolicies`).
// A trigger is its owner's (`owner_id`): view to read it and its runs, operate to run, test, approve, skip or stop, manage to change,
// delete or rotate (the rotations also need the server code again). The public receiver is its own door: the Git host's signature.

import { objectRef } from '@portal/contracts';
import { declarePolicies, declareToolPolicies, registerResolver } from '../authz/seam.js';
import type { TriggerStore } from './store.js';

export function registerTriggerAuthz(store: TriggerStore): void {
  registerResolver({
    type: 'trigger',
    resolve(id) {
      const r = store.row(id);
      return r ? { ref: objectRef('trigger', r.id), owner: { kind: 'user', id: r.owner_id }, attrs: { workspaceId: JSON.parse(r.action).workspaceId ?? null } } : null;
    },
    ownedBy: (userId) => store.list(userId).map((t) => t.id),
  });
}

const one = (verb: 'view' | 'operate' | 'manage') => ({ kind: 'objects' as const, checks: [{ type: 'trigger' as const, verb, from: 'path' as const, param: 'id' }] });

export function declareTriggerPolicies(): void {
  declarePolicies('triggers', {
    'GET /api/triggers': { kind: 'signed-in', filter: 'trigger' },
    'POST /api/triggers': { kind: 'signed-in', creates: 'trigger', audit: 'trigger.created' },
    'POST /api/triggers/preview': { kind: 'signed-in' },
    'GET /api/triggers/runs': { kind: 'signed-in', filter: 'trigger' },
    'GET /api/triggers/:id': one('view'),
    'PATCH /api/triggers/:id': { ...one('manage'), audit: 'trigger.updated' },
    'DELETE /api/triggers/:id': { ...one('manage'), audit: 'trigger.deleted' },
    'POST /api/triggers/:id/run': { ...one('operate'), audit: 'trigger.fired' },
    'POST /api/triggers/:id/test': one('operate'),
    'GET /api/triggers/:id/runs': one('view'),
    'GET /api/triggers/:id/runs/:runId': one('view'),
    'POST /api/triggers/:id/runs/:runId/approve': { ...one('operate'), audit: 'trigger.approved' },
    'POST /api/triggers/:id/runs/:runId/skip': { ...one('operate'), audit: 'trigger.skipped' },
    'POST /api/triggers/:id/runs/:runId/stop': { ...one('operate'), audit: 'trigger.stopped' },
    'POST /api/triggers/:id/secret': { ...one('manage'), reauth: true, audit: 'trigger.secret_rotated' },
    'PUT /api/triggers/:id/secret': { ...one('manage'), reauth: true, audit: 'trigger.secret_rotated' },
    'POST /api/triggers/:id/url': { ...one('manage'), reauth: true, audit: 'trigger.secret_rotated' },
    'POST /hooks/:token': { kind: 'handler', checks: ['the token, looked up by its SHA-256', 'the Git host’s signature over the raw body', 'the trigger’s owner is the actor: can(owner, operate, workspace) at run time'] },
  });
  declareToolPolicies('triggers', {
    trigger_list: { kind: 'signed-in', filter: 'trigger' },
    trigger_runs: { kind: 'signed-in', filter: 'trigger' },
  });
}
