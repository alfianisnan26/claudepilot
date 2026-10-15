// A portal database at the owner's scale (T-378, docs/coord/QA-STANDARDS.md B1): QA ran its list checks on near-empty scratch portals and
// missed what the owner saw on his phone (workers flat under an idle lead in the In progress chip; rows of 4-5 lines with labels repeated).
// This seeds, into a scratch portal's database while it runs, rows whose ids start "qascale-":
//   - three crews: lead A WORKING with 40 workers (working, idle, ended; some titled like their role); lead B IDLE while its workers work (one
//     waits on you); lead C IDLE whose worker works and has a worker of its own (a worker's worker);
//   - 500 sessions in all, on two workspaces (most on one) with one persona, on four Claudes (Default, Work, Alt, Old) with plan readings:
//     Old's is three days stale; Alt has none;
//   - transcripts of 25,000 events (lead A) and 10,000 events (a bulk session): most tool results ~1 KiB, every 100th 50 KiB;
//   - usage rows (chat_usage) over 30 days.
// Everything is generated here; no real transcript, no token-shaped literal.
// The liveness trap (T-321): the portal's 60 s tick marks a session with process 'live' whose process it cannot find Interrupted. So every
// working and idle session is seeded with process 'gone' (the tick leaves those alone; the list still reads their state), and the two that
// wait on you are 'live' on workspaces the scratch portal cannot reach (its status check answers "unknown" and leaves them).
//   node tools/qa/seed-scale.mjs [dbPath] [--purge]      dbPath default /tmp/scratch-portal-$QA_PORT/data/portal.db
//   import { seedScale, purgeScale, CREWS } from './seed-scale.mjs'   (session-density.mjs and crew-tree.mjs seed with it)
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export const WS = 'docker/qa-scale';
export const WS2 = 'docker/qa-scale-2';
export const PERSONA = 'QA Scale Persona';
export const TOTAL = 500;
const P = 'qascale-';

/** The crews, for the checks: the leads, and each worker's lead (its parent). */
export const CREWS = { leads: ['qascale-lead-a', 'qascale-lead-b', 'qascale-lead-c'], parentOf: new Map() };
/** The sessions on the Claude whose plan reading is stale (Old). */
export const ON_STALE = new Set();

export function purgeScale(db) {
  db.exec(`DELETE FROM chat_usage WHERE session_id LIKE '${P}%';
    DELETE FROM chat_requests WHERE session_id LIKE '${P}%';
    DELETE FROM chat_events WHERE session_id LIKE '${P}%';
    DELETE FROM chat_sessions WHERE id LIKE '${P}%';
    DELETE FROM claude_usage_latest WHERE claude_id LIKE '${P}%';
    DELETE FROM workspace_claudes WHERE id LIKE '${P}%';
    DELETE FROM assignments WHERE pool_id LIKE '${P}%';
    DELETE FROM pools WHERE id LIKE '${P}%'`);
}

const ROLES = ['implementer', 'qa-verifier', 'reviewer', 'explorer', 'scribe'];
const TASKS = ['fix login redirect', 'refactor store layer', 'write tests for crew', 'investigate flaky gate', 'update docs', 'tune list paging'];

/**
 * Seeds the database (purging an earlier seed first). Returns facts the checks use. `now` is the real clock: nothing depends on a date.
 * @param {DatabaseSync} db
 */
