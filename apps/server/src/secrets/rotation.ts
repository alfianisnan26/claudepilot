import { AppError, newId } from '@isnanme/core';
import {
  SECRET_LIMITS,
  type RotationState,
  type RotationWorkspace,
  type SecretEntryInput,
  type SecretRotateRequest,
  type SecretRotationView,
  type SecretsContent as SecretsContentView,
  type SecretVersionView,
} from '@portal/contracts';
import type { PoolService } from '../pools/service.js';
import type { Store } from '../store/store.js';
import { SecretsKind, type StoredEntry } from './kind.js';
import { exposureRef } from './values.js';

/**
 * Rotation, versions, revocation and the purge of old values (Secrets & env PRD FR16 to FR18, FR20).
 *
 * - **Rotate** adds the entry's next value version through the pool's ordinary save ("Rotated NAME"), so it is a
 *   revision like any other and reaches the workspaces that follow the set. **Urgent** also reaches the ones
 *   pinned to an older revision, at once: the old value is replaced by the new one wherever it would be delivered
 *   (`SecretsKind.effectiveValueId`), and every workspace is asked to deliver now.
 * - The **tracker** says, per workspace, whether the old value is still delivered there (the delivery engine's
 *   exposure records, which close when a file takes another value): `confirmed` when it is not, `pinned` when the
 *   workspace is held on an older revision, `failed` when delivery can't proceed, `pending` otherwise. When all are
 *   confirmed the old value is **safe to revoke** at its provider. That covers portal-delivered files only: not
 *   transcripts, shell history or other copies (FR20).
 * - **Revoking** a value here means it is never delivered, restored or pinned to again (the current value can't be
 *   revoked: rotate first). Its ciphertext is purged once no workspace holds it any more; an unused old value goes
 *   30 days after it was last in use.
 */

const DAY_MS = 86_400_000;
const PURGE_AFTER_DAYS = 30;
const NOTE_MAX = 200;
const VALUE_FIELD = 'value';

interface RotationRow {
  id: string;
  pool_id: string;
  entry_id: string;
  field: string;
  from_value_id: string | null;
  to_value_id: string;
  urgent: number;
  started_at: string;
  safe_at: string | null;
  note: string;
}

interface DeliveryStatusRow {
  status: string;
  reason: string | null;
}

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });

export class SecretRotations {
  constructor(
    private readonly store: Store,
    private readonly kind: SecretsKind,
    private readonly service: Pick<PoolService, 'get' | 'update' | 'redeliver' | 'typeOf'>,
  ) {}

