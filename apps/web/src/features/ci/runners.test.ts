import assert from 'node:assert/strict';
import { test } from 'node:test';
import { labelProblem, parseMaxRuns, runnerDraft, runnerLine, runnerMarks, workspaceName } from './runners';

test('runs at once is a whole number from 1 to 8', () => {
  assert.equal(parseMaxRuns('1'), 1);
  assert.equal(parseMaxRuns(' 8 '), 8);
  for (const bad of ['0', '9', '', '2.5', '-1', 'x']) assert.equal(parseMaxRuns(bad), null, bad);
});

test('a label follows the server pattern, is not reserved or repeated, and there are at most 16', () => {
  assert.equal(labelProblem('Linux-X64', []), null, 'case is folded');
  assert.equal(labelProblem('', []), null, 'empty is just not added');
  assert.ok(labelProblem('bad label', []));
  assert.ok(labelProblem('-x', []));
  assert.ok(labelProblem('self-hosted', []));
  assert.ok(labelProblem('linux', ['linux']));
  assert.ok(labelProblem('x', Array.from({ length: 16 }, (_, i) => `l${i}`)));
});

test('the sheet needs a workspace, a label and 1 to 8 runs; the note is trimmed', () => {
  const ok = { workspaceId: 'docker/box', labels: ['gpu'], maxRuns: '2', note: ' big ' };
  assert.deepEqual(runnerDraft(ok), { ok: true, body: { workspaceId: 'docker/box', labels: ['gpu'], maxRuns: 2, note: 'big' } });
  assert.deepEqual(runnerDraft({ ...ok, note: ' ' }), { ok: true, body: { workspaceId: 'docker/box', labels: ['gpu'], maxRuns: 2, note: null } });
  assert.equal(runnerDraft({ ...ok, workspaceId: '' }).ok, false);
  assert.deepEqual(runnerDraft({ ...ok, labels: [] }), { ok: false, field: 'labels', message: 'Give at least one label.' });
  assert.equal((runnerDraft({ ...ok, maxRuns: '9' }) as { field: string }).field, 'maxRuns');
});

test('a row marks Disabled and Drained', () => {
  assert.deepEqual(runnerMarks({ enabled: true, drained: false }), []);
  assert.deepEqual(runnerMarks({ enabled: false, drained: true }), ['Disabled', 'Drained']);
});

test('a run names its runner when it ran on another workspace, and its runs-on labels', () => {
  assert.equal(workspaceName('kubernetes/build-box'), 'build-box');
  assert.deepEqual(runnerLine({ runsOn: ['gpu', 'linux'], runnerWorkspaceId: 'kubernetes/build-box' }), { runner: 'build-box', labels: ['gpu', 'linux'] });
  assert.deepEqual(runnerLine({ runsOn: null, runnerWorkspaceId: null }), { runner: null, labels: [] });
});
