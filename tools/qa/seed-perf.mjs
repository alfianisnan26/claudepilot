// Superseded for list checks by seed-scale.mjs (T-378: crews, Claudes, readings, today's schema); kept for the old perf notes that name it.
// Seeds a QA portal database with load: one session of N transcript events, M more sessions, and U usage rows.
// Stop the portal first (it holds the database), then:  node tools/qa/seed-perf.mjs [dbPath] [events] [sessions] [usageRows]
// Everything is marked "QA perf" / "QA bulk" so it is easy to find and to delete again with --purge.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const [dbPath = '/tmp/qadata/portal.db', eventsArg = '6000', sessionsArg = '500', usageArg = '100000'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const events = Number(eventsArg);
const sessions = Number(sessionsArg);
const usageRows = Number(usageArg);
const db = new DatabaseSync(dbPath, { timeout: 10000 });
db.exec('PRAGMA foreign_keys = ON');

if (process.argv.includes('--purge')) {
  db.exec("DELETE FROM chat_usage WHERE session_id LIKE 'qaperf-%'; DELETE FROM chat_sessions WHERE title LIKE 'QA perf%' OR title LIKE 'QA bulk%'");
  console.log('purged');
  process.exit(0);
}

const claude = (db.prepare("SELECT id FROM workspace_claudes WHERE workspace_id = 'docker/qa-ws1' AND directory = '' LIMIT 1").get() ?? {}).id ?? '';
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const insertSession = db.prepare(`INSERT INTO chat_sessions (id, workspace_id, cwd, title, origin, state, state_since, process, segment, last_seq, model, mode, cost_est_usd, turns, launch, created_at, last_activity_at, ended_reason, archived_at, effort, claude_id, context_used, context_window)
  VALUES (?, 'docker/qa-ws1', '/home/node', ?, 'ui', ?, ?, 'gone', 1, ?, 'claude-opus-5-5', 'default', ?, ?, '{}', ?, ?, ?, ?, 'medium', ?, 1000, 1000000)`);
const insertEvent = db.prepare('INSERT INTO chat_events (session_id, seq, at, kind, uuid, payload) VALUES (?, ?, ?, ?, ?, ?)');
const json = JSON.stringify;
const lorem = 'The quick brown fox jumps over the lazy dog. ';

db.exec('BEGIN');
// 1. One long transcript.
const big = `qaperf-${randomUUID()}`;
const start = now - 3 * 24 * 3600 * 1000;
let seq = 0;
let t = start;
insertSession.run(big, 'QA perf', 'ended', iso(start), 0, 0, 0, iso(start), iso(start), 'QA seed', null, claude);
const at = () => iso((t += 1500));
const add = (kind, payload, uuid = null) => insertEvent.run(big, ++seq, at(), kind, uuid, json(payload));
let turns = 0;
let cost = 0;
while (seq < events) {
  turns++;
  add('user', { text: `Turn ${turns}: please look at module ${turns % 37} and fix the thing. ${lorem.repeat(1 + (turns % 4))}` }, randomUUID());
  add('assistant', { text: `Sure. Here is what I found in module ${turns % 37}:\n\n- first point about ${turns}\n- second point\n\n\`\`\`ts\nexport function f${turns}(a: number): number {\n  return a * ${turns};\n}\n\`\`\`\n\n${lorem.repeat(5)}` }, randomUUID());
  if (turns % 5 === 0) add('thinking', { text: `Thinking about turn ${turns}. ${lorem.repeat(8)}`, durationMs: 1200 + turns });
  const tools = 1 + (turns % 4);
  for (let i = 0; i < tools; i++) {
    const id = `toolu_${turns}_${i}`;
    add('tool_use', { text: `grep -rn "f${turns}" src/ --include=*.ts`, toolName: 'Bash', toolUseId: id }, randomUUID());
    add('tool_result', { text: turns % 50 === 0 ? `${'src/some/file.ts:12: match line\n'.repeat(700)}` : `src/m${turns}.ts:1: export function f${turns}`, toolName: 'Bash', toolUseId: id });
  }
  const turnCost = 0.002 + (turns % 7) * 0.001;
  cost += turnCost;
  add('result', { text: 'done', costUsd: cost, turnCostUsd: turnCost, durationMs: 4000, tokens: { input: 1000 + turns, output: 300, cacheRead: 5000, cacheWrite: 100 } });
}
db.prepare('UPDATE chat_sessions SET title = ?, last_seq = ?, cost_est_usd = ?, turns = ?, state_since = ?, last_activity_at = ? WHERE id = ?').run(`QA perf ${seq} events`, seq, cost, turns, iso(t), iso(t), big);

// 2. Many more sessions, spread over 30 days, a few events each.
const states = ['ended', 'ended', 'interrupted', 'ended'];
for (let i = 0; i < sessions; i++) {
  const id = `qaperf-${randomUUID()}`;
  const created = now - Math.floor(Math.random() * 30 * 24 * 3600 * 1000);
  const state = states[i % states.length];
  insertSession.run(id, `QA bulk ${String(i + 1).padStart(3, '0')} ${['fix login', 'refactor store', 'write tests', 'investigate flaky', 'update docs'][i % 5]}`, state, iso(created), 3, 0.01 + (i % 9) / 100, 1, iso(created), iso(created + 60000), state === 'ended' ? 'QA seed' : null, i % 11 === 0 ? iso(created + 120000) : null, claude);
  let s = 0;
  insertEvent.run(id, ++s, iso(created), 'user', randomUUID(), json({ text: `Please ${['fix login', 'refactor store', 'write tests', 'investigate flaky', 'update docs'][i % 5]}` }));
  insertEvent.run(id, ++s, iso(created + 3000), 'assistant', randomUUID(), json({ text: `On it. ${lorem}` }));
  insertEvent.run(id, ++s, iso(created + 6000), 'result', null, json({ text: 'done', costUsd: 0.01, turnCostUsd: 0.01, durationMs: 3000, tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } }));
}

// 3. Usage: one row per model per turn, over 30 days.
const insertUsage = db.prepare('INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, requests, agents, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)');
const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
for (let i = 0; i < usageRows; i++) {
  const ms = now - Math.floor(Math.random() * 30 * 24 * 3600 * 1000);
  insertUsage.run(iso(ms), ms, `qaperf-usage-${i % 50}`, 'docker/qa-ws1', claude, models[i % 3], 500 + (i % 900), 100 + (i % 300), (i % 5) * 1000, i % 7 === 0 ? 400 : 0, 0.001 + (i % 13) / 1000, i % 20 === 0 ? 1 : 0, 800 + (i % 5000));
}
db.exec('COMMIT');
console.log(`seeded: session ${big} with ${seq} events (${turns} turns), ${sessions} sessions, ${usageRows} usage rows`);
