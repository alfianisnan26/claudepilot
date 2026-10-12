// Destinations (docs/prd/web-app-pwa.md §11.4 to §11.6): a Web Push device, a webhook, a Discord or a Slack channel, each a user's own,
// each with its kinds, quiet hours and switches. What reaches it is SEALED at rest (`config`: a push endpoint and its keys, a channel URL
// and signing secret) and never returned: a destination shows a host (`hint`). Every read and change is scoped to the owner in SQL, so
// another user's id answers like an unknown one. Also the per-user answer switches and "Notify when done" flags.

import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '@isnanme/core';
import {
  NOTIFY_KIND_INFO,
  NOTIFY_KINDS,
  NOTIFY_PHASE1_KINDS,
  QUIET_DEFAULT,
  type CreateChannelRequest,
  type DestinationType,
  type NotifyActionPolicy,
  type NotifyDestination,
  type NotifyError,
  type NotifyKind,
  type PushSubscriptionInput,
  type QuietHours,
  type UpdateDestinationRequest,
} from '@portal/contracts';
import type { Store } from '../store/store.js';
import { DISCORD_URL } from './channels/discord.js';
import { SLACK_URL } from './channels/slack.js';
import { newSigningSecret } from './channels/webhook.js';
import { hostOf, type Egress } from './egress.js';
import { isHhmm, isTimeZone } from './quiet.js';
import { knownPushService, validP256 } from './webpush.js';

export const PUSH_MAX = 20;
export const CHANNELS_MAX = 20;
const NAME_MAX = 60;
const ENDPOINT_MAX = 500;
const URL_MAX = 2000;

/** What is sealed in `config`. */
export type DestinationConfig = { endpoint: string; p256dh: string; auth: string } | { url: string; secret: string | null };

interface Row {
  id: string;
  owner_id: string;
  type: DestinationType;
  name: string;
  enabled: number;
  kinds: string;
  quiet: string;
  include_shared: number;
  include_detail: number;
  allow_private: number;
  signed: number;
  tz: string;
  hint: string | null;
  unrecognised: number;
  state: NotifyDestination['state'];
  failures: number;
  last_ok_at: string | null;
  last_error_at: string | null;
  last_error: NotifyError | null;
  created_at: string;
  config: string | null;
}

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const notFound = () => new AppError('NOT_FOUND', 'No such destination.');
const slot = (id: string) => ({ table: 'notify_destinations', row: id, column: 'config' });
const COLS = 'id, owner_id, type, name, enabled, kinds, quiet, include_shared, include_detail, allow_private, signed, tz, hint, unrecognised, state, failures, last_ok_at, last_error_at, last_error, created_at, config';

export const defaultKinds = (): NotifyKind[] => NOTIFY_PHASE1_KINDS.filter((k) => NOTIFY_KIND_INFO[k].defaultOn);
export const defaultQuiet = (tz: string): QuietHours => ({ ...QUIET_DEFAULT, tz, breakthrough: NOTIFY_PHASE1_KINDS.filter((k) => NOTIFY_KIND_INFO[k].breakthrough) });

/** A name a person gave: one line, no hidden characters, clipped. */
export function cleanName(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  return (s || fallback).slice(0, NAME_MAX);
}

function kindsOf(v: unknown, field = 'kinds'): NotifyKind[] {
  if (!Array.isArray(v) || v.length > NOTIFY_KINDS.length) throw invalid(field, 'A list of kinds.');
  const out = new Set<NotifyKind>();
  for (const k of v) {
    if (typeof k !== 'string' || !(NOTIFY_KINDS as readonly string[]).includes(k)) throw invalid(field, `Unknown kind ${String(k).slice(0, 30)}.`);
    out.add(k as NotifyKind);
  }
  return [...out];
}

function quietOf(v: unknown, tz: string): QuietHours {
  if (!v || typeof v !== 'object') throw invalid('quiet', 'Quiet hours are an object.');
  const q = v as Partial<QuietHours>;
  if (!isHhmm(q.start) || !isHhmm(q.end)) throw invalid('quiet', 'Times are HH:MM.');
  const zone = q.tz === undefined ? tz : q.tz;
  if (!isTimeZone(zone)) throw invalid('quiet', 'Unknown time zone.');
  return { enabled: q.enabled === true, start: q.start, end: q.end, tz: zone, breakthrough: kindsOf(q.breakthrough ?? [], 'quiet') };
}

const b64u = (s: unknown, bytes: number): Buffer | null => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+=*$/.test(s) || s.length > 200) return null;
  const b = Buffer.from(s.replace(/=+$/, ''), 'base64url');
  return b.length === bytes ? b : null;
};

