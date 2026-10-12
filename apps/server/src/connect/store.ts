// Connect's SQL (docs/prd/targets-connect.md §14): every statement the registry runs, in one place, returning typed rows. The tables hold hashes
// and public keys only (no sealed columns). Reads work whenever the database opens; a write needs a store that is writable and trusted (not
// Locked, not Frozen, PRD FR19): otherwise it throws 503 `store_locked` and the caller decides whether that matters (the hub skips `last_seen`).

import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import {
  CONNECT_KINDS,
  CONNECT_LIMITS,
  CONNECT_PLATFORMS,
  type ConnectEventType,
  type ConnectInstallOptions,
  type ConnectKind,
  type ConnectPlatform,
  type ConnectTargetSettings,
  type Workspace,
} from '@portal/contracts';
import type { Store } from '../store/store.js';

export interface TargetRow {
  id: string;
  label: string;
  kind: ConnectKind;
  state: 'pending' | 'active';
  portalUrl: string;
  settings: ConnectTargetSettings;
  snapshot: Workspace[] | null;
  snapshotAt: string | null;
  ownerId: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

/** The part of a node's last hello and status the registry keeps (agent text: cleaned, clipped and redacted before it gets here). */
export interface NodeSummary {
  hostname?: string;
  mode?: ConnectKind;
  runtime?: 'host' | 'container' | 'pod';
  services?: { name: 'docker' | 'kube' | 'host'; ok: boolean; error?: string; version?: string }[];
  clockSkewS?: number | null;
  swarm?: { nodeId: string; role: 'manager' | 'worker' };
  /** Why the agent last said goodbye (`bye`): `uninstall` tells a person it is gone for good. */
  bye?: string;
  /** Docker engine version and workspace count, for the target's one line. */
  engine?: string;
  containers?: number;
}

export interface NodeRow {
  id: string;
  targetId: string;
  enrollmentId: string | null;
  name: string;
  publicKey: string;
  keyFingerprint: string;
  prevPublicKey: string | null;
  rotatedAt: string | null;
  drained: boolean;
  info: NodeSummary;
  agentVersion: string | null;
  agentBuild: string | null;
  protocol: number | null;
  os: string | null;
  arch: string | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
  lastIp: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
  createdBy: string;
}

export interface EnrollmentRow {
  id: string;
  targetId: string;
  tokenHash: string;
  last4: string;
  platform: ConnectPlatform;
  params: ConnectInstallOptions;
  maxUses: number;
  uses: number;
  expiresAt: string;
  createdAt: string;
  createdBy: string;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface EventRow {
  id: number;
  at: string;
  type: ConnectEventType;
  targetId: string | null;
  nodeId: string | null;
  enrollmentId: string | null;
  actor: string;
  ip: string | null;
  detail: Record<string, string | number | boolean | null>;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v ?? '');
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function json<T>(v: unknown, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(str(v));
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

const targetOf = (r: Row): TargetRow => ({
  id: str(r.id),
  label: str(r.label),
  kind: (CONNECT_KINDS as readonly string[]).includes(str(r.kind)) ? (str(r.kind) as ConnectKind) : 'docker',
  state: r.state === 'active' ? 'active' : 'pending',
  portalUrl: str(r.portal_url),
  settings: json<ConnectTargetSettings>(r.settings, {}),
  snapshot: r.snapshot ? json<Workspace[] | null>(r.snapshot, null) : null,
  snapshotAt: strOrNull(r.snapshot_at),
  ownerId: str(r.owner_id),
  createdAt: str(r.created_at),
  createdBy: str(r.created_by),
  updatedAt: str(r.updated_at),
});

const nodeOf = (r: Row): NodeRow => ({
  id: str(r.id),
  targetId: str(r.target_id),
  enrollmentId: strOrNull(r.enrollment_id),
  name: str(r.name),
  publicKey: str(r.public_key),
  keyFingerprint: str(r.key_fingerprint),
  prevPublicKey: strOrNull(r.prev_public_key),
  rotatedAt: strOrNull(r.rotated_at),
  drained: Number(r.drained) === 1,
  info: json<NodeSummary>(r.info, {}),
  agentVersion: strOrNull(r.agent_version),
  agentBuild: strOrNull(r.agent_build),
  protocol: numOrNull(r.protocol),
  os: strOrNull(r.os),
  arch: strOrNull(r.arch),
  firstSeenAt: str(r.first_seen_at),
  lastSeenAt: strOrNull(r.last_seen_at),
  lastIp: strOrNull(r.last_ip),
  revokedAt: strOrNull(r.revoked_at),
  revokedReason: strOrNull(r.revoked_reason),
  createdAt: str(r.created_at),
  createdBy: str(r.created_by),
});

const enrollmentOf = (r: Row): EnrollmentRow => ({
  id: str(r.id),
  targetId: str(r.target_id),
  tokenHash: str(r.token_hash),
  last4: str(r.last4),
  platform: (CONNECT_PLATFORMS as readonly string[]).includes(str(r.platform)) ? (str(r.platform) as ConnectPlatform) : 'linux',
  params: json<ConnectInstallOptions>(r.params, {}),
  maxUses: Number(r.max_uses),
  uses: Number(r.uses),
  expiresAt: str(r.expires_at),
  createdAt: str(r.created_at),
  createdBy: str(r.created_by),
  firstUsedAt: strOrNull(r.first_used_at),
  lastUsedAt: strOrNull(r.last_used_at),
  revokedAt: strOrNull(r.revoked_at),
});

const eventOf = (r: Row): EventRow => ({
  id: Number(r.id),
  at: str(r.at),
  type: str(r.type) as ConnectEventType,
  targetId: strOrNull(r.target_id),
  nodeId: strOrNull(r.node_id),
  enrollmentId: strOrNull(r.enrollment_id),
  actor: str(r.actor),
  ip: strOrNull(r.ip),
  detail: json<EventRow['detail']>(r.detail, {}),
});

/** A partial update of a node's row: only the fields present are written. */
export type NodePatch = Partial<{
  name: string;
  publicKey: string;
  keyFingerprint: string;
  prevPublicKey: string | null;
  rotatedAt: string | null;
  drained: boolean;
  info: NodeSummary;
  agentVersion: string | null;
  agentBuild: string | null;
  protocol: number | null;
  os: string | null;
  arch: string | null;
  lastSeenAt: string | null;
  lastIp: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}>;

const NODE_COLUMNS: Record<keyof NodePatch, string> = {
  name: 'name',
  publicKey: 'public_key',
  keyFingerprint: 'key_fingerprint',
  prevPublicKey: 'prev_public_key',
  rotatedAt: 'rotated_at',
  drained: 'drained',
  info: 'info',
  agentVersion: 'agent_version',
  agentBuild: 'agent_build',
  protocol: 'protocol',
  os: 'os',
  arch: 'arch',
  lastSeenAt: 'last_seen_at',
  lastIp: 'last_ip',
  revokedAt: 'revoked_at',
  revokedReason: 'revoked_reason',
};

export class ConnectStore {
  #inTx = false;
  #eventInserts = 0;

  constructor(private readonly store: Store) {}

  /** The database for reading, or null when it cannot be opened at all. */
  get db(): DatabaseSync | null {
    return this.store.db;
  }

  /** Whether a write would be accepted: the database is writable and the portal trusts it (not Locked, not Frozen). */
  get canWrite(): boolean {
    return this.store.writable && this.store.deliveryAllowed;
  }

  /** The error every refused write answers with (PRD FR19). */
  storeLocked(): AppError {
    // exposed on purpose: the 503's words and its reason are what an installer and the admin read (a 5xx hides its message unless told not to)
    return new AppError('SERVICE_UNAVAILABLE', 'The portal’s store is locked or read only right now, so targets can’t be changed. Try again once it is back.', { details: { reason: 'store_locked' }, expose: true });
  }

  #write(): DatabaseSync {
    const db = this.store.db;
    if (!db || !this.canWrite) throw this.storeLocked();
    return db;
  }

  #read(): DatabaseSync | null {
    return this.store.db;
  }

