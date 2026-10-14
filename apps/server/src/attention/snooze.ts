// Needs you, Later (docs/prd/attention.md, T-146 slice 2): a person puts an item off for a while (the deck's swipe left). The registry
// keeps no item rows, so a snooze is the person's own row (migration 860): it hides the item from that person's deck until `until`, and
// nothing else. The item still waits, is still counted and still listed (marked), and is back in the deck by itself once the time is up.

import type { DatabaseSync } from 'node:sqlite';
import type { AttentionKind } from '@portal/contracts';

export interface AttentionSnoozes {
  /** The person's snoozes that still hold at `now`: `<kind>:<id>` to until (ISO). */
  active(userId: string, now: number): Map<string, string>;
  /** Puts one item off until `until` (ISO), or clears it (null). Also drops the person's snoozes that have run out. */
  set(userId: string, kind: AttentionKind, id: string, until: string | null, now: number): void;
}

export function attentionSnoozes(db: () => DatabaseSync | null | undefined): AttentionSnoozes {
  return {
    active(userId, now) {
      const d = db();
      if (!d) return new Map();
      const rows = d.prepare('SELECT kind, item_id, until FROM attention_snoozes WHERE user_id = ? AND until > ?').all(userId, new Date(now).toISOString()) as {
        kind: string;
        item_id: string;
        until: string;
      }[];
      return new Map(rows.map((r) => [`${r.kind}:${r.item_id}`, r.until]));
    },
    set(userId, kind, id, until, now) {
      const d = db();
      if (!d) throw new Error('the database is not open');
      d.prepare('DELETE FROM attention_snoozes WHERE user_id = ? AND until <= ?').run(userId, new Date(now).toISOString());
      if (until === null) d.prepare('DELETE FROM attention_snoozes WHERE user_id = ? AND kind = ? AND item_id = ?').run(userId, kind, id);
      else
        d.prepare(
          'INSERT INTO attention_snoozes (user_id, kind, item_id, until, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, kind, item_id) DO UPDATE SET until = excluded.until',
        ).run(userId, kind, id, until, new Date(now).toISOString());
    },
  };
}
