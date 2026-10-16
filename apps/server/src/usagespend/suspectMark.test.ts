// T-610: migration 384 marks the two carried-total rows of 2026-10-15 (a resumed process booked its running totals as one request: $96.31 at
// 15:05:34 UTC and $68.65 at 15:08:38) as `suspect`. Only those two; nothing else changes; a second run changes nothing; the day stops counting them.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MIGRATIONS } from '../store/migrations.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { SpendStore } from './store.js';

const VERSION = 384;
const BAD1 = Date.UTC(2026, 9, 15, 15, 5, 34);
const BAD2 = Date.UTC(2026, 9, 15, 15, 8, 38);
const DAY0 = Date.UTC(2026, 9, 15, 0, 0, 0);
const DAY1 = Date.UTC(2026, 9, 16, 0, 0, 0);

type Seed = { key: string; atMs: number; usd: number; session: string; kind?: string };
const SEEDS: Seed[] = [
  { key: 'bad1', atMs: BAD1, usd: 96.31, session: 'lead-a' },
  { key: 'bad2', atMs: BAD2 + 400, usd: 68.65, session: 'lead-b' },
  // Neighbours: same cost on another day, same time at another cost, a cost near but not at the cent, a normal turn in the same minute,
  // a side question (btw) with the same cost and time, and a row somebody already marked.
  { key: 'other-day', atMs: BAD1 - 24 * 3_600_000, usd: 96.31, session: 'lead-a' },
  { key: 'other-cost', atMs: BAD1, usd: 96.0, session: 'lead-a' },
  { key: 'near-cost', atMs: BAD2, usd: 68.66, session: 'lead-b' },
  { key: 'same-minute', atMs: BAD1 + 20_000, usd: 1.25, session: 'lead-a' },
  { key: 'too-late', atMs: BAD2 + 61_000, usd: 68.65, session: 'lead-b' },
  { key: 'btw', atMs: BAD1, usd: 96.31, session: 'lead-a', kind: 'btw' },
  { key: 'already', atMs: BAD2, usd: 68.65, session: 'lead-c', kind: 'suspect' },
  { key: 'plain', atMs: DAY0 + 3_600_000, usd: 2.5, session: 'lead-c' },
];

async function open(dataDir: string, upTo: 'before' | 'all') {
  const secretKey = parseSecretKey(generateSecretKey());
  return { store: await Store.open({ dataDir, secretKey, migrations: upTo === 'before' ? MIGRATIONS.filter((m) => m.version !== VERSION) : MIGRATIONS }), secretKey };
}

test('T-610 migration 384: exists once; marks exactly the two rows; the day stops counting them; a second run and an empty table change nothing', async () => {
  assert.equal(MIGRATIONS.filter((m) => m.version === VERSION).length, 1, 'migration 384 exists once');
  const dataDir = mkdtempSync(join(tmpdir(), 'mark-suspect-'));
  try {
    const before = await open(dataDir, 'before');
    const db0 = before.store.db!;
    for (const s of SEEDS) {
      db0.prepare("INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, model, cost_usd, requests, kind, ref) VALUES (?, ?, ?, 'docker/dev', 'opus', ?, 1, ?, ?)").run(new Date(s.atMs).toISOString(), s.atMs, s.session, s.usd, s.kind ?? 'turn', s.key);
    }
    const all = { kind: 'all', id: null } as const;
    const dayBefore = new SpendStore(before.store).sum(all, DAY0, DAY1);
    before.store.close();

    const upgraded = await Store.open({ dataDir, secretKey: before.secretKey });
    try {
      const db = upgraded.db!;
      const kinds = () => Object.fromEntries((db.prepare('SELECT ref, kind FROM chat_usage ORDER BY id').all() as { ref: string; kind: string }[]).map((r) => [r.ref, r.kind]));
      const want = { bad1: 'suspect', bad2: 'suspect', 'other-day': 'turn', 'other-cost': 'turn', 'near-cost': 'turn', 'same-minute': 'turn', 'too-late': 'turn', btw: 'btw', already: 'suspect', plain: 'turn' };
      assert.deepEqual(kinds(), want, 'only the two rows are marked; nothing else changed');
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM chat_usage').get() as { n: number }).n, SEEDS.length, 'no row deleted');
      // The rest of the two rows is untouched: marking changes `kind` and nothing else.
      const bad1 = db.prepare("SELECT at_ms, session_id, cost_usd, requests, ref FROM chat_usage WHERE ref = 'bad1'").get() as Record<string, unknown>;
      assert.deepEqual({ ...bad1 }, { at_ms: BAD1, session_id: 'lead-a', cost_usd: 96.31, requests: 1, ref: 'bad1' });

      // The scorecard day (the Requests report's own sum, a COUNTED_USAGE reader): before, it held both; now neither.
      const dayAfter = new SpendStore(upgraded).sum(all, DAY0, DAY1);
      assert.ok(Math.abs(dayBefore.costUsd - dayAfter.costUsd - (96.31 + 68.65)) < 1e-6, `the day dropped exactly the two rows (${dayBefore.costUsd} -> ${dayAfter.costUsd})`);
      assert.equal(dayBefore.requests - dayAfter.requests, 2);

      // Idempotent: running the migration again changes nothing.
      MIGRATIONS.find((m) => m.version === VERSION)!.up(db);
      assert.deepEqual(kinds(), want, 'a second run changes nothing');
    } finally {
      upgraded.close();
    }

    // No such rows (a fresh database, or one that never had them): nothing to do, and it does not fail.
    const emptyDir = mkdtempSync(join(tmpdir(), 'mark-suspect-empty-'));
    try {
      const fresh = await Store.open({ dataDir: emptyDir, secretKey: parseSecretKey(generateSecretKey()) });
      try {
        assert.equal((fresh.db!.prepare('SELECT COUNT(*) AS n FROM chat_usage').get() as { n: number }).n, 0);
      } finally {
        fresh.close();
      }
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
