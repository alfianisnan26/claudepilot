import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SecretsContent as View } from '@portal/contracts';
import { Reconciler } from '../delivery/reconciler.js';
import { exposedSecretValues } from './exposed.js';
import { memoryWorkspace, secretsHarness } from './testkit.js';

// QA-006: a secret the agent may print reaches the transcript in clear unless the redactor knows the value.
// This is the accessor chat's redactor and artifact previews call: values only in memory, current and recent.

const WS = 'docker/ws1';
const A_OLD = 'ghp_OLDleakedTOKEN0123456789abcdefghij';
const A_NEW = 'ghp_NEWrotatedTOKEN0123456789abcdefgh';
const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACBkZXBsb3ktdGVzdC1rZXktMDEyMzQ1Njc4OQAAAJgAAAA=\n-----END OPENSSH PRIVATE KEY-----\n';

test('exposedSecretValues: delivered secrets (current and rotated away), multi-line keys by line, never variables or short values', async () => {
  const h = await secretsHarness();
  const ws = memoryWorkspace();
  const reconciler = new Reconciler(h.store, () => ws.runtime, () => [ws.runtime], h.providers);
  try {
    const p = h.service.create('secrets', {
      name: 'team',
      content: {
        entries: [
          { kind: 'variable', name: 'REGION', value: 'eu-west-1-plain' },
          { kind: 'secret', name: 'TOKEN', newValue: A_OLD },
          { kind: 'secret', name: 'id_deploy', newValue: PEM },
          { kind: 'secret', name: 'TINY', newValue: 'abc' },
        ],
      },
    });
    h.service.setAssignments(WS, 'secrets', [{ poolId: p.id }]);
    await reconciler.request(WS, 'test');
    assert.equal(reconciler.row(WS)?.status, 'synced', reconciler.row(WS)?.reason ?? '');
    const first = exposedSecretValues(h.service, WS);
    assert.ok(first.includes(A_OLD) && first.includes(PEM));
    assert.ok(first.includes('QyNTUxOQAAACBkZXBsb3ktdGVzdC1rZXktMDEyMzQ1Njc4OQAAAJgAAAA='), 'a key file is also redacted line by line');
    assert.ok(!first.includes('eu-west-1-plain'), 'plain variables are not secrets');
    assert.ok(!first.includes('abc'), 'too short to redact without mangling text');

    // Rotate: the new value is current, and the one rotated away stays redactable (it may still sit in a transcript or a process).
    const entries = (h.service.get(p.id).content as View).entries;
    h.service.update(p.id, { content: { entries: entries.map((e) => (e.name === 'TOKEN' ? { ...e, newValue: A_NEW } : e)) } });
    await reconciler.request(WS, 'rotate');
    const after = exposedSecretValues(h.service, WS);
    assert.ok(after.includes(A_NEW) && after.includes(A_OLD));

    // Another workspace gets nothing of this set's; an unknown one, nothing.
    assert.deepEqual(exposedSecretValues(h.service, 'docker/other'), []);
    // Values rotated away longer ago than the window drop out, current ones never do.
    h.store.db!.prepare("UPDATE exposures SET last_delivered_at = '2020-01-01T00:00:00.000Z' WHERE workspace_id = ?").run(WS);
    const old = exposedSecretValues(h.service, WS, { days: 30 });
    assert.ok(old.includes(A_NEW), 'still delivered now');
    assert.ok(!old.includes(A_OLD), 'rotated away and old');
  } finally {
    reconciler.stop();
    h.done();
  }
});

test('exposedSecretValues: nothing while Locked, and nothing from a portal without Secrets & env', async () => {
  const locked = await secretsHarness({ key: null });
  try {
    assert.deepEqual(exposedSecretValues(locked.service, WS), []);
  } finally {
    locked.done();
  }
  assert.deepEqual(exposedSecretValues({ kind: () => { throw new Error('No such pool type.'); } }, WS), []);
});

// T-557 / T-486: the value a CI runner's lease and the upstream webhook's signature check read, by name, for one workspace.
test('deliveredSecretValue: the file secret a workspace gets, never a variable, an unassigned name, another workspace, or a portal with no Secrets & env kind (a real Locked store is not exercised here)', async () => {
  const { deliveredSecretValue } = await import('./exposed.js');
  const value = `fixture-${Math.random().toString(36).slice(2)}-hook-value`;
  const h = await secretsHarness();
  try {
    const p = h.service.create('secrets', {
      name: 'hook',
      content: { entries: [{ kind: 'variable', name: 'REGION', value: 'eu-west-1-plain' }, { kind: 'secret', name: 'HOOK_KEY', newValue: value }] },
    });
    assert.equal(deliveredSecretValue(h.service, WS, 'HOOK_KEY'), null, 'not assigned yet');
    h.service.setAssignments(WS, 'secrets', [{ poolId: p.id }]);
    assert.equal(deliveredSecretValue(h.service, WS, 'HOOK_KEY'), value);
    assert.equal(deliveredSecretValue(h.service, WS, 'REGION'), null, 'a variable is not a secret file');
    assert.equal(deliveredSecretValue(h.service, WS, 'NOPE'), null);
    assert.equal(deliveredSecretValue(h.service, 'docker/other', 'HOOK_KEY'), null);
  } finally {
    h.done();
  }
  assert.equal(deliveredSecretValue({ kind: () => { throw new Error('No such pool type.'); } }, WS, 'HOOK_KEY'), null);
});

// A5: names only. A pipeline that lists `secrets: [NAME]` asks whether the name reaches the workspace, never for a value.
test('secretNamesOf / secretName: what reaches a workspace by name and how, never a value', async () => {
  const { secretName, secretNamesOf } = await import('./names.js');
  const h = await secretsHarness();
  try {
    const p = h.service.create('secrets', {
      name: 'team',
      content: { entries: [{ kind: 'variable', name: 'REGION', value: 'eu-west-1-plain' }, { kind: 'secret', name: 'TOKEN', newValue: A_OLD }] },
    });
    assert.deepEqual(secretNamesOf(h.references, WS), [], 'nothing assigned yet');
    h.service.setAssignments(WS, 'secrets', [{ poolId: p.id }]);
    const names = secretNamesOf(h.references, WS);
    assert.deepEqual(names.map((n) => n.name), ['REGION', 'TOKEN']);
    assert.deepEqual(secretName(h.references, WS, 'REGION'), { name: 'REGION', kind: 'variable', asFile: false, asVariable: true });
    assert.equal(secretName(h.references, WS, 'TOKEN')?.asFile, true);
    assert.equal(secretName(h.references, WS, 'NOPE'), null);
    assert.equal(secretName(h.references, 'docker/other', 'TOKEN'), null, 'another workspace has nothing');
    const all = JSON.stringify(names);
    assert.ok(!all.includes(A_OLD) && !all.includes('eu-west-1-plain'), 'no value anywhere in the answer');
  } finally {
    h.done();
  }
});
