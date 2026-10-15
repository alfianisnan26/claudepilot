// Every auto transfer route is declared to the authorization seam (T-460: `GET /leaving` was added without a declaration).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { declaredPolicies } from '../authz/seam.js';
import { declareAutoTransferPolicies } from './authz.js';

test('every route of routes.ts has a policy, and GET /api/autotransfer/leaving is the caller’s own (self)', () => {
  declareAutoTransferPolicies();
  const declared = declaredPolicies();
  const src = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
  const routes = [...src.matchAll(/\br\.(get|put|post)\('([^']*)'/g)].map((m) => `${m[1]!.toUpperCase()} /api/autotransfer${m[2] === '/' ? '' : m[2]}`);
  assert.ok(routes.length >= 10, 'the pattern found the routes');
  assert.ok(routes.includes('GET /api/autotransfer/leaving'));
  const missing = routes.filter((k) => !declared.has(k));
  assert.deepEqual(missing, [], 'routes with no declared policy');
  assert.deepEqual(declared.get('GET /api/autotransfer/leaving'), { kind: 'self' });
});
