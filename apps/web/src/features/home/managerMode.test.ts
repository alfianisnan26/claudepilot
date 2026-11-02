// 2026-11-02 (Kohilabs): in an org, the Manager card could not show its Claudes (Step 2's sign-in) because it looked its runtime up in the
// workspace list, which an org filters to its own workspaces. It reads the runtime by id instead.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const src = readFileSync(new URL('./ManagerMode.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../../lib/api.ts', import.meta.url), 'utf8');

test('the Manager card reads its runtime workspace by id, never from the org-filtered list', () => {
  assert.match(src, /api\.workspaces\.get\(s\.runtime\.workspaceId\)/);
  assert.doesNotMatch(src, /api\.workspaces\.list\(\)/, 'the list is filtered to the app’s org');
  assert.match(api, /get: \(id: string\) => request<Workspace>\('GET', WORKSPACE_API\.one\(id\)\)/, 'one workspace by id, no ?org=');
});
