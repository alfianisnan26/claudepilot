// Lineage (T-136 part E, D-30): a chat that ended and was continued by a NEW session row is one logical unit. `continued_from` on the
// later row names the row it continues; the chain runs root -> … -> head. A recovery in place (T-136 part B) will make no new rows; this
// is for the rows already split, and for any new session started to continue an ended one.

import type { DatabaseSync } from 'node:sqlite';

/** The chains split on 2026-10-13, oldest first, as id prefixes (ticket T-136): the orchestrator's three rows and the Konfersi chat's two. */
export const SPLIT_CHAINS_2026_10_13: readonly (readonly string[])[] = [
  ['fe3df8bc', 'fdb140be', '5c9fcb5f'],
  ['541948a5', '929ae1e3'],
];

type SessionRow = { id: string; workspace_id: string; state: string; pinned_at: string | null; ticket_id: string | null; continued_from: string | null };

/** What the repair did to one chain, for the migration's log and the tests. */
export interface ChainRepair {
  ids: string[];
  linked: number;
  pinMoved: boolean;
  ticketsMoved: string[];
}

/** The one session whose id starts with `prefix`, or null when none or more than one does. */
function byPrefix(db: DatabaseSync, prefix: string): SessionRow | null {
  const rows = db
    .prepare('SELECT id, workspace_id, state, pinned_at, ticket_id, continued_from FROM chat_sessions WHERE substr(id, 1, ?) = ? LIMIT 2')
    .all(prefix.length, prefix) as SessionRow[];
  return rows.length === 1 ? rows[0]! : null;
}

/**
 * The one-time repair of chains that are already split (migration 772): for each chain whose every prefix matches exactly one session
 * row, all in one workspace and all distinct, each later row is linked to the one before it (`continued_from`, never overwriting a
 * different link), a pin on an earlier row moves to the head (the earliest pin time; the earlier rows are unpinned), the head takes the
 * ticket link an earlier row had when it has none, and every ticket assigned to an ENDED earlier row is assigned to the head, with an
 * `assigned` entry on the ticket's timeline. A chain that does not resolve is left alone (a scratch portal, a test database): a no-op.
 * Sessions have no tags today, so there are none to carry. Returns what it did, chain by chain (only the chains it touched).
 */
export function repairSplitChains(db: DatabaseSync, chains: readonly (readonly string[])[] = SPLIT_CHAINS_2026_10_13, now = new Date()): ChainRepair[] {
  const done: ChainRepair[] = [];
  const at = now.toISOString();
  for (const prefixes of chains) {
    const rows = prefixes.map((p) => byPrefix(db, p));
    if (rows.some((r) => r === null)) continue;
    const chain = rows as SessionRow[];
    if (new Set(chain.map((r) => r.id)).size !== chain.length) continue;
    if (new Set(chain.map((r) => r.workspace_id)).size !== 1) continue;
    if (chain.some((r, i) => i > 0 && r.continued_from !== null && r.continued_from !== chain[i - 1]!.id)) continue;
    if (chain[0]!.continued_from !== null) continue; // its root continues something else: not the chain the ticket names
    const head = chain.at(-1)!;
    const earlier = chain.slice(0, -1);
    const out: ChainRepair = { ids: chain.map((r) => r.id), linked: 0, pinMoved: false, ticketsMoved: [] };

    chain.forEach((r, i) => {
      if (i === 0 || r.continued_from !== null) return;
      db.prepare('UPDATE chat_sessions SET continued_from = ? WHERE id = ?').run(chain[i - 1]!.id, r.id);
      out.linked++;
    });

    const pins = earlier.map((r) => r.pinned_at).filter((p): p is string => p !== null).sort();
    if (pins.length) {
      if (head.pinned_at === null) db.prepare('UPDATE chat_sessions SET pinned_at = ? WHERE id = ?').run(pins[0]!, head.id);
      for (const r of earlier) if (r.pinned_at !== null) db.prepare('UPDATE chat_sessions SET pinned_at = NULL WHERE id = ?').run(r.id);
      out.pinMoved = true;
    }

    const ticket = [...earlier].reverse().find((r) => r.ticket_id !== null)?.ticket_id ?? null;
    if (head.ticket_id === null && ticket !== null) db.prepare('UPDATE chat_sessions SET ticket_id = ? WHERE id = ?').run(ticket, head.id);

    for (const r of earlier) {
      if (r.state !== 'ended') continue;
      const held = db.prepare(`SELECT number FROM tickets WHERE assignee_kind = 'session' AND assignee_ref = ? ORDER BY number`).all(r.id) as { number: number }[];
      for (const { number } of held) {
        db.prepare('UPDATE tickets SET assignee_ref = ?, updated_at = ? WHERE number = ?').run(head.id, at, number);
        db.prepare('INSERT INTO ticket_events (ticket_number, at, kind, actor, actor_label, body, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          number,
          at,
          'assigned',
          'system',
          'Portal',
          null,
          JSON.stringify({ from: { kind: 'session', sessionId: r.id }, to: { kind: 'session', sessionId: head.id }, continued: true }),
        );
        out.ticketsMoved.push(`T-${number}`);
      }
    }
    done.push(out);
  }
  return done;
}

/** One session of a chain and what it cost. */
export interface LineageSegment {
  id: string;
  costUsd: number;
  state: string;
}

/** A session's whole chain, oldest first: its root, its head, every row with its cost, and the sum. */
export interface Lineage {
  rootId: string;
  headId: string;
  sessions: LineageSegment[];
  costUsd: number;
}

/**
 * The chain a session belongs to (`continued_from` back to the root, then forward to the head; when two rows continue the same one, the
 * newer). Bounded and cycle safe. Null when the session does not exist.
 */
export function lineageOf(db: DatabaseSync, sessionId: string): Lineage | null {
  const one = db.prepare('SELECT id, continued_from, cost_est_usd, state FROM chat_sessions WHERE id = ?');
  const next = db.prepare('SELECT id, continued_from, cost_est_usd, state FROM chat_sessions WHERE continued_from = ? ORDER BY created_at DESC, id DESC LIMIT 1');
  type Row = { id: string; continued_from: string | null; cost_est_usd: number; state: string };
  const start = one.get(sessionId) as Row | undefined;
  if (!start) return null;
  const seen = new Set<string>([start.id]);
  const back: Row[] = [];
  let cur: Row = start;
  while (cur.continued_from && back.length < 100) {
    const prev = one.get(cur.continued_from) as Row | undefined;
    if (!prev || seen.has(prev.id)) break;
    seen.add(prev.id);
    back.unshift(prev);
    cur = prev;
  }
  const rows: Row[] = [...back, start];
  cur = start;
  for (let hops = 0; hops < 100; hops++) {
    const after = next.get(cur.id) as Row | undefined;
    if (!after || seen.has(after.id)) break;
    seen.add(after.id);
    rows.push(after);
    cur = after;
  }
  const sessions = rows.map((r) => ({ id: r.id, costUsd: r.cost_est_usd, state: r.state }));
  return { rootId: rows[0]!.id, headId: rows.at(-1)!.id, sessions, costUsd: sessions.reduce((sum, s) => sum + s.costUsd, 0) };
}
