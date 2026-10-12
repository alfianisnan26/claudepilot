// Migration 17: the two rows an old move left (a session ended as transferred, and its successor) become one
// chat. The database here is built the way the old code built such a pair: migrations up to 16, sessions
// linked by predecessor_id and successor_id, the successor with its own events, inputs, requests, tasks,
// files and usage.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { MIGRATIONS } from '../store/migrations.js';
import { Store } from '../store/store.js';
import { ChatStore } from './store.js';

const T0 = Date.parse('2026-10-11T10:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

type Db = NonNullable<Store['db']>;

/** One session row as the old code wrote it (every column that existed at migration 16). */
function session(db: Db, o: { id: string; claude?: string; state?: string; ended?: string | null; successor?: string | null; predecessor?: string | null; cost?: number; turns?: number; created: number; last: number; seq: number; title?: string; parent?: string | null; process?: string; offset?: number; model?: string }) {
  db.prepare(
    `INSERT INTO chat_sessions (id, workspace_id, cwd, title, origin, state, state_since, process, parent_pid, process_started_at, segment, byte_offset, last_seq, model, mode,
       cost_est_usd, turns, created_at, last_activity_at, ended_reason, claude_id, predecessor_id, successor_id, parent_id, started_by)
     VALUES (?, 'docker/ws1', '/home/node/work', ?, 'ui', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ui')`,
  ).run(
    o.id,
    o.title ?? 'Greetings',
    o.state ?? 'idle',
    at(o.last),
    o.process ?? 'live',
    o.process === 'gone' ? null : 4242,
    o.process === 'gone' ? null : at(o.created),
    o.process === 'gone' ? 3 : 0,
    o.offset ?? 0,
    o.seq,
    o.model ?? 'claude-opus-5-5',
    o.cost ?? 0,
    o.turns ?? 0,
    at(o.created),
    at(o.last),
    o.ended ?? null,
    o.claude ?? '',
    o.predecessor ?? null,
    o.successor ?? null,
    o.parent ?? null,
  );
}
const event = (db: Db, id: string, seq: number, kind: string, text: string, min: number, extra: Record<string, unknown> = {}, uuid: string | null = null) =>
  db.prepare('INSERT INTO chat_events (session_id, seq, at, kind, uuid, payload) VALUES (?, ?, ?, ?, ?, ?)').run(id, seq, at(min), kind, uuid, JSON.stringify({ text, ...extra }));

/** A database as the old code left it after two moves (A → B → C) and a session that never moved. */
async function oldDatabase() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-legacy-'));
  const secretKey = parseSecretKey(generateSecretKey());
  const before = await Store.open({ dataDir, secretKey, migrations: MIGRATIONS.filter((m) => m.version <= 16) });
  const db = before.db!;
  const claudes = [
    ['c-default', ''],
    ['c-satria', 'claudes/aaaaaaaaaaaaaaaa'],
    ['c-work', 'claudes/bbbbbbbbbbbbbbbb'],
  ] as const;
  for (const [id, dir] of claudes)
    db.prepare(`INSERT INTO workspace_claudes (id, workspace_id, name, directory, created_at) VALUES (?, 'docker/ws1', ?, ?, ?)`).run(id, id === 'c-default' ? 'Default' : id === 'c-satria' ? 'satria' : 'Work', dir, at(0));

  // A (Default): ended as transferred to B. B (satria): ended as transferred to C. C (Work): the one running.
  session(db, { id: 'A', claude: 'c-default', state: 'ended', ended: 'transferred', successor: 'B', cost: 0.3, turns: 2, created: 1, last: 10, seq: 4, process: 'gone' });
  event(db, 'A', 1, 'user', 'Greetings', 1, {}, 'u-a1');
  event(db, 'A', 2, 'assistant', 'Hello! How can I help?', 2);
  event(db, 'A', 3, 'result', '', 3, { costUsd: 0.3 });
  event(db, 'A', 4, 'user', 'Remember the word heliotrope', 4, {}, 'u-a2');
  session(db, { id: 'B', claude: 'c-satria', state: 'ended', ended: 'transferred', predecessor: 'A', successor: 'C', cost: 0.2, turns: 1, created: 11, last: 20, seq: 3, process: 'gone' });
  event(db, 'B', 1, 'system', 'New session on satria · transferred from Default', 11);
  event(db, 'B', 2, 'user', '<transferred_context>…</transferred_context>', 11, { transfer: { fromClaude: 'Default', toClaude: 'satria', sourceSessionId: 'A', path: '/home/node/.claudepilot/transfer/x.md', messages: 2, truncated: false } }, 'u-b1');
  event(db, 'B', 3, 'assistant', 'We were saying hello.', 12);
  session(db, { id: 'C', claude: 'c-work', predecessor: 'B', cost: 0.07, turns: 1, created: 21, last: 30, seq: 3, title: 'Greetings (renamed)', offset: 777, parent: null });
  event(db, 'C', 1, 'system', 'New session on Work · transferred from satria', 21);
  event(db, 'C', 2, 'user', '<transferred_context>…</transferred_context>', 21, { transfer: { fromClaude: 'satria', toClaude: 'Work', sourceSessionId: 'B', path: '/home/node/.claudepilot/transfer/y.md', messages: 3, truncated: false } }, 'u-c1');
  event(db, 'C', 3, 'assistant', 'Continuing: heliotrope.', 22);
  db.prepare(`INSERT INTO chat_inputs (session_id, uuid, actor, kind, state, created_at) VALUES ('C', 'u-c1', 'ui', 'message', 'completed', ?)`).run(at(21));
  db.prepare(`INSERT INTO chat_requests (session_id, request_id, kind, title, created_at) VALUES ('C', 'r-c', 'tool', 'Run a command', ?)`).run(at(25));
  db.prepare(`INSERT INTO chat_tasks (session_id, task_id, label, status, started_at) VALUES ('C', 't-c', 'Look around', 'completed', ?)`).run(at(23));
  db.prepare(`INSERT INTO chat_files (session_id, kind, name, at) VALUES ('C', 'upload', 'shot.png', ?)`).run(at(24));
  for (const [id, claude, min, cost] of [['A', 'c-default', 3, 0.3], ['B', 'c-satria', 12, 0.2], ['C', 'c-work', 22, 0.07]] as const)
    db.prepare(`INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, cost_usd, requests) VALUES (?, ?, ?, 'docker/ws1', ?, 'm', ?, 1)`).run(at(min), T0 + min * 60_000, id, claude, cost);
  // A worker the last session started, and a session that never moved.
  session(db, { id: 'W', claude: 'c-work', created: 26, last: 27, seq: 0, title: 'Worker', parent: 'C' });
  session(db, { id: 'N', claude: 'c-default', created: 40, last: 41, seq: 1, title: 'Never moved', cost: 0.01, turns: 1 });
  event(db, 'N', 1, 'user', 'hi', 40);
  db.prepare(`INSERT INTO claude_handoffs (id, workspace_id, source_session_id, successor_session_id, source_claude_id, dest_claude_id, path, created_at) VALUES ('h1', 'docker/ws1', 'A', 'B', 'c-default', 'c-satria', '/p', ?)`).run(at(10));
  before.close();
  return { dataDir, secretKey };
}