export class Destinations {
  constructor(
    private readonly store: Store,
    private readonly egress: Egress,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get #db() {
    const db = this.store.db;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not available.');
    return db;
  }

  get #writable() {
    if (!this.store.writable) throw new AppError('SERVICE_UNAVAILABLE', 'The database is read-only.', { details: { reason: 'readonly' } });
    return this.#db;
  }

  /** Sealing needs the key: a Locked portal can make nothing new. */
  get #box() {
    const box = this.store.secrets;
    if (!box) throw new AppError('SERVICE_UNAVAILABLE', 'The portal is locked: unlock it to change notifications.', { details: { reason: 'locked' } });
    return box;
  }

  #view(r: Row): NotifyDestination {
    let quiet: QuietHours;
    try {
      quiet = JSON.parse(r.quiet) as QuietHours;
    } catch {
      quiet = defaultQuiet(r.tz);
    }
    let kinds: NotifyKind[] = [];
    try {
      kinds = (JSON.parse(r.kinds) as string[]).filter((k): k is NotifyKind => (NOTIFY_KINDS as readonly string[]).includes(k));
    } catch {
      kinds = [];
    }
    return {
      id: r.id,
      userId: r.owner_id,
      type: r.type,
      name: r.name,
      enabled: r.enabled === 1,
      hint: this.store.secrets && r.config ? r.hint : null,
      kinds,
      quiet,
      includeShared: r.include_shared === 1,
      includeDetail: r.include_detail === 1,
      allowPrivateNetwork: r.allow_private === 1,
      signed: r.signed === 1,
      state: r.state,
      lastOkAt: r.last_ok_at,
      lastErrorAt: r.last_error_at,
      lastError: r.last_error,
      failures: r.failures,
      unrecognisedService: r.unrecognised === 1,
      createdAt: r.created_at,
    };
  }

  #row(id: string, ownerId: string | null): Row | null {
    if (typeof id !== 'string' || !/^dst_[0-9a-f]{12}$/.test(id)) return null;
    const r = this.store.db?.prepare(`SELECT ${COLS} FROM notify_destinations WHERE id = ?`).get(id) as Row | undefined;
    if (!r || (ownerId !== null && r.owner_id !== ownerId)) return null;
    return r;
  }

  /** The user's destinations, push devices first. */
  list(ownerId: string): NotifyDestination[] {
    const rows = (this.store.db?.prepare(`SELECT ${COLS} FROM notify_destinations WHERE owner_id = ? ORDER BY type = 'push' DESC, created_at`).all(ownerId) ?? []) as unknown as Row[];
    return rows.map((r) => this.#view(r));
  }

  /** One destination of the user, or 404 (another user's id answers like an unknown one). */
  get(id: string, ownerId: string): NotifyDestination {
    const r = this.#row(id, ownerId);
    if (!r) throw notFound();
    return this.#view(r);
  }

  /** For the pipeline: any user's, with its owner. */
  find(id: string): NotifyDestination | null {
    const r = this.#row(id, null);
    return r ? this.#view(r) : null;
  }

  /** Every destination of these users that may receive something. */
  forUsers(userIds: string[]): NotifyDestination[] {
    if (!userIds.length || !this.store.db) return [];
    const rows = this.store.db.prepare(`SELECT ${COLS} FROM notify_destinations WHERE enabled = 1 AND owner_id IN (${userIds.map(() => '?').join(', ')})`).all(...userIds) as unknown as Row[];
    return rows.map((r) => this.#view(r));
  }

  /** The sealed material; null while Locked (or sealed under another key). */
  config(id: string): DestinationConfig | null {
    const box = this.store.secrets;
    const r = this.#row(id, null);
    if (!box || !r?.config) return null;
    try {
      return JSON.parse(box.open(r.config, slot(id))) as DestinationConfig;
    } catch {
      return null;
    }
  }

  /** `POST /api/notify/push`: this browser. The same endpoint again updates it; one that another user holds moves to this user. */
  registerPush(ownerId: string, input: { subscription?: Partial<PushSubscriptionInput>; name?: unknown; tz?: unknown }): { destination: NotifyDestination; movedFrom: string | null } {
    const sub = input.subscription;
    if (!sub || typeof sub !== 'object') throw invalid('subscription', 'A push subscription is required.');
    const endpoint = sub.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length > ENDPOINT_MAX) throw invalid('endpoint', 'The endpoint is missing or too long.');
    // https, no user info, not a private or metadata literal (the egress's own rules; the delivery guard checks the name at every send).
    const pre = this.egress.precheck(endpoint);
    if (pre) throw invalid('endpoint', pre === 'blocked_address' ? 'The endpoint is not a public address.' : 'The endpoint must be an https URL.');
    const p256dh = b64u(sub.keys?.p256dh, 65);
    if (!p256dh || !validP256(p256dh)) throw invalid('p256dh', 'The key is not a P-256 point.');
    const auth = b64u(sub.keys?.auth, 16);
    if (!auth) throw invalid('auth', 'The auth secret must be 16 bytes.');
    const tz = isTimeZone(input.tz) ? input.tz : 'UTC';
    const host = hostOf(endpoint);
    const hash = createHash('sha256').update(endpoint).digest('hex');
    const box = this.#box;
    const db = this.#writable;
    const at = this.now().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT id, owner_id FROM notify_destinations WHERE endpoint_hash = ?').get(hash) as { id: string; owner_id: string } | undefined;
      let id: string;
      let movedFrom: string | null = null;
      if (existing) {
        id = existing.id;
        if (existing.owner_id !== ownerId) {
          // A phone handed to someone else stops notifying the first person: the device moves, its tokens die, its settings start fresh.
          movedFrom = existing.owner_id;
          db.prepare('DELETE FROM notify_action_tokens WHERE destination_id = ?').run(id);
          db.prepare('DELETE FROM notify_held WHERE destination_id = ?').run(id);
          db.prepare("UPDATE notify_destinations SET owner_id = ?, created_by = ?, kinds = ?, quiet = ?, include_shared = 0, include_detail = 0, enabled = 1, created_at = ? WHERE id = ?").run(
            ownerId,
            ownerId,
            JSON.stringify(defaultKinds()),
            JSON.stringify(defaultQuiet(tz)),
            at,
            id,
          );
        }
        const count = (db.prepare("SELECT COUNT(*) AS n FROM notify_destinations WHERE owner_id = ? AND type = 'push' AND id != ?").get(ownerId, id) as { n: number }).n;
        if (count >= PUSH_MAX) throw invalid('subscription', `At most ${PUSH_MAX} devices.`);
        db.prepare("UPDATE notify_destinations SET config = ?, hint = ?, unrecognised = ?, tz = ?, name = COALESCE(?, name), state = 'ok', failures = 0, last_error = NULL, updated_at = ? WHERE id = ?").run(
          box.seal(JSON.stringify({ endpoint, p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') }), slot(id)),
          host,
          knownPushService(host) ? 0 : 1,
          tz,
          typeof input.name === 'string' && input.name.trim() ? cleanName(input.name, 'This device') : null,
          at,
          id,
        );
      } else {
        const count = (db.prepare("SELECT COUNT(*) AS n FROM notify_destinations WHERE owner_id = ? AND type = 'push'").get(ownerId) as { n: number }).n;
        if (count >= PUSH_MAX) throw invalid('subscription', `At most ${PUSH_MAX} devices.`);
        id = `dst_${randomBytes(6).toString('hex')}`;
        db.prepare(
          `INSERT INTO notify_destinations (id, owner_id, created_by, type, name, enabled, kinds, quiet, tz, hint, unrecognised, endpoint_hash, created_at, updated_at, config)
           VALUES (?, ?, ?, 'push', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          ownerId,
          ownerId,
          cleanName(input.name, 'This device'),
          JSON.stringify(defaultKinds()),
          JSON.stringify(defaultQuiet(tz)),
          tz,
          host,
          knownPushService(host) ? 0 : 1,
          hash,
          at,
          at,
          box.seal(JSON.stringify({ endpoint, p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') }), slot(id)),
        );
      }
      db.exec('COMMIT');
      return { destination: this.get(id, ownerId), movedFrom };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /** `POST /api/notify/destinations`: a webhook, Discord or Slack channel. The URL is sealed and never returned; a signing secret is shown once. */
  createChannel(ownerId: string, req: Partial<CreateChannelRequest>): { destination: NotifyDestination; signingSecret: string | null } {
    const type = req.type;
    if (type !== 'webhook' && type !== 'discord' && type !== 'slack') throw invalid('type', 'Use webhook, discord or slack.');
    const raw = typeof req.url === 'string' ? req.url.trim() : '';
    if (!raw || raw.length > URL_MAX) throw invalid('url', 'A URL is required.');
    const allowPrivate = type === 'webhook' && req.allowPrivateNetwork === true;
    if (type === 'discord' && !DISCORD_URL.test(raw)) throw invalid('url', 'Not a Discord webhook URL.');
    if (type === 'slack' && !SLACK_URL.test(raw)) throw invalid('url', 'Not a Slack webhook URL.');
    const pre = this.egress.precheck(raw, allowPrivate);
    if (pre) throw invalid('url', pre === 'blocked_address' ? 'That address is private. Tick “Private network” for a webhook on your network.' : 'The URL must be https, without a user name or password.');
    const kinds = req.kinds === undefined ? defaultKinds() : kindsOf(req.kinds);
    const box = this.#box;
    const db = this.#writable;
    const count = (db.prepare("SELECT COUNT(*) AS n FROM notify_destinations WHERE owner_id = ? AND type != 'push'").get(ownerId) as { n: number }).n;
    if (count >= CHANNELS_MAX) throw invalid('type', `At most ${CHANNELS_MAX} channels.`);
    const signed = type === 'webhook' && req.signed === true;
    const secret = signed ? newSigningSecret() : null;
    const id = `dst_${randomBytes(6).toString('hex')}`;
    const at = this.now().toISOString();
    db.prepare(
      `INSERT INTO notify_destinations (id, owner_id, created_by, type, name, enabled, kinds, quiet, include_shared, include_detail, allow_private, signed, tz, hint, created_at, updated_at, config)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'UTC', ?, ?, ?, ?)`,
    ).run(
      id,
      ownerId,
      ownerId,
      type,
      cleanName(req.name, type === 'webhook' ? 'Webhook' : type === 'discord' ? 'Discord' : 'Slack'),
      JSON.stringify(kinds),
      JSON.stringify(defaultQuiet('UTC')),
      req.includeShared === true ? 1 : 0,
      req.includeDetail === true ? 1 : 0,
      allowPrivate ? 1 : 0,
      signed ? 1 : 0,
      hostOf(raw),
      at,
      at,
      box.seal(JSON.stringify({ url: raw, secret }), slot(id)),
    );
    return { destination: this.get(id, ownerId), signingSecret: secret };
  }

  /** `PATCH`: whatever is present changes. Turning a destination on again clears its failures. */
  update(id: string, ownerId: string, req: Partial<UpdateDestinationRequest>): NotifyDestination {
    const r = this.#row(id, ownerId);
    if (!r) throw notFound();
    const sets: string[] = [];
    const args: (string | number)[] = [];
    const set = (col: string, v: string | number) => {
      sets.push(`${col} = ?`);
      args.push(v);
    };
    let tz = r.tz;
    if (req.tz !== undefined) {
      if (!isTimeZone(req.tz)) throw invalid('tz', 'Unknown time zone.');
      tz = req.tz;
      set('tz', tz);
    }
    if (req.name !== undefined) set('name', cleanName(req.name, r.name));
    if (req.enabled !== undefined) {
      if (typeof req.enabled !== 'boolean') throw invalid('enabled', 'On or off.');
      set('enabled', req.enabled ? 1 : 0);
      if (req.enabled && r.state !== 'ok') {
        set('state', 'ok');
        set('failures', 0);
      }
    }
    if (req.kinds !== undefined) set('kinds', JSON.stringify(kindsOf(req.kinds)));
    if (req.quiet !== undefined) set('quiet', JSON.stringify(quietOf(req.quiet, tz)));
    else if (req.tz !== undefined) set('quiet', JSON.stringify({ ...this.#view(r).quiet, tz })); // the zone is the destination's: its quiet hours follow
    for (const [key, col] of [
      ['includeDetail', 'include_detail'],
      ['includeShared', 'include_shared'],
    ] as const) {
      const v = req[key];
      if (v === undefined) continue;
      if (typeof v !== 'boolean') throw invalid(key, 'On or off.');
      set(col, v ? 1 : 0);
    }
    if (req.allowPrivateNetwork !== undefined) {
      if (typeof req.allowPrivateNetwork !== 'boolean') throw invalid('allowPrivateNetwork', 'On or off.');
      if (r.type !== 'webhook' && req.allowPrivateNetwork) throw invalid('allowPrivateNetwork', 'Only a webhook may reach a private network.');
      set('allow_private', req.allowPrivateNetwork ? 1 : 0);
    }
    if (sets.length) {
      set('updated_at', this.now().toISOString());
      this.#writable.prepare(`UPDATE notify_destinations SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`).run(...args, id, ownerId);
    }
    return this.get(id, ownerId);
  }

  /** Removes it; its pending answer tokens die with it (kept until they expire, so an answer with one says `device_removed`). */
  remove(id: string, ownerId: string): void {
    const r = this.#row(id, ownerId);
    if (!r) throw notFound();
    const db = this.#writable;
    db.prepare('DELETE FROM notify_held WHERE destination_id = ?').run(id);
    db.prepare('DELETE FROM notify_destinations WHERE id = ? AND owner_id = ?').run(id, ownerId);
  }

  /** A new signing secret for a signed webhook, shown once. */
  rotateSecret(id: string, ownerId: string): string {
    const r = this.#row(id, ownerId);
    if (!r) throw notFound();
    if (r.type !== 'webhook') throw invalid('type', 'Only a webhook is signed.');
    const cfg = this.config(id);
    if (!cfg || !('url' in cfg)) throw new AppError('SERVICE_UNAVAILABLE', 'The portal is locked: unlock it to change notifications.', { details: { reason: 'locked' } });
    const secret = newSigningSecret();
    this.#writable
      .prepare('UPDATE notify_destinations SET config = ?, signed = 1, updated_at = ? WHERE id = ? AND owner_id = ?')
      .run(this.#box.seal(JSON.stringify({ url: cfg.url, secret }), slot(id)), this.now().toISOString(), id, ownerId);
    return secret;
  }

  /** The outcome of one delivery: `failing` after 3 failures in a row, `disabled` after 20 or when a push service says the subscription is gone. */
  recordResult(id: string, ok: boolean, error: NotifyError | null): void {
    if (!this.store.writable) return;
    const db = this.#db;
    const at = this.now().toISOString();
    if (ok) {
      db.prepare("UPDATE notify_destinations SET state = 'ok', failures = 0, last_ok_at = ? WHERE id = ?").run(at, id);
      return;
    }
    const r = this.#row(id, null);
    if (!r) return;
    const failures = r.failures + 1;
    const state = error === 'gone' || failures >= 20 ? 'disabled' : failures >= 3 ? 'failing' : r.state === 'disabled' ? 'disabled' : 'ok';
    db.prepare('UPDATE notify_destinations SET state = ?, failures = ?, last_error_at = ?, last_error = ? WHERE id = ?').run(state, failures, at, error, id);
    if (error === 'gone') db.prepare('DELETE FROM notify_action_tokens WHERE destination_id = ?').run(id);
  }

  /** Records a code without counting a failure (a Locked portal: nothing was tried). */
  noteError(id: string, error: NotifyError): void {
    if (!this.store.writable) return;
    this.#db.prepare('UPDATE notify_destinations SET last_error_at = ?, last_error = ? WHERE id = ?').run(this.now().toISOString(), error, id);
  }

  /* ---------- Per-user switches ---------- */

  prefs(ownerId: string): NotifyActionPolicy {
    const r = this.store.db?.prepare('SELECT deny, allow_read, allow_edit, allow_command FROM notify_user_prefs WHERE owner_id = ?').get(ownerId) as
      | { deny: number; allow_read: number; allow_edit: number; allow_command: number }
      | undefined;
    return r ? { deny: r.deny === 1, allowRead: r.allow_read === 1, allowEdit: r.allow_edit === 1, allowCommand: r.allow_command === 1 } : { deny: true, allowRead: false, allowEdit: false, allowCommand: false };
  }

  setPrefs(ownerId: string, p: NotifyActionPolicy): NotifyActionPolicy {
    this.#writable
      .prepare(
        `INSERT INTO notify_user_prefs (owner_id, deny, allow_read, allow_edit, allow_command, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id) DO UPDATE SET deny = excluded.deny, allow_read = excluded.allow_read, allow_edit = excluded.allow_edit, allow_command = excluded.allow_command, updated_at = excluded.updated_at`,
      )
      .run(ownerId, p.deny ? 1 : 0, p.allowRead ? 1 : 0, p.allowEdit ? 1 : 0, p.allowCommand ? 1 : 0, this.now().toISOString());
    return this.prefs(ownerId);
  }

  sessionDone(sessionId: string, ownerId: string): boolean {
    const r = this.store.db?.prepare('SELECT done FROM notify_session_flags WHERE session_id = ? AND owner_id = ?').get(sessionId, ownerId) as { done: number } | undefined;
    return r?.done === 1;
  }

  setSessionDone(sessionId: string, ownerId: string, done: boolean): void {
    const db = this.#writable;
    if (!done) db.prepare('DELETE FROM notify_session_flags WHERE session_id = ? AND owner_id = ?').run(sessionId, ownerId);
    else
      db.prepare('INSERT INTO notify_session_flags (session_id, owner_id, done, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(session_id, owner_id) DO UPDATE SET done = 1, updated_at = excluded.updated_at').run(
        sessionId,
        ownerId,
        this.now().toISOString(),
      );
  }
}
