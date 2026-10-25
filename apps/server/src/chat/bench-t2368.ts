// T-2368 benchmark (not a test, not shipped behaviour): the session list, a glance build and one session's fan-out read over a database
// shaped like production on 2026-10-25 (1,504 sessions, 29,844 chat tasks: one lead with 6,139, one with 1,917, the rest spread).
// Runs on any commit that has ChatStore and the glance (before T-2368 too): `cd apps/server && node --import tsx src/chat/bench-t2368.ts`.
// Prints one JSON line per measure: median and p90 in ms over the runs, and the rows it read.

import { performance } from 'node:perf_hooks';
import type { ChatTask } from '@portal/contracts';
import { ownerActor } from '../authz/seam.js';
import { glanceSources } from '../glance/authz.js';
import { buildSnapshot } from '../glance/build.js';
import { fakeCi } from '../glance/testkit.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { ChatStore } from './store.js';

const SESSIONS = 1500;
const TASKS = 30_000;
const HEAVY = [6139, 1917];
const RUNS = Number(process.env.BENCH_RUNS ?? 15);

const store = await Store.open({ dataDir: tempDirectory('cp-bench-'), secretKey: parseSecretKey(generateSecretKey()) });
const chat = new ChatStore(store);
const db = store.db!;

// Seed: sessions through the store (as the portal makes them), tasks and requests in bulk.
const ids: string[] = [];
for (let i = 0; i < SESSIONS; i++) {
  const id = `s${String(i).padStart(4, '0')}`;
  ids.push(id);
  chat.create({
    id,
    workspaceId: `kubernetes/ws${i % 12}`,
    cwd: '/home/node',
    title: id,
    origin: i % 3 ? 'mcp' : 'ui',
    parentId: i > 20 && i % 4 === 0 ? ids[i % 20]! : null,
  });
  // About a fifth are live (some working), the rest asleep or ended, like the fleet.
  const live = i % 5 === 0;
  chat.patchSession(id, {
    process: live ? 'live' : i % 2 ? 'asleep' : 'gone',
    state: live ? (i % 10 === 0 ? 'working' : 'idle') : i % 2 ? 'idle' : 'ended',
  });
}
const insertTask = db.prepare(
  'INSERT INTO chat_tasks (session_id, task_id, label, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)',
);
const insertAsk = db.prepare(
  'INSERT INTO chat_requests (session_id, request_id, kind, title, detail, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
db.exec('BEGIN');
let t = 0;
const status = (n: number) =>
  n % 97 === 0 ? 'running' : n % 211 === 0 ? null : n % 13 === 0 ? 'failed' : n % 17 === 0 ? 'killed' : 'completed';
const addTask = (sid: string) => {
  const at = new Date(Date.UTC(2026, 9, 1) + t * 60_000).toISOString();
  const st = status(t);
  insertTask.run(sid, `task-${t}`, `agent ${t}`, st, at, st === 'running' || st === null ? null : at);
  t++;
};
for (const [k, n] of HEAVY.entries()) for (let j = 0; j < n; j++) addTask(ids[k * 5]!);
while (t < TASKS) addTask(ids[t % SESSIONS]!);
for (let i = 0; i < SESSIONS * 4; i++) {
  const at = new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString();
  insertAsk.run(ids[i % SESSIONS]!, `r${i}`, 'tool', `Run ${i}`, 'ls -la', at, i % 50 === 0 ? null : at);
}
db.exec('COMMIT');
db.exec('ANALYZE');

const running = (id: string): ChatTask[] => {
  const own = (chat as unknown as { runningTasks?: (id: string) => ChatTask[] }).runningTasks;
  return own ? own.call(chat, id) : chat.tasks(id).filter((x) => x.status === 'running');
};
const reads = glanceSources({
  // Both names: the source before T-2368 asks `tasks` (the whole history), the one after asks `runningTasks`.
  chat: {
    list: () => chat.list(),
    openRequests: (id: string) => chat.openRequests(id),
    tasks: (id: string) => chat.tasks(id),
    runningTasks: running,
  } as never,
  tickets: { list: () => ({ items: [], total: 0, counts: { byStatus: {} as never, needsYou: 0, unassigned: 0, total: 0 } }) } as never,
  ci: fakeCi([]),
});

function measure(name: string, fn: () => unknown) {
  fn(); // warm
  const ms: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const a = performance.now();
    fn();
    ms.push(performance.now() - a);
  }
  ms.sort((x, y) => x - y);
  const q = (p: number) => Number(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]!.toFixed(2));
  console.log(JSON.stringify({ name, runs: RUNS, medianMs: q(0.5), p90Ms: q(0.9), minMs: q(0) }));
}

const heavy = ids[0]!;
const counts = {
  sessions: (db.prepare('SELECT count(*) AS n FROM chat_sessions').get() as { n: number }).n,
  tasks: t,
  heavyTasks: chat.tasks(heavy).length,
};
console.log(
  JSON.stringify({
    name: 'shape',
    ...counts,
    index: !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chat_tasks_session_status'").get(),
  }),
);
measure('list (all sessions)', () => chat.list());
measure('glance build', () => buildSnapshot(reads, ownerActor(), Date.UTC(2026, 9, 25, 12)));
// A session event's read for the heaviest lead: its row as tabs see it, and its running agents (the controller's count before a move/restart).
measure('session fan-out x100 (heaviest lead)', () => {
  for (let i = 0; i < 100; i++) {
    chat.get(heavy);
    running(heavy);
  }
});
store.close();
