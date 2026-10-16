// T-416 (D-61): the memory budget's arithmetic, the readings' cache, the unavailable reading (never blocks, logged once), and the 85 percent
// alert as a Needs you item that appears once per crossing and clears below 80 percent.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Actor } from '@portal/contracts';
import { AttentionRegistry } from '../attention/registry.js';
import { systemActor } from '../authz/seam.js';
import { parseMemoryProbe, type MemoryReading } from '../workspaces/memory.js';
import { budgetVerdict, MEMORY_BUDGET, MEMORY_HEADROOM_BYTES, memoryAttentionSource, memoryBudgetError, memoryItemId, SESSION_MEMORY_ESTIMATE_BYTES, sessionEstimate, WorkspaceMemory } from './memory.js';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** A reading as the probe gives it: `used` bytes of anon + active_file (split between them) against `limit`. */
function reading(used: number, limit = 8 * GiB, at = Date.now(), top = 'proc 1269760 claude\nproc 498688 node'): MemoryReading {
  const anon = Math.floor(used * 0.7);
  return parseMemoryProbe(`max ${limit}\nanon ${anon}\nactive_file ${used - anon}\n${top}\n`, at)!;
}

test('T-416: the budget allows a session while used + its estimate + 1.5 GiB fits the limit, and refuses one byte over', () => {
  const limit = 8 * GiB;
  const fits = limit - MEMORY_HEADROOM_BYTES - SESSION_MEMORY_ESTIMATE_BYTES;
  assert.equal(budgetVerdict(reading(fits, limit), SESSION_MEMORY_ESTIMATE_BYTES), null, 'exactly at the line: allowed');
  assert.equal(budgetVerdict(reading(2 * GiB, limit), SESSION_MEMORY_ESTIMATE_BYTES), null, 'well below');
  const refused = budgetVerdict(reading(fits + 1, limit), SESSION_MEMORY_ESTIMATE_BYTES);
  assert.deepEqual(refused, { usedBytes: fits + 1, limitBytes: limit, needBytes: SESSION_MEMORY_ESTIMATE_BYTES, headroomBytes: MEMORY_HEADROOM_BYTES });
  assert.ok(budgetVerdict(reading(limit, limit), SESSION_MEMORY_ESTIMATE_BYTES), 'at the limit');
});

test('T-416: a session estimate is 350 MB, and one more for each Agent-tool sub-agent it runs', () => {
  assert.equal(SESSION_MEMORY_ESTIMATE_BYTES, 350 * MiB);
  assert.equal(sessionEstimate(0), 350 * MiB);
  assert.equal(sessionEstimate(3), 4 * 350 * MiB);
  assert.equal(sessionEstimate(-1), 350 * MiB);
  // 1 GiB free above the headroom: one session fits, the same session with two sub-agents does not.
  const r = reading(8 * GiB - MEMORY_HEADROOM_BYTES - GiB);
  assert.equal(budgetVerdict(r, sessionEstimate(0)), null);
  assert.ok(budgetVerdict(r, sessionEstimate(2)));
});

test('T-416: the refusal reads plainly: the workspace, the numbers, what to do', () => {
  const e = memoryBudgetError('kubernetes/kohi-event', { usedBytes: 6.4 * GiB, limitBytes: 8 * GiB, needBytes: 350 * MiB, headroomBytes: 1.5 * GiB });
  assert.equal(e.code, MEMORY_BUDGET);
  assert.equal(e.status, 409);
  assert.equal(e.message, 'Not enough memory in kubernetes/kohi-event: 6.4 of 8.0 GiB in use, and this session needs about 350 MB with 1.5 GiB kept free. End or sleep a session there, or wait for one to finish.');
});

test('T-416: an unavailable reading is null (never blocks), is logged once per workspace, and the cache holds a reading', async () => {
  const logs: string[] = [];
  let reads = 0;
  let next: MemoryReading | null = null;
  let now = 1_000;
  const mem = new WorkspaceMemory({ read: async () => (reads++, next), now: () => now, log: (l) => logs.push(l) });
  assert.equal(await mem.reading('docker/ws1', 0), null);
  assert.equal(await mem.reading('docker/ws1', 0), null);
  assert.equal(logs.length, 1, 'logged once');
  assert.match(logs[0]!, /docker\/ws1: the memory reading is unavailable .*does not block/);
  // A failing exec is unavailable too, not an error.
  const failing = new WorkspaceMemory({ read: async () => Promise.reject(new Error('exec refused')), log: (l) => logs.push(l) });
  assert.equal(await failing.reading('docker/ws2'), null);
  assert.match(logs[1]!, /docker\/ws2: .*\(exec refused\)/);

  next = reading(GiB);
  const r = await mem.reading('docker/ws1', 0);
  assert.equal(r?.usedBytes, GiB);
  const before = reads;
  now += 4_000;
  assert.equal((await mem.reading('docker/ws1'))?.usedBytes, GiB, 'from the cache');
  assert.equal(reads, before, 'no second exec within the fresh window');
});

