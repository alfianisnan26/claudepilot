import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quickPlan } from './gateQuick.js';

test('documents only: nothing to check', () => {
  assert.deepEqual(quickPlan(['docs/prd/tickets.md', 'docs/dev-sessions/status/orchestrator.md', 'README.md', '']), { docsOnly: true, typecheck: false, serverAll: false, serverTests: [], web: false });
  assert.equal(quickPlan([]).docsOnly, true);
});

test('one server area: typecheck and that area’s tests', () => {
  const p = quickPlan(['apps/server/src/autotransfer/decide.ts', 'apps/server/src/autotransfer/decide.test.ts', 'docs/prd/auto-transfer.md']);
  assert.deepEqual(p, { docsOnly: false, typecheck: true, serverAll: false, serverTests: ['src/autotransfer/**/*.test.ts'], web: false });
});

test('web code: the web checks; areas add up', () => {
  const p = quickPlan(['apps/web/src/features/chat/SessionRow.tsx', 'apps/server/src/chat/routes.ts', 'apps/server/src/ci/links.ts']);
  assert.equal(p.web, true);
  assert.deepEqual(p.serverTests, ['src/chat/**/*.test.ts', 'src/ci/**/*.test.ts']);
});

test('what everything leans on runs the whole suite: contracts (and the web), migrations, authz, platform, settings, top-level files, the lockfile', () => {
  for (const p of ['packages/contracts/src/chat.ts', 'apps/server/src/store/migrations.ts', 'apps/server/src/authz/seam.ts', 'apps/server/src/platform/bus.ts', 'apps/server/src/settings/registry.ts', 'apps/server/src/app.ts', 'package-lock.json', 'apps/server/scripts/gen-workspace-host.ts']) {
    const plan = quickPlan([p]);
    assert.equal(plan.serverAll, true, p);
    assert.deepEqual(plan.serverTests, [], p);
  }
  assert.equal(quickPlan(['packages/contracts/src/chat.ts']).web, true, 'contracts feed the web too');
});

test('pipelines, scripts, manifests and the workspace image map to the areas that test them', () => {
  assert.deepEqual(quickPlan(['.pilot/scripts/release.sh']).serverTests, ['src/ci/**/*.test.ts']);
  assert.deepEqual(quickPlan(['scripts/scratch-portal.sh']).serverTests, ['src/ci/**/*.test.ts', 'src/qa/**/*.test.ts']);
  assert.deepEqual(quickPlan(['deploy/k3s/portal.yaml']).serverTests, ['src/ci/**/*.test.ts']);
  assert.deepEqual(quickPlan(['images/workspace/cp-session']).serverTests, ['src/chat/**/*.test.ts', 'src/ci/**/*.test.ts']);
});

test('a tool or QA harness alone still typechecks, runs no server test', () => {
  assert.deepEqual(quickPlan(['tools/qa/home.mjs']), { docsOnly: false, typecheck: true, serverAll: false, serverTests: [], web: false });
});
