// A workspace whose Claude Code has no --safe-mode (docs/prd/claude-usage.md §11): nothing is read there, it is said once in the log, and it is an ordinary
// failure to the page (the contract's `unreadable`), with the usual back-off.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claude, MIN, usageHarness } from './fixtures.js';
import type { ProbeResult } from './probe.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('an unsupported Claude Code is told once per workspace, reads as unreadable with back-off, and a supported one beside it is unaffected', async () => {
  const lines: string[] = [];
  const probe = (async (c: { id: string }): Promise<ProbeResult> =>
    c.id === 'old'
      ? { runsOn: 'unknown', plan: null, windows: [], extra: null, problem: 'unreadable', failed: true, unsupported: true }
      : { runsOn: 'none', plan: null, windows: [], extra: null, problem: null, failed: false }) as never;
  const h = await usageHarness({ probe, log: (l) => lines.push(l) });
  try {
    h.source.list = [claude({ id: 'old', workspaceId: 'docker/old', workspaceName: 'old' }), claude({ id: 'old2', workspaceId: 'docker/old', workspaceName: 'old' }), claude({ id: 'new', workspaceId: 'docker/new', workspaceName: 'new' })];
    // Both Claudes of "old" fail the same way; the probe asks one at a time per workspace, so the second takes the next pass.
    for (let i = 0; i < 3; i++) {
      await h.usage.tick();
      await sleep(5);
      h.clock.t += 11 * MIN;
    }
    const tells = lines.filter((l) => l.includes('no --safe-mode') && l.startsWith('old:'));
    assert.equal(tells.length, 1, 'said once for the workspace, not once per probe or per Claude');
    assert.match(tells[0]!, /older than 2\.1\.169.*would run the Claude's hooks.*Update Claude Code in that workspace/);
    assert.ok(lines.some((l) => /^old failed \(unreadable, no --safe-mode\) in \d+ ms$/.test(l)), 'each probe line says it too');
    const rows = new Map((await h.usage.report()).claudes.map((c) => [c.claudeId, c]));
    assert.deepEqual([rows.get('old')!.problem, rows.get('old')!.runsOn, rows.get('old')!.windows.length], ['unreadable', 'unknown', 0]);
    assert.equal(rows.get('new')!.runsOn, 'none', 'the other workspace is read as usual');
    assert.ok(!lines.some((l) => l.startsWith('new') && l.includes('safe-mode')));
  } finally {
    h.done();
  }
});