test('T-416: past 85 percent a Needs you item appears with the top processes; it stays one item and clears below 80 percent', async () => {
  let next = reading(6 * GiB); // 75 percent
  let now = Date.parse('2026-10-15T02:00:00Z');
  let changes = 0;
  const mem = new WorkspaceMemory({ read: async () => next, now: () => now, onChange: () => changes++ });
  const registry = new AttentionRegistry({ now: () => now, tickMs: 0 });
  registry.register(memoryAttentionSource(mem));
  registry.check(); // the baseline
  const owner = systemActor('test');

  await mem.look(['kubernetes/kohi-event']);
  assert.equal(registry.list(owner).counts.workspace_memory, 0, 'below the line');

  now += 61_000;
  next = reading(Math.round(7 * GiB), 8 * GiB, now); // 87.5 percent
  await mem.look(['kubernetes/kohi-event']);
  const e = registry.check();
  assert.equal(changes, 1);
  assert.deepEqual(e?.added, [{ kind: 'workspace_memory', id: 'kubernetes/kohi-event@2026-10-15T02:01:01.000Z' }]);
  const item = registry.list(owner).items[0]!;
  assert.equal(item.title, 'kubernetes/kohi-event: memory 88% (claude 1240 MB, node 487 MB)');
  assert.equal(item.why, 'question');
  assert.match(item.risk, /^7\.0 of 8\.0 GiB in use \(anon \+ active file\)/);
  const agent: Actor = { kind: 'token', userId: 'u_owner', tokenId: 't', scope: 'admin' } as unknown as Actor;
  assert.equal(registry.list(agent).counts.workspace_memory, 0, 'for a person to decide, not an agent token');

  // Read again within the minute: no exec. Still above 80 percent a minute later: the same item, its numbers fresh.
  now += 61_000;
  next = reading(Math.round(6.7 * GiB), 8 * GiB, now); // 83.75 percent
  await mem.look(['kubernetes/kohi-event']);
  assert.equal(registry.check(), null, 'the same item');
  assert.match(registry.list(owner).items[0]!.title, /memory 84%/);

  now += 61_000;
  next = reading(Math.round(6 * GiB), 8 * GiB, now); // 75 percent
  await mem.look(['kubernetes/kohi-event']);
  const cleared = registry.check();
  assert.deepEqual(cleared?.resolved.map((r) => r.kind), ['workspace_memory']);
  assert.equal(registry.list(owner).counts.workspace_memory, 0);
  assert.equal(changes, 2);

  // The next crossing is a new item (a new notification).
  now += 61_000;
  next = reading(Math.round(7.2 * GiB), 8 * GiB, now);
  await mem.look(['kubernetes/kohi-event']);
  assert.notEqual(registry.check()?.added[0]?.id, e?.added[0]?.id);
});

test('T-416: the liveness round reads a workspace at most once a minute; a workspace no session runs in drops its alert', async () => {
  let reads = 0;
  let now = 0;
  const mem = new WorkspaceMemory({ read: async () => (reads++, reading(7.5 * GiB, 8 * GiB, now)), now: () => now });
  await mem.look(['docker/ws1', 'docker/ws1']);
  assert.equal(reads, 1, 'once per workspace per round');
  now += 30_000;
  await mem.look(['docker/ws1']);
  assert.equal(reads, 1, 'not again within the minute');
  now += 31_000;
  await mem.look(['docker/ws1']);
  assert.equal(reads, 2);
  assert.equal(mem.alerts().length, 1);
  await mem.look([]);
  assert.equal(mem.alerts().length, 0);
});

test('T-416: the Needs you item reaches the push bridge with its kind in fixed words, its title cut as the untrusted detail, and no command lines', async () => {
  const { bridgeAttentionNotify } = await import('../attention/notify.js');
  const { createBus } = await import('../notify/bus.js');
  const { render } = await import('../notify/templates.js');
  let now = Date.parse('2026-10-15T02:00:00Z');
  let next = reading(6 * GiB);
  const mem = new WorkspaceMemory({ read: async () => next, now: () => now });
  const registry = new AttentionRegistry({ now: () => now, tickMs: 0 });
  registry.register(memoryAttentionSource(mem));
  const bus = createBus();
  const sent: { kind: string; subject: { id: string }; audience?: string[]; detail?: { text: string; truncated: boolean }; facts: Record<string, unknown> }[] = [];
  bus.on('*', (e) => void sent.push(e as never));
  const stop = bridgeAttentionNotify(registry, bus, () => ['u_owner']);
  try {
    registry.check(); // the baseline
    // Long enough that the title is cut at 120, short enough that the item's id fits the bus's 200-character subject id (a longer one
    // is dropped by `validateEvent`: "bad subject"; real workspace ids are far shorter).
    const long = `kubernetes/${'w'.repeat(100)}`;
    now += 61_000;
    next = reading(Math.round(7 * GiB), 8 * GiB, now);
    await mem.look(['kubernetes/kohi-event', long]);
    registry.check();
    assert.equal(sent.length, 2, 'one notification per workspace item, to the owner');
    for (const e of sent) {
      assert.equal(e.kind, 'attention');
      assert.deepEqual(e.audience, ['u_owner']);
      assert.deepEqual(e.facts, { what: 'Memory', why: 'Question' }, 'fixed words only');
      assert.ok(e.subject.id.startsWith('attention:workspace_memory:'));
      assert.ok(!/(--|\/usr\/|\/bin\/)/.test(e.detail!.text), `no command line: ${e.detail!.text}`);
    }
    const short = sent.find((e) => e.subject.id.includes('kohi-event'))!;
    assert.equal(short.detail?.text, 'kubernetes/kohi-event: memory 88% (claude 1240 MB, node 487 MB)');
    assert.equal(short.detail?.truncated, false);
    const cut = sent.find((e) => !e.subject.id.includes('kohi-event'))!;
    assert.equal(cut.detail?.text.length, 120, 'cut to 120 characters');
    assert.ok(cut.detail?.text.endsWith('…') && cut.detail.truncated);
    const shown = render(short as never);
    assert.equal(shown.title, 'Needs you');
    assert.ok(!shown.body.includes('kohi-event'), 'the workspace text is not in the body, only the untrusted detail');
  } finally {
    stop();
  }
});