export function seedScale(db, { events = [25_000, 10_000] } = {}) {
  purgeScale(db);
  CREWS.parentOf.clear();
  ON_STALE.clear();
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  db.exec('BEGIN');
  try {
    // Claudes and their plan readings: Work and Old read, Old three days ago (stale); Alt has none (unavailable).
    const claudes = [
      ['', 'Default'],
      [`${P}cl-work`, 'Work'],
      [`${P}cl-alt`, 'Alt'],
      [`${P}cl-old`, 'Old'],
    ];
    const addClaude = db.prepare(`INSERT INTO workspace_claudes (id, workspace_id, name, directory, created_at) VALUES (?, ?, ?, '', ?)`);
    for (const [id, name] of claudes.slice(1)) addClaude.run(id, WS, name, iso(now - 86_400_000));
    const reading = db.prepare(`INSERT INTO claude_usage_latest (claude_id, workspace_id, checked_at_ms, last_probe_at_ms, runs_on, plan, windows, source) VALUES (?, ?, ?, ?, 'plan', 'max', ?, 'probe')`);
    const windows = (pct, at) => JSON.stringify([
      { key: 'session', label: 'Session', usedPct: pct, resetsAt: iso(at + 3 * 3_600_000), level: pct >= 80 ? 'near' : 'ok' },
      { key: 'week', label: 'Week', usedPct: pct / 2, resetsAt: iso(at + 4 * 86_400_000), level: 'ok' },
    ]);
    reading.run(`${P}cl-work`, WS, now - 120_000, now - 120_000, windows(42, now));
    const stale = now - 3 * 86_400_000;
    reading.run(`${P}cl-old`, WS, stale, stale, windows(88, stale));

    // One persona on both workspaces: its avatar would stand on every row.
    db.prepare(`INSERT INTO pools (id, type, name, description, current_revision, created_at, updated_at) VALUES (?, 'persona', ?, 'T-378 scale seed', 0, ?, ?)`).run(`${P}persona`, PERSONA, iso(now), iso(now));
    const assign = db.prepare(`INSERT INTO assignments (workspace_id, pool_id, pool_type, assigned_at) VALUES (?, ?, 'persona', ?)`);
    assign.run(WS, `${P}persona`, iso(now));
    assign.run(WS2, `${P}persona`, iso(now));

    const ins = db.prepare(`INSERT INTO chat_sessions (id, workspace_id, cwd, title, origin, state, state_since, process, model, mode, cost_est_usd, turns, launch,
      created_at, last_activity_at, ended_reason, parent_id, claude_id, started_by, agent, ticket_id, last_seq, context_used, context_window)
      VALUES (?, ?, '/home/node', ?, ?, ?, ?, ?, ?, 'default', ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1000000)`);
    let n = 0;
    const add = ({ id, title, state, parent = null, claude = '', ws = WS, agent = null, ticket = null, minsAgo, model = 'claude-opus-5-5' }) => {
      const born = now - minsAgo * 60_000;
      const live = state === 'waiting';
      ins.run(id, ws, title, 'ui', state, iso(born), live ? 'live' : 'gone', model, 0.02 + (n % 9) / 50, 1 + (n % 7), iso(born),
        iso(born + 30_000), state === 'ended' ? 'ended by you' : null, parent, claude, parent ? `session:${parent}` : 'ui', agent, ticket, 20_000 + n * 37);
      if (parent) CREWS.parentOf.set(id, parent);
      if (claude === `${P}cl-old`) ON_STALE.add(id);
      n++;
    };
    const claudeOf = (i) => claudes[i % claudes.length][0];

    // Crew A: a working lead with 40 workers.
    add({ id: `${P}lead-a`, title: 'QA scale lead A', state: 'working', agent: 'orchestrator', ticket: 'T-378', minsAgo: 300 });
    for (let i = 0; i < 40; i++) {
      const role = ROLES[i % ROLES.length];
      const state = i < 20 ? 'working' : i < 32 ? 'idle' : 'ended';
      // Every fifth worker is titled exactly like its role (the owner's "implementer · implementer").
      const title = i % 5 === 0 ? role : `QA scale A worker ${String(i + 1).padStart(2, '0')} ${TASKS[i % TASKS.length]}`;
      add({ id: `${P}a-${String(i + 1).padStart(2, '0')}`, title, state, parent: `${P}lead-a`, claude: claudeOf(i), agent: role, ticket: 'T-378', minsAgo: 290 - i });
    }
    // Crew B: an IDLE lead whose workers work; one waits on you.
    add({ id: `${P}lead-b`, title: 'QA scale lead B', state: 'idle', agent: 'orchestrator', minsAgo: 200, claude: `${P}cl-work` });
    for (let i = 0; i < 6; i++) {
      const state = i < 4 ? 'working' : i === 4 ? 'waiting' : 'idle';
      add({ id: `${P}b-${i + 1}`, title: `QA scale B worker ${i + 1} ${TASKS[i]}`, state, parent: `${P}lead-b`, claude: `${P}cl-work`, agent: ROLES[i % ROLES.length], minsAgo: 190 - i });
    }
    // Crew C: an IDLE lead, its working worker, and that worker's own worker.
    add({ id: `${P}lead-c`, title: 'QA scale lead C', state: 'idle', minsAgo: 150, claude: `${P}cl-old` });
    add({ id: `${P}c-1`, title: 'QA scale C worker 1 tune list paging', state: 'working', parent: `${P}lead-c`, claude: `${P}cl-old`, agent: 'implementer', minsAgo: 140 });
    add({ id: `${P}c-1-1`, title: 'QA scale C sub-worker 1 explore', state: 'working', parent: `${P}c-1`, claude: `${P}cl-old`, agent: 'explorer', minsAgo: 130 });
    // One more on its own that waits on you, so Needs you has a lead-less row too.
    add({ id: `${P}solo-wait`, title: 'QA scale solo waiting', state: 'waiting', minsAgo: 20, claude: `${P}cl-alt` });

    // The rest: bulk sessions over 30 days, most ended, a few idle and working, a few on the second workspace.
    const bulkStates = ['ended', 'ended', 'ended', 'idle', 'ended', 'ended', 'interrupted', 'ended', 'working', 'ended'];
    let b = 0;
    while (n < TOTAL) {
      b++;
      const state = bulkStates[b % bulkStates.length];
      add({
        id: `${P}bulk-${String(b).padStart(3, '0')}`,
        title: `QA scale bulk ${String(b).padStart(3, '0')} ${TASKS[b % TASKS.length]}`,
        state,
        claude: claudeOf(b),
        ws: b % 25 === 0 ? WS2 : WS,
        ticket: b % 3 === 0 ? `T-${300 + (b % 40)}` : null,
        minsAgo: 400 + ((b * 997) % (30 * 24 * 60)),
        model: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'][b % 3],
      });
    }

    // The two that wait on you have a question open.
    const req = db.prepare(`INSERT INTO chat_requests (session_id, request_id, kind, tool_name, title, detail, created_at) VALUES (?, 'r1', 'tool', 'Bash', 'Run a command', 'npm test', ?)`);
    req.run(`${P}b-5`, iso(now));
    req.run(`${P}solo-wait`, iso(now));

    // Transcripts: 25k events on lead A, 10k on bulk 001.
    const ev = db.prepare('INSERT INTO chat_events (session_id, seq, at, kind, uuid, payload) VALUES (?, ?, ?, ?, ?, ?)');
    const KIB = 'src/features/chat/SessionRow.tsx:42: const row = buildListView(sessions, { groupBy, filter, query });\n'.repeat(11); // ~1 KiB
    const BIG = KIB.repeat(50); // ~50 KiB
    const transcript = (sid, count) => {
      let seq = 0;
      let t = now - count * 1500;
      let turn = 0;
      const put = (kind, payload, uuid = null) => ev.run(sid, ++seq, iso((t += 1500)), kind, uuid, JSON.stringify(payload));
      while (seq < count) {
        turn++;
        put('user', { text: `Turn ${turn}: look at module ${turn % 37} and fix what is wrong.` }, `${sid}-u${turn}`);
        put('assistant', { text: `Looking at module ${turn % 37}. Running the checks first.` }, `${sid}-a${turn}`);
        for (let k = 0; k < 3 && seq < count - 1; k++) {
          const tu = `tu-${turn}-${k}`;
          put('tool_use', { text: `grep -rn "f${turn}" src/`, toolName: 'Bash', toolUseId: tu }, `${sid}-t${turn}-${k}`);
          put('tool_result', { text: (turn * 3 + k) % 100 === 0 ? BIG : KIB, toolName: 'Bash', toolUseId: tu });
        }
        if (seq < count) put('result', { text: 'done', costUsd: turn * 0.004, turnCostUsd: 0.004, durationMs: 4000, tokens: { input: 1200, output: 300, cacheRead: 5000, cacheWrite: 100 } });
      }
      db.prepare('UPDATE chat_sessions SET last_seq = ?, turns = ? WHERE id = ?').run(seq, turn, sid);
      return seq;
    };
    const sizes = { [`${P}lead-a`]: transcript(`${P}lead-a`, events[0]), [`${P}bulk-001`]: transcript(`${P}bulk-001`, events[1]) };

    // Usage rows: per session turns over 30 days.
    const use = db.prepare(`INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, requests, agents, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`);
    let usage = 0;
    for (let i = 0; i < 6000; i++) {
      const ms = now - ((i * 7919) % (30 * 86_400_000 / 1000)) * 1000;
      use.run(iso(ms), ms, `${P}bulk-${String((i % (TOTAL - 52)) + 1).padStart(3, '0')}`, WS, claudeOf(i) || null, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'][i % 3], 800 + (i % 900), 100 + (i % 300), (i % 5) * 1000, 0, 0.001 + (i % 13) / 1000, 900 + (i % 4000));
      usage++;
    }
    db.exec('COMMIT');
    return { sessions: n, events: sizes, usage, now };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dbPath = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? `/tmp/scratch-portal-${process.env.QA_PORT ?? 3101}/data/portal.db`;
  const db = new DatabaseSync(dbPath, { timeout: 10_000 });
  if (process.argv.includes('--purge')) {
    purgeScale(db);
    console.log('seed-scale: purged');
  } else {
    const r = seedScale(db);
    console.log(`seed-scale: ${r.sessions} sessions, transcripts ${JSON.stringify(r.events)}, ${r.usage} usage rows`);
  }
  db.close();
}
