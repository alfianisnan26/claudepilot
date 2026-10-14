// T-277 layer 4: how many of the portal's own control requests each chat is still waiting on (asked, no answer read yet), READ ONLY.
// The deploy pipeline's release step waits a bounded time while one is open, so a portal restart does not land between a request and its
// answer. It reads the `chat_inputs` rows the controller keeps for its control lines (`req/<id>`, state `sending` until the answer is read)
// and never writes; the controller and its store stay the only writers.
import type { DatabaseSync } from 'node:sqlite';

/** The key prefix of a control request the portal asked (the controller's `ASKED`); answers it gives are `ans/<id>`. */
export const ASKED_PREFIX = 'req/';

/**
 * Only requests younger than this count: the controller gives up on an answer after 15 s (`CONTROL_TIMEOUT_MS`), and a row a crashed process
 * left in `sending` must not hold a release forever.
 */
export const PENDING_CONTROL_FRESH_MS = 60_000;

/** Ids per query (SQLite's parameter limit is far above; a deploy rarely sees more than a few dozen live chats). */
const CHUNK = 200;

/**
 * Per session id, the control requests still open (asked within `freshMs`, no answer read). Sessions with none are left out. Null when the
 * portal can not tell (no database, or the table is not what this expects): the caller then says "unknown" and does not wait.
 */
export function pendingControlRequests(db: DatabaseSync | null, sessionIds: readonly string[], now: Date = new Date(), freshMs = PENDING_CONTROL_FRESH_MS): Map<string, number> | null {
  if (!db) return null;
  const out = new Map<string, number>();
  if (!sessionIds.length) return out;
  const since = new Date(now.getTime() - freshMs).toISOString();
  try {
    for (let i = 0; i < sessionIds.length; i += CHUNK) {
      const ids = sessionIds.slice(i, i + CHUNK);
      const rows = db
        .prepare(
          `SELECT session_id AS id, count(*) AS n FROM chat_inputs
           WHERE session_id IN (${ids.map(() => '?').join(', ')}) AND kind = 'control' AND state = 'sending' AND substr(uuid, 1, ${ASKED_PREFIX.length}) = ? AND created_at >= ?
           GROUP BY session_id`,
        )
        .all(...ids, ASKED_PREFIX, since) as { id: string; n: number }[];
      for (const r of rows) out.set(r.id, Number(r.n));
    }
    return out;
  } catch {
    return null;
  }
}