test('migration 17: two moves become one chat: the first session’s id, the last one’s state and Claude, one transcript, summed cost, one segment per run, an alias per folded id', async () => {
  const { dataDir, secretKey } = await oldDatabase();
  const store = await Store.open({ dataDir, secretKey });
  try {
    const chat = new ChatStore(store);
    const sessions = chat.list();
    assert.deepEqual(sessions.map((s) => s.id).sort(), ['A', 'N', 'W'], 'one row for the chat that moved twice, the worker and the session that never moved');
    const a = chat.get('A')!;
    assert.equal(a.title, 'Greetings (renamed)', 'what the person sees now');
    assert.deepEqual([a.state, a.process, a.claudeName, a.claudeSessionId], ['idle', 'live', 'Work', 'C'], 'the running run: its state, Claude, and the id the host keeps its files under');
    assert.deepEqual([a.predecessorId, a.successorId, a.endedReason], [null, null, null]);
    assert.deepEqual(a.previousClaudes.map((c) => c.name), ['Default', 'satria']);
    assert.ok(Math.abs(a.costUsd - 0.57) < 1e-9, `0.3 + 0.2 + 0.07: ${a.costUsd}`);
    assert.equal(a.turns, 4);
    assert.equal(chat.row('A')!.byte_offset, 777, 'the reader keeps its place in the running run’s log');

    // One continuous transcript, gap-free.
    const events = chat.history('A');
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(events.map((e) => e.kind), ['user', 'assistant', 'result', 'user', 'system', 'user', 'assistant', 'system', 'user', 'assistant']);
    assert.equal(events[0]!.text, 'Greetings');
    assert.equal(events[8]!.transfer?.toClaude, 'Work');
    assert.equal(a.lastSeq, 10);

    // Segments: Default and satria ended (switched), Work running, each under its own Claude Code session.
    assert.deepEqual(chat.segments('A').map((g) => [g.n, g.claudeName, g.claudeSessionId, g.endedReason]), [[1, 'Default', 'A', 'switched'], [2, 'satria', 'B', 'switched'], [3, 'Work', 'C', null]]);
    assert.ok(chat.segments('A').slice(0, 2).every((g) => g.costUsd > 0));
    assert.ok(Math.abs(chat.segments('A')[2]!.costUsd - 0.07) < 1e-9, 'the running run shows its own cost');

    // Old ids still find the chat; everything keyed by the folded sessions follows.
    assert.equal(chat.resolveId('B'), 'A');
    assert.equal(chat.resolveId('C'), 'A');
    assert.equal(chat.get('C')?.id, 'A');
    assert.equal(chat.resolveId('N'), 'N');
    const db = store.db!;
    assert.equal((db.prepare(`SELECT count(*) AS n FROM chat_inputs WHERE session_id = 'A' AND uuid = 'u-c1'`).get() as { n: number }).n, 1);
    assert.equal((db.prepare(`SELECT count(*) AS n FROM chat_requests WHERE session_id = 'A'`).get() as { n: number }).n, 1);
    assert.equal((db.prepare(`SELECT count(*) AS n FROM chat_tasks WHERE session_id = 'A'`).get() as { n: number }).n, 1);
    assert.equal((db.prepare(`SELECT count(*) AS n FROM chat_files WHERE session_id = 'A'`).get() as { n: number }).n, 1);
    assert.equal((db.prepare(`SELECT count(*) AS n FROM chat_sessions WHERE id IN ('B', 'C')`).get() as { n: number }).n, 0, 'the folded rows are gone');
    // Usage keeps the Claude of each turn, now under the one session.
    const usage = db.prepare('SELECT session_id AS s, claude_id AS c FROM chat_usage ORDER BY at_ms').all() as { s: string; c: string }[];
    assert.deepEqual(usage.map((u) => [u.s, u.c]), [['A', 'c-default'], ['A', 'c-satria'], ['A', 'c-work']]);
    // What reported to the last session reports to the chat; the handoff records point at it.
    assert.equal(chat.get('W')!.parentId, 'A');
    assert.deepEqual(db.prepare(`SELECT source_session_id AS s, successor_session_id AS t FROM claude_handoffs`).get() && { ...(db.prepare(`SELECT source_session_id AS s, successor_session_id AS t FROM claude_handoffs`).get() as object) }, { s: 'A', t: 'A' });
    // The session that never moved is as it was, with its one segment.
    assert.deepEqual(chat.segments('N').map((g) => [g.n, g.claudeName, g.claudeSessionId]), [[1, 'Default', 'N']]);
    assert.equal(chat.get('N')!.claudeSessionId, 'N');
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('migration 17: a session from before gets its first segment, and a pair whose successor was deleted just loses the dangling link', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-legacy-'));
  const secretKey = parseSecretKey(generateSecretKey());
  const before = await Store.open({ dataDir, secretKey, migrations: MIGRATIONS.filter((m) => m.version <= 16) });
  const db = before.db!;
  db.prepare(`INSERT INTO workspace_claudes (id, workspace_id, name, directory, created_at) VALUES ('c-default', 'docker/ws1', 'Default', '', ?)`).run(at(0));
  session(db, { id: 'A', claude: 'c-default', state: 'ended', ended: 'transferred', successor: 'GONE', cost: 0.3, turns: 2, created: 1, last: 10, seq: 0, process: 'gone' });
  session(db, { id: 'LIVE', claude: 'c-default', cost: 0.1, turns: 1, created: 2, last: 11, seq: 0 });
  before.close();
  const store = await Store.open({ dataDir, secretKey });
  try {
    const chat = new ChatStore(store);
    assert.equal(chat.get('A')!.successorId, null);
    assert.deepEqual(chat.segments('A').map((g) => [g.n, g.claudeSessionId, g.endedReason]), [[1, 'A', 'transferred']], 'closed for the reason it ended');
    assert.deepEqual(chat.segments('LIVE').map((g) => [g.n, g.endedReason]), [[1, null]], 'a running session has an open segment');
    assert.equal(chat.get('LIVE')!.claudeSessionId, 'LIVE');
    // The cost of a session that never moved is its running total: nothing to add.
    assert.ok(Math.abs(chat.segments('LIVE')[0]!.costUsd - 0.1) < 1e-9);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