test('T-675: an alert for a 190-character workspace id still reaches the push bridge (its subject id fits the bus); two long ids sharing a start stay two items', async () => {
  const { bridgeAttentionNotify } = await import('../attention/notify.js');
  const { createBus } = await import('../notify/bus.js');
  let now = Date.parse('2026-10-15T02:00:00Z');
  let next = reading(6 * GiB);
  const mem = new WorkspaceMemory({ read: async () => next, now: () => now });
  const registry = new AttentionRegistry({ now: () => now, tickMs: 0 });
  registry.register(memoryAttentionSource(mem));
  const bus = createBus();
  const sent: { subject: { id: string } }[] = [];
  bus.on('*', (e) => void sent.push(e as never));
  const stop = bridgeAttentionNotify(registry, bus, () => ['u_owner']);
  try {
    registry.check(); // the baseline
    const a = `kubernetes/${'w'.repeat(178)}a`; // 190 characters
    const b = `kubernetes/${'w'.repeat(178)}b`;
    assert.equal(a.length, 190);
    now += 61_000;
    next = reading(Math.round(7 * GiB), 8 * GiB, now);
    await mem.look([a, b]);
    const changed = registry.check();
    assert.equal(changed?.added.length, 2, 'two items');
    assert.equal(new Set(changed?.added.map((x) => x.id)).size, 2, 'different ids');
    assert.equal(sent.length, 2, 'both pushes were emitted, none dropped by the bus');
    for (const e of sent) assert.ok(e.subject.id.length <= 200, e.subject.id);
  } finally {
    stop();
  }
});

test('T-675: memoryItemId keeps a short workspace id whole and clips and hashes a long one', () => {
  assert.equal(memoryItemId('docker/ws1', '2026-10-15T02:00:00.000Z'), 'docker/ws1@2026-10-15T02:00:00.000Z');
  const long = `kubernetes/${'x'.repeat(300)}`;
  const id = memoryItemId(long, '2026-10-15T02:00:00.000Z');
  assert.ok(id.length < 150, String(id.length));
  assert.equal(id, memoryItemId(long, '2026-10-15T02:00:00.000Z'), 'stable');
});

test('T-733 S1 (T-675): the 100/101-character boundary of memoryItemId, and the push subject fits the bus for every length', async () => {
  const { createHash } = await import('node:crypto');
  const { validateEvent } = await import('../notify/bus.js');
  const since = '2026-10-15T02:00:00.000Z';
  const ws100 = 'k'.repeat(100);
  assert.equal(memoryItemId(ws100, since), `${ws100}@${since}`, '100 characters are kept whole, no hash');
  const ws101 = 'k'.repeat(101);
  const id101 = memoryItemId(ws101, since);
  const hash = createHash('sha256').update(ws101).digest('hex').slice(0, 10);
  assert.equal(id101, `${'k'.repeat(100)}.${hash}@${since}`, '101 characters: clipped to 100, a dot, 10 hex of the whole id');
  assert.equal(id101.indexOf('.'), 100);
  assert.match(id101, /^k{100}\.[0-9a-f]{10}@/);
  // The hash covers the whole id: two ids that differ only after the clip stay two items.
  assert.notEqual(memoryItemId(`${'k'.repeat(100)}a`, since), memoryItemId(`${'k'.repeat(100)}b`, since));
  // The bus drops a subject id it does not accept (bus.ts ID: 200 characters): the push subject is `attention:workspace_memory:<id>`.
  for (const n of [100, 101, 300, 1000]) {
    const w = 'k'.repeat(n);
    const out = validateEvent({ kind: 'attention', subject: { type: 'portal', id: `attention:workspace_memory:${memoryItemId(w, since)}` }, facts: {} }, 'e1', since);
    assert.equal(typeof out, 'object', `${n}-character workspace id: ${String(out)}`);
  }
});