  #all(sql: string, ...params: (string | number | null)[]): Row[] {
    const db = this.#read();
    if (!db) return [];
    return db.prepare(sql).all(...params) as Row[];
  }

  #one(sql: string, ...params: (string | number | null)[]): Row | null {
    const db = this.#read();
    if (!db) return null;
    return (db.prepare(sql).get(...params) as Row | undefined) ?? null;
  }

  /** Runs `fn` in one immediate transaction (a second concurrent writer would wait for the lock). Not reentrant: a nested call joins the outer one. */
  tx<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.#write();
    if (this.#inTx) return fn(db);
    db.exec('BEGIN IMMEDIATE');
    this.#inTx = true;
    try {
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // the transaction was already rolled back by SQLite
      }
      throw e;
    } finally {
      this.#inTx = false;
    }
  }

  // ---- targets -------------------------------------------------------------------------------------------------------------------

  targets(): TargetRow[] {
    return this.#all('SELECT * FROM connect_targets ORDER BY created_at, id').map(targetOf);
  }

  target(id: string): TargetRow | null {
    const r = this.#one('SELECT * FROM connect_targets WHERE id = ?', id);
    return r ? targetOf(r) : null;
  }

  targetByLabel(label: string): TargetRow | null {
    const r = this.#one('SELECT * FROM connect_targets WHERE label = ? COLLATE NOCASE', label);
    return r ? targetOf(r) : null;
  }

  insertTarget(t: Omit<TargetRow, 'snapshot' | 'snapshotAt' | 'updatedAt'>): void {
    this.#write()
      .prepare(
        `INSERT INTO connect_targets (id, label, kind, state, portal_url, settings, owner_id, created_at, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.id, t.label, t.kind, t.state, t.portalUrl, JSON.stringify(t.settings), t.ownerId, t.createdAt, t.createdBy, t.createdAt);
  }

  updateTarget(id: string, patch: Partial<Pick<TargetRow, 'label' | 'state' | 'settings'>>, at: string): void {
    const sets: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [at];
    if (patch.label !== undefined) (sets.push('label = ?'), params.push(patch.label));
    if (patch.state !== undefined) (sets.push('state = ?'), params.push(patch.state));
    if (patch.settings !== undefined) (sets.push('settings = ?'), params.push(JSON.stringify(patch.settings)));
    this.#write().prepare(`UPDATE connect_targets SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }

  deleteTarget(id: string): void {
    this.#write().prepare('DELETE FROM connect_targets WHERE id = ?').run(id);
  }

  saveSnapshot(id: string, workspaces: Workspace[], at: string): void {
    const db = this.store.db;
    if (!db || !this.canWrite) return; // a snapshot is a cache of what the runtime said: skipped while the store is read only
    db.prepare('UPDATE connect_targets SET snapshot = ?, snapshot_at = ? WHERE id = ?').run(JSON.stringify(workspaces), at, id);
  }

  /** Pending targets nobody enrolled whose last token ran out `hours` ago (or that were made that long ago with none). */
  stalePendingTargets(cutoffIso: string): string[] {
    return this.#all(
      `SELECT t.id FROM connect_targets t
       WHERE t.state = 'pending'
         AND NOT EXISTS (SELECT 1 FROM connect_nodes n WHERE n.target_id = t.id)
         AND COALESCE((SELECT MAX(e.expires_at) FROM connect_enrollments e WHERE e.target_id = t.id), t.created_at) < ?`,
      cutoffIso,
    ).map((r) => str(r.id));
  }

  // ---- nodes ---------------------------------------------------------------------------------------------------------------------

  nodes(targetId?: string): NodeRow[] {
    const rows = targetId
      ? this.#all('SELECT * FROM connect_nodes WHERE target_id = ? ORDER BY created_at, id', targetId)
      : this.#all('SELECT * FROM connect_nodes ORDER BY created_at, id');
    return rows.map(nodeOf);
  }

  node(id: string): NodeRow | null {
    const r = this.#one('SELECT * FROM connect_nodes WHERE id = ?', id);
    return r ? nodeOf(r) : null;
  }

  nodesOfEnrollment(enrollmentId: string): NodeRow[] {
    return this.#all('SELECT * FROM connect_nodes WHERE enrollment_id = ? ORDER BY created_at DESC, id', enrollmentId).map(nodeOf);
  }

  /** A node name not used by another live node of the target: `name`, then `name-2`, `name-3`, ... (null after 200 tries). */
  freeNodeName(targetId: string, name: string): string | null {
    const taken = new Set(this.#all('SELECT name FROM connect_nodes WHERE target_id = ? AND revoked_at IS NULL', targetId).map((r) => str(r.name).toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; i < 200; i++) if (!taken.has(`${name}-${i}`.toLowerCase())) return `${name}-${i}`;
    return null;
  }

  insertNode(n: Omit<NodeRow, 'info' | 'prevPublicKey' | 'rotatedAt' | 'drained' | 'lastSeenAt' | 'lastIp' | 'revokedAt' | 'revokedReason'> & { info?: NodeSummary }): void {
    this.#write()
      .prepare(
        `INSERT INTO connect_nodes (id, target_id, enrollment_id, name, public_key, key_fingerprint, info, agent_version, agent_build, protocol, os, arch, first_seen_at, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(n.id, n.targetId, n.enrollmentId, n.name, n.publicKey, n.keyFingerprint, JSON.stringify(n.info ?? {}), n.agentVersion, n.agentBuild, n.protocol, n.os, n.arch, n.firstSeenAt, n.createdAt, n.createdBy);
  }

  updateNode(id: string, patch: NodePatch): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof NodePatch, unknown][]) {
      if (value === undefined) continue;
      sets.push(`${NODE_COLUMNS[key]} = ?`);
      params.push(key === 'info' ? JSON.stringify(value) : key === 'drained' ? (value ? 1 : 0) : (value as string | number | null));
    }
    if (!sets.length) return;
    this.#write().prepare(`UPDATE connect_nodes SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }

  /** The `last_seen` write: skipped, not refused, while the store is read only. Returns whether it was written. */
  touchNode(id: string, at: string, ip: string | null, info?: NodeSummary): boolean {
    const db = this.store.db;
    if (!db || !this.canWrite) return false;
    if (info) db.prepare('UPDATE connect_nodes SET last_seen_at = ?, last_ip = COALESCE(?, last_ip), info = ? WHERE id = ?').run(at, ip, JSON.stringify(info), id);
    else db.prepare('UPDATE connect_nodes SET last_seen_at = ?, last_ip = COALESCE(?, last_ip) WHERE id = ?').run(at, ip, id);
    return true;
  }

  /** Nodes that were seen at least once and are not revoked: the ones a restarted portal waits for (`settled`). */
  nodesSeenBefore(): NodeRow[] {
    return this.#all('SELECT * FROM connect_nodes WHERE revoked_at IS NULL AND last_seen_at IS NOT NULL').map(nodeOf);
  }

  // ---- enrollments ---------------------------------------------------------------------------------------------------------------

  enrollments(targetId: string): EnrollmentRow[] {
    return this.#all('SELECT * FROM connect_enrollments WHERE target_id = ? ORDER BY created_at DESC, id DESC', targetId).map(enrollmentOf);
  }

  enrollment(id: string): EnrollmentRow | null {
    const r = this.#one('SELECT * FROM connect_enrollments WHERE id = ?', id);
    return r ? enrollmentOf(r) : null;
  }

  enrollmentByHash(hash: string): EnrollmentRow | null {
    const r = this.#one('SELECT * FROM connect_enrollments WHERE token_hash = ?', hash);
    return r ? enrollmentOf(r) : null;
  }

  insertEnrollment(e: Omit<EnrollmentRow, 'uses' | 'firstUsedAt' | 'lastUsedAt' | 'revokedAt'>): void {
    this.#write()
      .prepare(
        `INSERT INTO connect_enrollments (id, target_id, token_hash, last4, platform, params, max_uses, expires_at, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.id, e.targetId, e.tokenHash, e.last4, e.platform, JSON.stringify(e.params), e.maxUses, e.expiresAt, e.createdAt, e.createdBy);
  }

  /** Adds one use if the token is still good: the guard is in the statement, so two enrolls racing for the last use cannot both win. */
  useEnrollment(id: string, nowIso: string): boolean {
    const r = this.#write()
      .prepare(
        `UPDATE connect_enrollments
         SET uses = uses + 1, last_used_at = ?, first_used_at = COALESCE(first_used_at, ?)
         WHERE id = ? AND uses < max_uses AND revoked_at IS NULL AND expires_at > ?`,
      )
      .run(nowIso, nowIso, id, nowIso);
    return Number(r.changes) === 1;
  }

  revokeEnrollment(id: string, nowIso: string): boolean {
    const r = this.#write().prepare('UPDATE connect_enrollments SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso, id);
    return Number(r.changes) === 1;
  }

  // ---- events --------------------------------------------------------------------------------------------------------------------

  insertEvent(e: Omit<EventRow, 'id'>): boolean {
    const db = this.store.db;
    if (!db || !this.canWrite) return false;
    db.prepare('INSERT INTO connect_events (at, type, target_id, node_id, enrollment_id, actor, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      e.at,
      e.type,
      e.targetId,
      e.nodeId,
      e.enrollmentId,
      e.actor,
      e.ip,
      JSON.stringify(e.detail),
    );
    // keep the newest `eventsKeep` per target, checked now and then rather than on every row
    if (++this.#eventInserts % 50 === 0) this.pruneEvents(e.targetId);
    return true;
  }

  /** Deletes everything past the newest `eventsKeep` rows of one target (or of the rows that name no target). */
  pruneEvents(targetId: string | null): void {
    const db = this.store.db;
    if (!db || !this.canWrite) return;
    const keep = CONNECT_LIMITS.eventsKeep;
    if (targetId === null) {
      db.prepare('DELETE FROM connect_events WHERE target_id IS NULL AND id <= (SELECT id FROM connect_events WHERE target_id IS NULL ORDER BY id DESC LIMIT 1 OFFSET ?)').run(keep);
    } else {
      db.prepare('DELETE FROM connect_events WHERE target_id = ? AND id <= (SELECT id FROM connect_events WHERE target_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)').run(targetId, targetId, keep);
    }
  }

  /** Events of removed targets are kept for a while (the audit of the removal), then go. */
  pruneOrphanEvents(olderThanIso: string): void {
    const db = this.store.db;
    if (!db || !this.canWrite) return;
    db.prepare('DELETE FROM connect_events WHERE target_id IS NOT NULL AND at < ? AND target_id NOT IN (SELECT id FROM connect_targets)').run(olderThanIso);
  }

  events(targetId: string, opts: { limit: number; before?: number }): EventRow[] {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit)));
    return (opts.before
      ? this.#all('SELECT * FROM connect_events WHERE target_id = ? AND id < ? ORDER BY id DESC LIMIT ?', targetId, opts.before, limit)
      : this.#all('SELECT * FROM connect_events WHERE target_id = ? ORDER BY id DESC LIMIT ?', targetId, limit)
    ).map(eventOf);
  }

  eventCount(targetId: string | null): number {
    const r = targetId === null ? this.#one('SELECT COUNT(*) AS n FROM connect_events WHERE target_id IS NULL') : this.#one('SELECT COUNT(*) AS n FROM connect_events WHERE target_id = ?', targetId);
    return Number(r?.n ?? 0);
  }

  // ---- settings ------------------------------------------------------------------------------------------------------------------

  setting(key: string): string | null {
    const r = this.#one('SELECT value FROM connect_settings WHERE key = ?', key);
    return r ? str(r.value) : null;
  }

  putSetting(key: string, value: string | null): void {
    const db = this.#write();
    if (value === null) db.prepare('DELETE FROM connect_settings WHERE key = ?').run(key);
    else db.prepare('INSERT INTO connect_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
