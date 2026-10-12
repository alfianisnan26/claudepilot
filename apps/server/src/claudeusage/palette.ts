// Claude usage: the colour each Claude and each model keeps, everywhere (docs/prd/claude-usage.md §20.6, round 4 principle P3). The server gives a
// stable palette slot, 0 to 7, on first sight and keeps it in `usage_palette`, so every page, device, legend, widget and dialog agree. The colours
// themselves (and the cue that is not colour) are the web's; here is only the slot.

import { USAGE_PALETTE_SLOTS, type PaletteKind, type PaletteSlot, type UsagePalette } from '@portal/contracts';
import type { Store } from '../store/store.js';

const DAY = 86_400_000;
/** A slot is taken from one that was not seen for this long when all eight are held: older than any report window (30 days) and its comparison. */
export const RECYCLE_AFTER_MS = 45 * DAY;
/** "Last seen" is refreshed at most this often per key (a read must not write every time). */
const TOUCH_EVERY_MS = 60 * 60_000;

export interface PaletteKey {
  key: string;
  /** When it was first seen in what the caller is showing (an older key gets the lower slot when several are new at once). */
  seenMs: number;
}

export class Palette {
  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The slot of each key of a kind. A key not seen before gets the lowest free slot, in the order of `seenMs` (then of the key); with all eight held,
   * the slot of the key not seen for 45 days; with none that old, null (the neutral grey, "Others"), which is not kept so the key can take a
   * slot that frees up. On a store that cannot be written the slots are worked out the same way and not kept.
   */
  slots(kind: PaletteKind, keys: PaletteKey[]): Map<string, PaletteSlot> {
    const out = new Map<string, PaletteSlot>();
    const db = this.store.db;
    const now = this.now();
    let rows: { key: string; slot: number; last_seen_ms: number }[] = [];
    try {
      rows = db ? (db.prepare('SELECT key, slot, last_seen_ms FROM usage_palette WHERE kind = ?').all(kind) as typeof rows) : [];
    } catch {
      rows = []; // a store without the table: slots are worked out and not kept
    }
    const held = new Map(rows.map((r) => [r.key, r]));
    const writable = !!db && this.store.writable;
    const taken = new Set(rows.map((r) => r.slot));
    const fresh = [...new Map(keys.map((k) => [k.key, k])).values()].filter((k) => !held.has(k.key)).sort((a, b) => a.seenMs - b.seenMs || (a.key < b.key ? -1 : 1));
    for (const k of keys) {
      const r = held.get(k.key);
      if (!r) continue;
      out.set(k.key, r.slot);
      if (writable && now - r.last_seen_ms > TOUCH_EVERY_MS) {
        try {
          db!.prepare('UPDATE usage_palette SET last_seen_ms = ? WHERE kind = ? AND key = ?').run(now, kind, k.key);
        } catch {
          // not kept
        }
      }
    }
    for (const k of fresh) {
      let slot = [...Array(USAGE_PALETTE_SLOTS).keys()].find((s) => !taken.has(s));
      let recycled: string | null = null;
      if (slot === undefined) {
        // All held: the one not seen the longest, if that is long enough ago that no report can show both.
        const stalest = [...held.values()].filter((r) => !keys.some((x) => x.key === r.key)).sort((a, b) => a.last_seen_ms - b.last_seen_ms)[0];
        if (stalest && now - stalest.last_seen_ms > RECYCLE_AFTER_MS) {
          slot = stalest.slot;
          recycled = stalest.key;
        }
      }
      if (slot === undefined) {
        out.set(k.key, null);
        continue;
      }
      out.set(k.key, slot);
      taken.add(slot);
      if (recycled) held.delete(recycled);
      held.set(k.key, { key: k.key, slot, last_seen_ms: now });
      if (!writable) continue;
      try {
        if (recycled) db!.prepare('DELETE FROM usage_palette WHERE kind = ? AND key = ?').run(kind, recycled);
        db!.prepare('INSERT INTO usage_palette (kind, key, slot, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?)').run(kind, k.key, slot, now, now);
      } catch {
        // not kept: the next read works it out again
      }
    }
    return out;
  }

  /** Every assignment, for a place that shows a Claude or a model without a report. */
  all(): UsagePalette {
    const out: UsagePalette = { slots: USAGE_PALETTE_SLOTS, claudes: {}, models: {} };
    const db = this.store.db;
    if (!db) return out;
    try {
      for (const r of db.prepare('SELECT kind, key, slot FROM usage_palette ORDER BY kind, slot').all() as { kind: string; key: string; slot: number }[]) {
        (r.kind === 'claude' ? out.claudes : out.models)[r.key] = r.slot;
      }
    } catch {
      // a store without the table: nothing assigned yet
    }
    return out;
  }
}
