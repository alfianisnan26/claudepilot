import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { wireVaultBinding } from './vaultBinding.js';

type Agents = Parameters<typeof wireVaultBinding>[0];
type Knowledge = Parameters<typeof wireVaultBinding>[1];

function fakes() {
  const calls: string[] = [];
  const agents = {
    rebindVaults: async () => void calls.push('rebind'),
    closeVaults: async () => void calls.push('close'),
  } as unknown as Agents;
  const knowledge = {
    vaultsForWorkspace: (ws: string) => (calls.push(`lookup:${ws}`), ['v1']),
  } as unknown as Knowledge;
  return { calls, agents, knowledge };
}

test('T-436 S3: wireVaultBinding sets the lookup, the rebind and the fail-closed hooks', () => {
  const { calls, agents, knowledge } = fakes();
  // typeof, not `=== undefined`: a strict `assert.equal` narrows `vaultsFor` to undefined and the call below would not typecheck.
  assert.equal(typeof agents.vaultsFor, 'undefined');
  wireVaultBinding(agents, knowledge);
  assert.deepEqual(agents.vaultsFor?.('docker/api'), ['v1']);
  knowledge.onAgentWorkspacesChange?.();
  knowledge.onAgentWorkspacesFailClosed?.();
  assert.deepEqual(calls, ['lookup:docker/api', 'rebind', 'close']);
});

test('T-436 S3: the hooks are the ones the service calls, each to its own side (rebind is not close)', () => {
  const { calls, agents, knowledge } = fakes();
  wireVaultBinding(agents, knowledge);
  knowledge.onAgentWorkspacesChange?.();
  assert.deepEqual(calls, ['rebind']);
  knowledge.onAgentWorkspacesFailClosed?.();
  assert.deepEqual(calls, ['rebind', 'close']);
});

test('T-436 S3: index.ts calls wireVaultBinding with the portal agents and the knowledge service, and sets no hook by hand', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'index.ts'), 'utf8');
  assert.match(src, /^\s*wireVaultBinding\(portalMcp\.agents, knowledge\);/m);
  assert.doesNotMatch(src, /agents\.vaultsFor\s*=/);
});
