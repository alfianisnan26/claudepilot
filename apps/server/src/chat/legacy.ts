// Migration 17 helpers: one chat across Claudes (Workspace Claudes, owner's correction of 2026-10-12). Before it,
// moving a chat to another Claude made a second session row (`predecessor_id` / `successor_id`) and left the
// first one behind. Now the chat is one portal session whose Claude Code session underneath changes, so those
// pairs are folded into one row, with segments for the runs and an alias for each folded id.

import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, string | number | null>;

/** A segment for every session that has none: one run, on the session's Claude, under the session's own id. */
export function backfillSegments(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO chat_segments (session_id, n, claude_id, claude_session_id, cwd, started_at, ended_at, ended_reason, cost_usd, turns)
    SELECT id, 1, coalesce(claude_id, ''), id, cwd, created_at,
           CASE WHEN state = 'ended' THEN last_activity_at END,
           CASE WHEN state = 'ended' THEN coalesce(ended_reason, 'closed') END,
           cost_est_usd, turns
    FROM chat_sessions s
    WHERE NOT EXISTS (SELECT 1 FROM chat_segments g WHERE g.session_id = s.id)
  `);
}

/**
 * Folds every legacy transfer chain into its first session, oldest first. The folded session keeps the
 * first one's id (it is the stable portal id from now on) and takes the last one's state, process and
 * Claude; the events follow each other in one transcript; cost and turns add up; each run is a segment;
 * each folded id becomes an alias, so old links and references still find the chat. Returns how many
 * sessions were folded away.
 */
export function foldTransferPairs(db: DatabaseSync): number {
  const get = (id: string) => db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as Row | undefined;
  const heads = db
    .prepare(
      `SELECT id FROM chat_sessions s WHERE successor_id IS NOT NULL
         AND (predecessor_id IS NULL OR NOT EXISTS (SELECT 1 FROM chat_sessions p WHERE p.id = s.predecessor_id))`,
    )
    .all() as { id: string }[];
  let folded = 0;
  for (const { id: root } of heads) {
    for (let hops = 0; hops < 100; hops++) {
      const r = get(root);
      const next = typeof r?.successor_id === 'string' ? r.successor_id : null;
      if (!r || !next) break;
      const succ = get(next);
      if (!succ || next === root) {
        db.prepare('UPDATE chat_sessions SET successor_id = NULL WHERE id = ?').run(root);
        break;
      }
      foldInto(db, r, succ);
      folded++;
    }
  }
  // Whatever still points at a session that is gone is history nobody can open.
  db.exec(`
    UPDATE chat_sessions SET successor_id = NULL WHERE successor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chat_sessions p WHERE p.id = chat_sessions.successor_id);
    UPDATE chat_sessions SET predecessor_id = NULL WHERE predecessor_id IS NOT NULL;
  `);
  return folded;
}

function foldInto(db: DatabaseSync, root: Row, succ: Row): void {
  const rootId = String(root.id);
  const succId = String(succ.id);
  const offset = (db.prepare('SELECT coalesce(max(seq), 0) AS m FROM chat_events WHERE session_id = ?').get(rootId) as { m: number }).m;

  // The successor's transcript follows the first one's, in the same session.
  db.prepare('UPDATE chat_events SET session_id = ?, seq = seq + ? WHERE session_id = ?').run(rootId, offset, succId);
  for (const table of ['chat_inputs', 'chat_requests', 'chat_tasks']) {
    db.prepare(`UPDATE OR IGNORE ${table} SET session_id = ? WHERE session_id = ?`).run(rootId, succId);
  }
  db.prepare('UPDATE chat_files SET session_id = ? WHERE session_id = ?').run(rootId, succId);
  db.prepare('UPDATE chat_usage SET session_id = ? WHERE session_id = ?').run(rootId, succId);

  // Segments: the first session's run is closed at the move, the successor's is the one running now.
  const closed = db.prepare('SELECT coalesce(sum(turns), 0) AS t FROM chat_segments WHERE session_id = ? AND ended_at IS NOT NULL').get(rootId) as { t: number };
  const open = db.prepare('SELECT n FROM chat_segments WHERE session_id = ? AND ended_at IS NULL ORDER BY n DESC LIMIT 1').get(rootId) as { n: number } | undefined;
  const last = db.prepare('SELECT coalesce(max(n), 0) AS n FROM chat_segments WHERE session_id = ?').get(rootId) as { n: number };
  // A session an old move ended (`transferred`) has its run closed already: it ended because the chat moved.
  db.prepare(`UPDATE chat_segments SET ended_reason = 'switched' WHERE session_id = ? AND n = ? AND ended_reason = 'transferred'`).run(rootId, last.n);
  const rootCost = Number(root.cost_est_usd) || 0;
  const rootBase = Number(root.cost_base_usd) || 0;
  if (open)
    db.prepare(`UPDATE chat_segments SET ended_at = ?, ended_reason = 'switched', cost_usd = ?, turns = ? WHERE session_id = ? AND n = ?`).run(
      String(succ.created_at),
      Math.max(0, rootCost - rootBase),
      Math.max(0, (Number(root.turns) || 0) - closed.t),
      rootId,
      open.n,
    );
  const succEnded = succ.state === 'ended';
  db.prepare(
    `INSERT INTO chat_segments (session_id, n, claude_id, claude_session_id, cwd, started_at, ended_at, ended_reason, cost_usd, turns)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rootId,
    last.n + 1,
    String(succ.claude_id ?? ''),
    succId,
    String(succ.cwd ?? ''),
    String(succ.created_at),
    succEnded ? String(succ.last_activity_at) : null,
    succEnded ? String(succ.ended_reason ?? 'closed') : null,
    Number(succ.cost_est_usd) || 0,
    Number(succ.turns) || 0,
  );

  // The session itself: the successor's state and process (the host keeps its files under the successor's id,
  // which is now the Claude Code session id), the sum of the cost, the first session's id.
  db.prepare(
    `UPDATE chat_sessions SET
       title = ?, cwd = ?, state = ?, state_since = ?, process = ?, parent_pid = ?, process_started_at = ?, segment = ?, byte_offset = ?,
       model = ?, mode = ?, effort = ?, ultracode = ?, ultracode_available = ?, context_used = ?, context_window = ?,
       claude_id = ?, claude_session_id = ?, ended_reason = ?, archived_at = ?,
       cost_est_usd = ?, cost_base_usd = ?, turns = ?, last_seq = ?, last_activity_at = ?, segment_seq = ?,
       worktree_path = coalesce(?, worktree_path), worktree_branch = coalesce(?, worktree_branch), worktree_repo = coalesce(?, worktree_repo),
       ticket_id = coalesce(ticket_id, ?), parent_id = coalesce(parent_id, ?),
       successor_id = ?, predecessor_id = NULL
     WHERE id = ?`,
  ).run(
    String(succ.title),
    String(succ.cwd),
    String(succ.state),
    String(succ.state_since),
    String(succ.process),
    succ.parent_pid ?? null,
    succ.process_started_at ?? null,
    Number(succ.segment),
    Number(succ.byte_offset),
    succ.model ?? null,
    String(succ.mode),
    succ.effort ?? null,
    Number(succ.ultracode),
    Number(succ.ultracode_available),
    succ.context_used ?? null,
    succ.context_window ?? null,
    String(succ.claude_id ?? ''),
    succId,
    succ.ended_reason ?? null,
    succ.archived_at ?? null,
    rootCost + (Number(succ.cost_est_usd) || 0),
    rootCost,
    (Number(root.turns) || 0) + (Number(succ.turns) || 0),
    offset + (Number(succ.last_seq) || 0),
    String(succ.last_activity_at) > String(root.last_activity_at) ? String(succ.last_activity_at) : String(root.last_activity_at),
    offset,
    succ.worktree_path ?? null,
    succ.worktree_branch ?? null,
    succ.worktree_repo ?? null,
    succ.ticket_id ?? null,
    succ.parent_id ?? null,
    succ.successor_id ?? null,
    rootId,
  );

  // Old links and references to the folded session still find the chat; what reported to it reports to the chat.
  db.prepare('UPDATE chat_session_aliases SET session_id = ? WHERE session_id = ?').run(rootId, succId);
  db.prepare('INSERT OR REPLACE INTO chat_session_aliases (alias_id, session_id) VALUES (?, ?)').run(succId, rootId);
  db.prepare('UPDATE chat_sessions SET parent_id = ? WHERE parent_id = ?').run(rootId, succId);
  db.prepare('UPDATE claude_handoffs SET successor_session_id = ? WHERE successor_session_id = ?').run(rootId, succId);
  db.prepare('UPDATE claude_handoffs SET source_session_id = ? WHERE source_session_id = ?').run(rootId, succId);
  db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(succId);
}
