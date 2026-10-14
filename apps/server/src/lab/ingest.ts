// Efficiency lab (T-287): reads each line of a chat's stream (the same lines the chat controller accepted) and keeps per request and per
// tool call the counts the slice metrics need. Never text: a command or prompt is classified and dropped, a result is measured and dropped,
// and only values that look like ids are stored (classify.ts). A replayed line changes nothing: rows are keyed by the message and the
// tool_use id, and a request's last report wins (as in the reference script).

import type { DatabaseSync } from 'node:sqlite';
import { codePoints, RTK, safeId, safeName, ticketOf, toolClass } from './classify.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Called when a sub-agent slice starts (its Agent call was seen): experiments assign it an arm then. */
export type SliceStart = (info: { sessionId: string; sliceId: string; role: string | null; model: string | null; atMs: number }) => void;

export class LabIngest {
  /** The main-thread turn each session is in (`turn:<n>`); a `result` line ends it. Read back from the store after a restart. */
  readonly #turns = new Map<string, number>();

  constructor(
    private readonly db: () => DatabaseSync | null,
    private readonly now: () => number = Date.now,
    private readonly onSliceStart?: SliceStart,
  ) {}

  /** One raw stream line of a session. Lines that are not assistant, user or result lines are skipped before parsing. */
  line(sessionId: string, raw: string): void {
    if (!raw.includes('"type":"assistant"') && !raw.includes('"type":"user"') && !raw.includes('"type":"result"')) return;
    const db = this.db();
    if (!db) return;
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isObj(o)) return;
    const par = o.parent_tool_use_id == null ? null : safeId(o.parent_tool_use_id);
    if (o.parent_tool_use_id != null && par === null) return; // a parent that is not an id: nothing to key it by
    const atParsed = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    const atMs = Number.isFinite(atParsed) ? atParsed : this.now();
    if (o.type === 'result') {
      if (par === null) this.#turns.set(sessionId, this.#turn(db, sessionId) + 1);
      return;
    }
    const m = isObj(o.message) ? o.message : {};
    const content = m.content;
    if (o.type === 'assistant') this.#assistant(db, sessionId, par, m, atMs);
    else if (o.type === 'user' && Array.isArray(content)) this.#user(db, sessionId, par, content);
  }

  #turn(db: DatabaseSync, sessionId: string): number {
    let n = this.#turns.get(sessionId);
    if (n === undefined) {
      const row = db.prepare("SELECT MAX(CAST(substr(slice_id, 6) AS INTEGER)) AS n FROM lab_slices WHERE session_id = ? AND kind = 'turn'").get(sessionId) as { n: number | null } | undefined;
      n = row?.n ?? 1;
      this.#turns.set(sessionId, n);
    }
    return n;
  }

  #slice(db: DatabaseSync, sessionId: string, par: string | null): string {
    if (par !== null) {
      db.prepare("INSERT INTO lab_slices (session_id, slice_id, kind) VALUES (?, ?, 'agent') ON CONFLICT DO NOTHING").run(sessionId, par);
      return par;
    }
    const id = `turn:${this.#turn(db, sessionId)}`;
    db.prepare("INSERT INTO lab_slices (session_id, slice_id, kind) VALUES (?, ?, 'turn') ON CONFLICT DO NOTHING").run(sessionId, id);
    return id;
  }

  #assistant(db: DatabaseSync, sessionId: string, par: string | null, m: Obj, atMs: number): void {
    const model = typeof m.model === 'string' ? m.model : '';
    if (!model || model === '<synthetic>') return; // the script's rule: no model, or Claude Code's own message, is not a request
    const slice = this.#slice(db, sessionId, par);
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (!isObj(b) || b.type !== 'tool_use') continue;
      const id = safeId(b.id);
      const name = safeName(b.name);
      if (!id || !name) continue;
      const input = isObj(b.input) ? b.input : {};
      if (name === 'Agent' || name === 'Task') {
        const role = safeName(input.subagent_type);
        db.prepare(
          `INSERT INTO lab_slices (session_id, slice_id, kind, ticket, role, started_ms) VALUES (?, ?, 'agent', ?, ?, ?)
           ON CONFLICT DO UPDATE SET ticket = excluded.ticket, role = excluded.role, started_ms = COALESCE(lab_slices.started_ms, excluded.started_ms)`,
        ).run(sessionId, id, ticketOf(input), role, atMs);
        try {
          this.onSliceStart?.({ sessionId, sliceId: id, role, model: safeName(input.model), atMs });
        } catch {
          // an experiment that cannot assign never stops the ingest
        }
      }
      const rtk = name === 'Bash' && typeof input.command === 'string' && RTK.test(input.command) ? 1 : 0;
      db.prepare(
        `INSERT INTO lab_tools (session_id, tool_use_id, slice_id, tool, class, rtk, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET tool = excluded.tool, class = excluded.class, rtk = excluded.rtk, at_ms = excluded.at_ms,
           slice_id = COALESCE(lab_tools.slice_id, excluded.slice_id)`,
      ).run(sessionId, id, slice, name, toolClass(name, input), rtk, atMs);
    }
    const mid = safeId(m.id);
    if (!mid) return;
    const u = isObj(m.usage) ? m.usage : {};
    const cc = isObj(u.cache_creation) ? u.cache_creation : {};
    const cw1 = num(cc.ephemeral_1h_input_tokens);
    let cw5 = num(cc.ephemeral_5m_input_tokens);
    const cwall = num(u.cache_creation_input_tokens);
    if (cw1 + cw5 === 0) cw5 = cwall;
    db.prepare('UPDATE lab_slices SET model = ? WHERE session_id = ? AND slice_id = ?').run(safeId(model), sessionId, slice);
    db.prepare(
      `INSERT INTO lab_requests (session_id, message_id, slice_id, at_ms, model, input, cache_read, cache_write_5m, cache_write_1h, cache_write, output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET at_ms = excluded.at_ms, model = excluded.model, input = excluded.input, cache_read = excluded.cache_read,
         cache_write_5m = excluded.cache_write_5m, cache_write_1h = excluded.cache_write_1h, cache_write = excluded.cache_write, output = excluded.output`,
    ).run(sessionId, mid, slice, atMs, safeId(model), num(u.input_tokens), num(u.cache_read_input_tokens), cw5, cw1, cwall, num(u.output_tokens));
  }

  #user(db: DatabaseSync, sessionId: string, par: string | null, content: unknown[]): void {
    let slice: string | null = null;
    for (const b of content) {
      if (!isObj(b) || b.type !== 'tool_result') continue;
      const id = safeId(b.tool_use_id);
      if (!id) continue;
      const c = b.content;
      const n = typeof c === 'string' ? codePoints(c) : Array.isArray(c) ? c.reduce<number>((s, x) => s + (isObj(x) && typeof x.text === 'string' ? codePoints(x.text) : 0), 0) : 0;
      slice ??= this.#slice(db, sessionId, par);
      db.prepare(
        `INSERT INTO lab_tools (session_id, tool_use_id, slice_id, results, result_chars) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT DO UPDATE SET results = 1, result_chars = excluded.result_chars`,
      ).run(sessionId, id, slice, n);
    }
  }
}