  get #db() {
    const db = this.store.db;
    if (!db || !this.store.writable) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not writable.');
    return db;
  }

  #event(type: string, poolId: string | null, entryId: string | null, valueId: string | null, details: Record<string, unknown> = {}) {
    // Never a value: ids, versions, counts.
    this.#db.prepare('INSERT INTO secret_events (at, type, pool_id, entry_id, value_id, details) VALUES (?, ?, ?, ?, ?, ?)').run(new Date().toISOString(), type, poolId, entryId, valueId, JSON.stringify(details));
  }

  /** The pool's newest stored content and one of its secret entries, or NOT_FOUND. */
  #entry(poolId: string, entryId: string): StoredEntry {
    if (this.service.typeOf(poolId) !== 'secrets') throw new AppError('NOT_FOUND', 'That secret set no longer exists.');
    const entry = this.kind.latestContent(poolId)?.entries.find((e) => e.id === entryId && e.kind === 'secret');
    if (!entry) throw new AppError('NOT_FOUND', 'That secret is no longer in the set.');
    return entry;
  }

  /* ---------- Rotate ---------- */

  rotate(poolId: string, entryId: string, req: Partial<SecretRotateRequest>): SecretRotationView {
    const entry = this.#entry(poolId, entryId);
    if (typeof req.value !== 'string' || req.value.trim() === '') throw invalid('value', 'Enter the new value.');
    if (Buffer.byteLength(req.value, 'utf8') > SECRET_LIMITS.secretBytes) throw invalid('value', `Use at most ${SECRET_LIMITS.secretBytes / 1024} KB.`);
    const note = typeof req.note === 'string' ? req.note.trim().slice(0, NOTE_MAX) : '';
    const from = entry.values?.[VALUE_FIELD] ?? null;

    // The pool's content as the editor sends it back, with the one entry's new value. Everything else carries over by id.
    const view = this.service.get(poolId).content as SecretsContentView | null;
    const inputs: SecretEntryInput[] = (view?.entries ?? []).map((e): SecretEntryInput => {
      if (e.kind === 'variable') return { id: e.id, kind: 'variable', name: e.name, value: e.value ?? '', ...(e.confirmed ? { confirmed: true } : {}) };
      return {
        id: e.id,
        kind: 'secret',
        name: e.name,
        options: { ...e.options },
        ...(e.id === entryId ? { newValue: req.value, ...(req.expiresAt ? { newValueExpiresAt: req.expiresAt } : {}) } : {}),
      };
    });
    this.service.update(poolId, { content: { entries: inputs }, note: `Rotated ${entry.name}${note ? `: ${note}` : ''}` });

    const to = this.kind.latestContent(poolId)?.entries.find((e) => e.id === entryId)?.values?.[VALUE_FIELD];
    if (!to || to === from) throw new AppError('INTERNAL_ERROR', 'The new value was not stored.');
    const id = newId();
    this.#db
      .prepare('INSERT INTO secret_rotations (id, pool_id, entry_id, field, from_value_id, to_value_id, urgent, started_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, poolId, entryId, VALUE_FIELD, from, to, req.urgent === true ? 1 : 0, new Date().toISOString(), note);
    this.#event('rotated', poolId, entryId, to, { from: from ?? null, urgent: req.urgent === true });
    // Urgent: every workspace now, pinned ones included; they get the new value in place of the one their revision names.
    const reached = req.urgent === true ? this.service.redeliver(poolId, 'urgent rotation') : 0;
    void reached;
    return this.view(id);
  }

  /* ---------- The tracker ---------- */

  #workspaces(r: RotationRow): RotationWorkspace[] {
    const db = this.store.db!;
    const assigned = db.prepare('SELECT workspace_id, pinned_revision FROM assignments WHERE pool_id = ?').all(r.pool_id) as { workspace_id: string; pinned_revision: number | null }[];
    const holding = new Set(
      r.from_value_id ? (db.prepare('SELECT workspace_id FROM exposures WHERE secret_ref = ? AND removed_at IS NULL').all(exposureRef(r.from_value_id)) as { workspace_id: string }[]).map((x) => x.workspace_id) : [],
    );
    const ids = [...new Set([...assigned.map((a) => a.workspace_id), ...holding])].sort();
    return ids.map((workspaceId): RotationWorkspace => {
      const a = assigned.find((x) => x.workspace_id === workspaceId);
      // The old value isn't delivered there (any more): confirmed, whichever way it got that way.
      if (!holding.has(workspaceId)) return { workspaceId, state: 'confirmed', detail: null };
      if (!a) return { workspaceId, state: 'pending', detail: 'Being taken out of the workspace.' };
      if (a.pinned_revision !== null && !r.urgent) return { workspaceId, state: 'pinned', detail: `Pinned to r${a.pinned_revision}.` };
      const row = db.prepare('SELECT status, reason FROM workspace_delivery WHERE workspace_id = ?').get(workspaceId) as DeliveryStatusRow | undefined;
      if (row && ['failed', 'frozen', 'locked', 'unsupported'].includes(row.status)) return { workspaceId, state: 'failed', detail: row.reason ?? row.status };
      return { workspaceId, state: 'pending', detail: 'Waiting for delivery.' };
    });
  }

  view(id: string): SecretRotationView {
    const db = this.store.db;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not available.');
    const r = db.prepare('SELECT * FROM secret_rotations WHERE id = ?').get(id) as RotationRow | undefined;
    if (!r) throw new AppError('NOT_FOUND', 'No such rotation.');
    const workspaces = this.#workspaces(r);
    const counts: Record<RotationState, number> = { confirmed: 0, pending: 0, pinned: 0, failed: 0 };
    for (const w of workspaces) counts[w.state]++;
    let safeAt = r.safe_at;
    if (!safeAt && this.store.writable && workspaces.every((w) => w.state === 'confirmed')) {
      safeAt = new Date().toISOString();
      db.prepare('UPDATE secret_rotations SET safe_at = ? WHERE id = ? AND safe_at IS NULL').run(safeAt, id);
      this.#event('safe_to_revoke', r.pool_id, r.entry_id, r.from_value_id, { rotation: id });
    }
    const info = (valueId: string | null) => (valueId ? this.kind.values.row(valueId) : undefined);
    const entry = this.kind.latestContent(r.pool_id)?.entries.find((e) => e.id === r.entry_id);
    return {
      id: r.id,
      poolId: r.pool_id,
      entryId: r.entry_id,
      entryName: entry?.name ?? 'removed secret',
      fromVersion: info(r.from_value_id)?.version ?? null,
      toVersion: info(r.to_value_id)?.version ?? 0,
      urgent: !!r.urgent,
      startedAt: r.started_at,
      safeAt,
      note: r.note,
      fromRevoked: !!info(r.from_value_id)?.revoked_at,
      workspaces,
      counts,
    };
  }

  /** The pool's recent rotations, newest first, each with its tracker. */
  list(poolId: string, limit = 20): SecretRotationView[] {
    if (this.service.typeOf(poolId) !== 'secrets') throw new AppError('NOT_FOUND', 'That secret set no longer exists.');
    const rows = this.store.db!.prepare('SELECT id FROM secret_rotations WHERE pool_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?').all(poolId, Math.min(Math.max(limit, 1), 50)) as { id: string }[];
    return rows.map((r) => this.view(r.id));
  }

  /* ---------- Versions and revocation ---------- */

  /** An entry's value versions, newest first: what identifies each without showing it, and where it is. */
  versions(poolId: string, entryId: string): SecretVersionView[] {
    this.#entry(poolId, entryId);
    const db = this.store.db!;
    const currentId = this.kind.currentContent(poolId)?.entries.find((e) => e.id === entryId)?.values?.[VALUE_FIELD] ?? null;
    const pinnedRevisions = db.prepare('SELECT workspace_id, pinned_revision FROM assignments WHERE pool_id = ? AND pinned_revision IS NOT NULL').all(poolId) as { workspace_id: string; pinned_revision: number }[];
    const pinnedNames = new Map<string, string[]>();
    for (const p of pinnedRevisions) {
      const content = db.prepare('SELECT content FROM pool_revisions WHERE pool_id = ? AND revision = ?').get(poolId, p.pinned_revision) as { content: string } | undefined;
      const id = content ? (JSON.parse(content.content) as { entries: StoredEntry[] }).entries.find((e) => e.id === entryId)?.values?.[VALUE_FIELD] : null;
      if (id) pinnedNames.set(id, [...(pinnedNames.get(id) ?? []), p.workspace_id]);
    }
    return this.kind.values.versionsOf(poolId, entryId, VALUE_FIELD).map((v): SecretVersionView => ({
      id: v.id,
      version: v.version,
      hint: v.hint,
      fingerprint: v.fingerprint,
      length: v.byte_length,
      createdAt: v.created_at,
      expiresAt: v.expires_at ?? null,
      revokedAt: v.revoked_at ?? null,
      stored: v.ciphertext !== null,
      current: v.id === currentId,
      pinned: (pinnedNames.get(v.id) ?? []).sort(),
      workspaces: (db.prepare('SELECT workspace_id FROM exposures WHERE secret_ref = ? AND removed_at IS NULL ORDER BY workspace_id').all(exposureRef(v.id)) as { workspace_id: string }[]).map((x) => x.workspace_id),
    }));
  }

  /**
   * Revokes a value version (FR16, FR18): it is never delivered, restored or pinned to again, and workspaces that
   * still named it get the entry's current value instead. The current value can't be revoked: rotate it first.
   */
  revoke(poolId: string, valueId: string, reason?: unknown): SecretVersionView {
    const row = this.kind.values.row(valueId);
    if (!row || !this.kind.values.belongsTo(valueId, poolId)) throw new AppError('NOT_FOUND', 'That value no longer exists.');
    const entry = this.#entry(poolId, row.entry_id);
    const current = this.kind.currentContent(poolId)?.entries.find((e) => e.id === row.entry_id)?.values?.[VALUE_FIELD];
    if (valueId === current || valueId === entry.values?.[VALUE_FIELD])
      throw new AppError('CONFLICT', 'This is the value in use. Rotate it first, then revoke the old one.');
    const changed = this.kind.values.revoke(valueId);
    if (changed) {
      const why = typeof reason === 'string' ? reason.trim().slice(0, NOTE_MAX) : '';
      this.#event('revoked', poolId, row.entry_id, valueId, { version: row.version, ...(why ? { reason: why } : {}) });
      // Workspaces pinned to a revision that names it get the current value now.
      this.service.redeliver(poolId, 'secret value revoked');
    }
    return this.versions(poolId, row.entry_id).find((v) => v.id === valueId)!;
  }

  /* ---------- Maintenance ---------- */

  #timer: NodeJS.Timeout | undefined;

  /** The sweep a few minutes after start and then daily; never throws, and only while the portal may work (foundation §6.5). */
  start(): void {
    const run = () => {
      try {
        if (!this.store.writable || !this.store.deliveryAllowed) return;
        const r = this.sweep();
        if (r.purged || r.warned) console.log(`[secrets] swept: ${r.purged} value(s) purged, ${r.warned} expiry warning(s)`);
      } catch (e) {
        console.error(`[secrets] the sweep failed: ${(e as Error).message}`);
      }
    };
    const first = setTimeout(() => {
      run();
      this.#timer = setInterval(run, DAY_MS);
      this.#timer.unref();
    }, 5 * 60_000);
    first.unref();
    this.#timer = first;
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Purges ciphertext nobody needs (FR18) and records expiry warnings (FR8): a revoked value once no workspace holds
   * it, a value of a deleted set once none does, and an old value 30 days after it was last in use. Daily, and safe
   * to run whenever: it only ever clears values that nothing delivers.
   */
  sweep(now = new Date()): { purged: number; warned: number } {
    const db = this.store.db;
    if (!db || !this.store.writable) return { purged: 0, warned: 0 };
    let purged = 0;
    let warned = 0;
    const rows = db.prepare('SELECT id, pool_id, entry_id, revoked_at, created_at, expires_at FROM secret_values WHERE ciphertext IS NOT NULL').all() as {
      id: string;
      pool_id: string;
      entry_id: string;
      revoked_at: string | null;
      created_at: string;
      expires_at: string | null;
    }[];
    for (const v of rows) {
      const live = db.prepare('SELECT count(*) AS n FROM exposures WHERE secret_ref = ? AND removed_at IS NULL').get(exposureRef(v.id)) as { n: number };
      if (Number(live.n) > 0) continue;
      const closed = db.prepare('SELECT max(removed_at) AS last FROM exposures WHERE secret_ref = ?').get(exposureRef(v.id)) as { last: string | null };
      const pool = db.prepare('SELECT 1 AS x FROM pools WHERE id = ?').get(v.pool_id);
      const inUse =
        !!pool &&
        !!db
          .prepare(
            `SELECT 1 AS x FROM pool_revisions r WHERE r.pool_id = ? AND r.content LIKE ? AND (
               r.revision = (SELECT current_revision FROM pools WHERE id = r.pool_id)
               OR r.revision = (SELECT max(revision) FROM pool_revisions WHERE pool_id = r.pool_id)
               OR r.revision IN (SELECT pinned_revision FROM assignments WHERE pool_id = r.pool_id AND pinned_revision IS NOT NULL)) LIMIT 1`,
          )
          .get(v.pool_id, `%"${v.id}"%`);
      const lastUse = new Date(closed.last ?? v.created_at).getTime();
      const idle = now.getTime() - lastUse >= PURGE_AFTER_DAYS * DAY_MS;
      // A revoked value or one of a deleted set is never delivered, so nothing holding it means nothing needs it; an old
      // one is kept for the window in case a pin or a roll back wants it.
      if (v.revoked_at || !pool || (!inUse && idle)) {
        if (this.kind.values.purge(v.id, now)) {
          purged++;
          this.#event('purged', v.pool_id, v.entry_id, v.id, { reason: v.revoked_at ? 'revoked' : !pool ? 'set deleted' : 'unused' });
        }
      }
    }
    // Expiry (FR8): warned at 14 and 3 days, and when it has passed, once each.
    const expiring = db.prepare("SELECT id, pool_id, entry_id, expires_at FROM secret_values WHERE ciphertext IS NOT NULL AND revoked_at IS NULL AND expires_at IS NOT NULL").all() as {
      id: string;
      pool_id: string;
      entry_id: string;
      expires_at: string;
    }[];
    for (const v of expiring) {
      const days = (new Date(v.expires_at).getTime() - now.getTime()) / DAY_MS;
      const type = days <= 0 ? 'expired' : days <= 3 ? 'expiry_3' : days <= 14 ? 'expiry_14' : null;
      if (!type) continue;
      if (db.prepare('SELECT 1 AS x FROM secret_events WHERE value_id = ? AND type = ?').get(v.id, type)) continue;
      this.#event(type, v.pool_id, v.entry_id, v.id, { expiresAt: v.expires_at });
      warned++;
    }
    return { purged, warned };
  }
}
