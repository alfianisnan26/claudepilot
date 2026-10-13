// Mute rules, "Mute similar" (T-25, docs/prd/web-app-pwa.md §11.11). A rule belongs to one person and hushes events of one kind,
// optionally narrowed to one scope (a subject, or a CI run's repository, pipeline or environment, read from the event's facts, never
// from free text) and to one of their destinations, until it expires. A hushed event is still stored in the Inbox, marked muted; it
// does not buzz, toast or push. The never-mute guard: approvals (they block a session) and deploy waits are hushed only by a rule the
// person made in Settings and confirmed (`confirmed = 1`); the pipeline ignores any other rule on those kinds.

import { randomBytes } from 'node:crypto';
import { AppError } from '@isnanme/core';
import {
  isMuteGuarded,
  MUTE_DURATION_MS,
  MUTE_DURATIONS,
  MUTE_RULES_MAX,
  MUTE_SCOPE_TYPES,
  NOTIFY_KINDS,
  type CreateMuteRequest,
  type MuteOffer,
  type MuteScope,
  type MuteScopeType,
  type NotifyEvent,
  type NotifyKind,
  type NotifyMute,
} from '@portal/contracts';
import type { Store } from '../store/store.js';

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null);
const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 12)}…` : id);

/** The scopes an event can be muted by, narrowest first. Subjects of type `portal` have none (a summary, a test). */
export function muteScopesOf(e: Pick<NotifyEvent, 'subject' | 'facts'>): MuteScope[] {
  const out: MuteScope[] = [];
  const s = e.subject;
  const f = e.facts ?? {};
  const workspace = str(s.workspaceId) ?? str(f.workspace);
  const repo = str(f.repo);
  const pipeline = str(f.pipeline);
  const environment = str(f.environment);
  switch (s.type) {
    case 'session':
      out.push({ type: 'session', id: s.id, label: `Session ${shortId(s.id)}${workspace ? ` · ${workspace}` : ''}` });
      break;
    case 'ticket':
      out.push({ type: 'ticket', id: s.id, label: s.id });
      break;
    case 'ci_run':
      if (repo && environment) out.push({ type: 'environment', id: `${repo}/${environment}`, label: `${repo} · ${environment}` });
      if (repo && pipeline) out.push({ type: 'pipeline', id: `${repo}/${pipeline}`, label: `${repo} · ${pipeline}` });
      if (repo) out.push({ type: 'repo', id: repo, label: repo });
      if (!repo) out.push({ type: 'ci_run', id: s.id, label: `Run ${shortId(s.id)}` });
      break;
    case 'claude':
    case 'trigger':
    case 'trigger_run':
    case 'budget': {
      const name = str(f.name);
      out.push({ type: s.type, id: s.id, label: name && s.type === 'budget' ? name : shortId(s.id) });
      break;
    }
    case 'workspace':
    case 'portal':
      break;
  }
  if (workspace) out.push({ type: 'workspace', id: workspace, label: workspace });
  return out;
}

const matches = (rule: { kind: NotifyKind; scope: { type: MuteScopeType; id: string } | null }, e: NotifyEvent, scopes: MuteScope[]) =>
  rule.kind === e.kind && (!rule.scope || scopes.some((s) => s.type === rule.scope!.type && s.id === rule.scope!.id));

interface MuteRow {
  id: string;
  kind: NotifyKind;
  scope_type: MuteScopeType | null;
  scope_id: string | null;
  scope_label: string | null;
  destination_id: string | null;
  confirmed: number;
  created_at: string;
  expires_at: string | null;
  hushed: number;
  last_hushed_at: string | null;
}

const toMute = (r: MuteRow): NotifyMute => ({
  id: r.id,
  kind: r.kind,
  scope: r.scope_type && r.scope_id ? { type: r.scope_type, id: r.scope_id, label: r.scope_label ?? r.scope_id } : null,
  destinationId: r.destination_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  hushed: r.hushed,
  lastHushedAt: r.last_hushed_at,
});

/** What the pipeline needs to know for one person and one event. */
export interface MuteMatch {
  /** A rule for all of the person's destinations matched: the Inbox row is marked muted and nothing is delivered. */
  everywhere: boolean;
  /** Destinations hushed by a rule for that one destination. */
  destinations: Set<string>;
  /** The rules that matched (their counts go up). */
  ids: string[];
}

const NO_MATCH: MuteMatch = { everywhere: false, destinations: new Set(), ids: [] };

export class NotifyMutes {
  constructor(
    private readonly store: Store,
    /** Whether the destination exists and is this person's (404 otherwise). */
    private readonly ownDestination: (id: string, userId: string) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  #rows(ownerId: string): MuteRow[] {
    const db = this.store.db;
    if (!db) return [];
    return db
      .prepare('SELECT * FROM notify_mutes WHERE owner_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC, id DESC')
      .all(ownerId, this.now().toISOString()) as unknown as MuteRow[];
  }

  list(ownerId: string): NotifyMute[] {
    return this.#rows(ownerId).map(toMute);
  }

  /** The live rules of this person that hush the event. Guarded kinds count only rules confirmed in Settings. */
  match(ownerId: string, e: NotifyEvent): MuteMatch {
    if (e.kind === 'test') return NO_MATCH;
    const rows = this.#rows(ownerId).filter((r) => r.kind === e.kind && (!isMuteGuarded(e.kind) || r.confirmed === 1));
    if (!rows.length) return NO_MATCH;
    const scopes = muteScopesOf(e);
    const hit = rows.filter((r) => matches({ kind: r.kind, scope: r.scope_type && r.scope_id ? { type: r.scope_type, id: r.scope_id } : null }, e, scopes));
    if (!hit.length) return NO_MATCH;
    return { everywhere: hit.some((r) => !r.destination_id), destinations: new Set(hit.flatMap((r) => (r.destination_id ? [r.destination_id] : []))), ids: hit.map((r) => r.id) };
  }

  /** Counts one hushed event on each rule. */
  hushed(ids: string[]): void {
    if (!ids.length || !this.store.writable || !this.store.db) return;
    const at = this.now().toISOString();
    const q = this.store.db.prepare('UPDATE notify_mutes SET hushed = hushed + 1, last_hushed_at = ? WHERE id = ?');
    for (const id of ids) q.run(at, id);
  }

  /** What "Mute similar" offers for an Inbox item (`nh_…`) or an event (`evt_…`) of this person; 404 for anything else. */
  offer(ownerId: string, ref: string): MuteOffer {
    const db = this.store.db;
    const col = /^nh_[0-9a-f]{16}$/.test(ref) ? 'id' : /^evt_[0-9a-f]{16}$/.test(ref) ? 'event_id' : null;
    const row =
      col && db
        ? (db.prepare(`SELECT kind, scope_type, scope_id, scope_label FROM notify_history WHERE owner_id = ? AND ${col} = ? LIMIT 1`).get(ownerId, ref) as
            | { kind: NotifyKind; scope_type: MuteScopeType | null; scope_id: string | null; scope_label: string | null }
            | undefined)
        : undefined;
    if (!row || row.kind === 'test') throw new AppError('NOT_FOUND', 'No such notification.');
    return { ref, kind: row.kind, scope: row.scope_type && row.scope_id ? { type: row.scope_type, id: row.scope_id, label: row.scope_label ?? row.scope_id } : null, guarded: isMuteGuarded(row.kind) };
  }

  create(ownerId: string, req: Partial<CreateMuteRequest>): NotifyMute {
    const db = this.store.writable ? this.store.db : null;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The database cannot be written now.');
    const duration = req.duration ?? 'forever';
    if (!MUTE_DURATIONS.includes(duration)) throw new AppError('VALIDATION_FAILED', 'Pick 1 hour, 1 day or forever.', { details: { duration: 'Pick 1 hour, 1 day or forever.' } });
    let kind: NotifyKind;
    let scope: MuteScope | null = null;
    let confirmed = false;
    if (req.from !== undefined) {
      // From a notification: the kind and scope come from the stored item, and a guarded kind is never muted this way.
      if (typeof req.from !== 'string') throw new AppError('VALIDATION_FAILED', 'Which notification?', { details: { from: 'Which notification?' } });
      const offer = this.offer(ownerId, req.from);
      if (offer.guarded) throw new AppError('FORBIDDEN', 'Approvals and deploy waits are muted only in Settings.', { details: { reason: 'guarded' } });
      kind = offer.kind;
      scope = req.wide === true ? null : offer.scope;
    } else {
      if (typeof req.kind !== 'string' || !(NOTIFY_KINDS as readonly string[]).includes(req.kind) || req.kind === 'test') throw new AppError('VALIDATION_FAILED', 'Pick a kind.', { details: { kind: 'Pick a kind.' } });
      kind = req.kind;
      if (req.scope) {
        const t = req.scope.type;
        const id = typeof req.scope.id === 'string' ? req.scope.id.trim() : '';
        if (!(MUTE_SCOPE_TYPES as readonly string[]).includes(t) || !id || id.length > 200 || /[\u0000-\u001f]/.test(id))
          throw new AppError('VALIDATION_FAILED', 'Check the subject.', { details: { scope: 'Check the subject.' } });
        scope = { type: t, id, label: id };
      }
      if (isMuteGuarded(kind)) {
        if (req.confirm !== true) throw new AppError('CONFIRMATION_REQUIRED', 'Confirm: this hushes requests that wait for you.', { details: { kind } });
        confirmed = true;
      }
    }
    const destinationId = req.destinationId ?? null;
    if (destinationId !== null) {
      if (typeof destinationId !== 'string') throw new AppError('VALIDATION_FAILED', 'Which device or channel?', { details: { destinationId: 'Which device or channel?' } });
      this.ownDestination(destinationId, ownerId);
    }
    const count = (db.prepare('SELECT COUNT(*) AS n FROM notify_mutes WHERE owner_id = ?').get(ownerId) as { n: number }).n;
    if (count >= MUTE_RULES_MAX) throw new AppError('CONFLICT', `At most ${MUTE_RULES_MAX} rules.`);
    const now = this.now();
    const ms = MUTE_DURATION_MS[duration];
    const id = `mut_${randomBytes(6).toString('hex')}`;
    db.prepare(
      'INSERT INTO notify_mutes (id, owner_id, kind, scope_type, scope_id, scope_label, destination_id, confirmed, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, ownerId, kind, scope?.type ?? null, scope?.id ?? null, scope?.label ?? null, destinationId, confirmed ? 1 : 0, now.toISOString(), ms === null ? null : new Date(now.getTime() + ms).toISOString());
    return toMute(db.prepare('SELECT * FROM notify_mutes WHERE id = ?').get(id) as unknown as MuteRow);
  }

  /** Removes one rule of this person's (404 for anyone else's), returning what it was. */
  remove(ownerId: string, id: string): NotifyMute {
    const db = this.store.writable ? this.store.db : null;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The database cannot be written now.');
    const row = db.prepare('SELECT * FROM notify_mutes WHERE id = ? AND owner_id = ?').get(id, ownerId) as unknown as MuteRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'No such rule.');
    db.prepare('DELETE FROM notify_mutes WHERE id = ? AND owner_id = ?').run(id, ownerId);
    return toMute(row);
  }

  /** Unmute all: every rule of this person's. */
  clear(ownerId: string): number {
    const db = this.store.writable ? this.store.db : null;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The database cannot be written now.');
    return Number(db.prepare('DELETE FROM notify_mutes WHERE owner_id = ?').run(ownerId).changes);
  }

  /** Expired rules, and rules for a destination that is gone. */
  sweep(): void {
    const db = this.store.writable ? this.store.db : null;
    if (!db) return;
    db.prepare('DELETE FROM notify_mutes WHERE expires_at IS NOT NULL AND expires_at <= ?').run(this.now().toISOString());
    db.prepare('DELETE FROM notify_mutes WHERE destination_id IS NOT NULL AND destination_id NOT IN (SELECT id FROM notify_destinations)').run();
  }
}
