// The delivery pipeline (docs/prd/web-app-pwa.md §11.2): for each event on the bus, who hears of it (the owners of what it is about,
// checked again with `can(view)`), the Inbox row, then for each of their destinations: kind on? ▸ state ▸ quiet hours ▸ presence ▸
// announce delay ▸ collapse and throttle ▸ render ▸ send (with retries) ▸ the delivery log. Nothing here ever throws into the bus.

import { isMuteGuarded, NOTIFY_KIND_INFO, type NotifyDecision, type NotifyDestination, type NotifyError, type NotifyEvent, type NotifyKind, type TestResult, zonedTime, zoneLabel } from '@portal/contracts';
import type { PlatformOwner } from '../platform/owner.js';
import type { Store } from '../store/store.js';
import { answerOffer, type ActChat, type NotifyActions } from './actions.js';
import type { NotifyBus } from './bus.js';
import { discordMessage } from './channels/discord.js';
import { slackMessage } from './channels/slack.js';
import { webhookMessage, type ChannelMessage } from './channels/webhook.js';
import type { DestinationConfig, Destinations } from './destinations.js';
import type { Egress, EgressResult } from './egress.js';
import type { NotifyHistory } from './history.js';
import { muteScopesOf, type NotifyMutes } from './mutes.js';
import { sendPush, type PushMessage } from './push.js';
import { holds, inQuietHours } from './quiet.js';
import { render, summary, tagOf, type Rendered } from './templates.js';
import type { NotifyKeys } from './vapid.js';

/** What a tab said about itself on the live socket. */
export interface Presence {
  userId: string;
  device: string | null;
  visible: boolean;
  active: boolean;
  session: string | null;
  at: number;
}

export interface PipelineDeps {
  store: Store;
  bus: NotifyBus;
  owner: PlatformOwner;
  destinations: Destinations;
  history: NotifyHistory;
  /** The person's mute rules ("Mute similar"). */
  mutes: NotifyMutes;
  actions: NotifyActions;
  egress: Egress;
  keys: NotifyKeys;
  chat: Pick<ActChat, 'get' | 'openRequests'>;
  /** The answer ceiling (setting `notify.actions.enabled`). */
  ceiling: () => boolean;
  untrusted: (sessionId: string) => boolean;
  /** Where links point (`notify.baseUrl`, `PORTAL_UI_URL`); null: channel messages carry no link. */
  baseUrl: () => string | null;
  /** The origin a push's absolute `navigate` is built on (the base URL, else this portal). */
  origin: () => string;
  contact: () => string | null;
  /** "Changed, load again" on the live topic `notify`. */
  publish: () => void;
  now?: () => Date;
  /** Timers, injectable for tests. */
  schedule?: (ms: number, fn: () => void) => () => void;
  /** Waits between retries (tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
}

/** Announce an approval only if it is still open after this long (an auto-approval rule or the person may answer first). */
export const ANNOUNCE_MS = 3_000;
/** While another device is in use, an approval still open after this long reaches the others. */
export const ESCALATE_MS = 60_000;
/** A device is "in use" when it is visible and had input in the last two minutes. */
export const ACTIVE_MS = 2 * 60_000;
export const RETRY_DELAYS_MS = [30_000, 5 * 60_000];
const TAG_WINDOW_MS = 60_000;
const DEST_WINDOW_MS = 10 * 60_000;
const DEST_MAX = 10;
const CHANNEL_GAP_MS = 1_000;
const IN_FLIGHT_MAX = 4;
const FAILING_RETRY_MS = 3600_000;
const RETRYABLE = new Set<NotifyError>(['timeout', 'http_5xx', 'rate_limited', 'connect']);

export class NotifyPipeline {
  readonly #presence = new Map<object, Presence>();
  readonly #tagSent = new Map<string, number>();
  readonly #destSent = new Map<string, number[]>();
  readonly #throttled = new Map<string, { count: number; kind: NotifyKind }>();
  readonly #pending = new Map<string, (() => void)[]>();
  readonly #inFlight = new Map<string, number>();
  readonly #queue = new Map<string, (() => void)[]>();
  readonly #channelNext = new Map<string, number>();
  readonly #now: () => Date;
  readonly #schedule: (ms: number, fn: () => void) => () => void;
  readonly #sleep: (ms: number) => Promise<void>;
  #off: (() => void) | null = null;
  #tick: NodeJS.Timeout | null = null;

  constructor(private readonly d: PipelineDeps) {
    this.#now = d.now ?? (() => new Date());
    this.#schedule =
      d.schedule ??
      ((ms, fn) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return () => clearTimeout(t);
      });
    this.#sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref()));
  }

  start(): void {
    if (this.#off) return;
    this.#off = this.d.bus.on('*', (e) => void this.handle(e).catch((err: unknown) => console.error(`[notify] delivery of ${e.kind} failed: ${(err as Error).message}`)));
    this.#tick = setInterval(() => void this.tick().catch(() => undefined), 30_000);
    this.#tick.unref();
  }

  stop(): void {
    this.#off?.();
    this.#off = null;
    if (this.#tick) clearInterval(this.#tick);
    for (const cancels of this.#pending.values()) for (const c of cancels) c();
    this.#pending.clear();
  }

  /** The state the page shows: Locked and Frozen deliver nothing (sealed material cannot be opened); read-only cannot write. */
  state(): 'ready' | 'locked' | 'frozen' | 'readonly' {
    const t = this.d.store.trust.state;
    if (t === 'locked' || !this.d.store.secrets) return 'locked';
    if (t === 'frozen') return 'frozen';
    if (!this.d.store.writable) return 'readonly';
    return 'ready';
  }

  /* ---------- Presence ---------- */

  setPresence(connection: object, p: Omit<Presence, 'at'> | null): void {
    if (!p) this.#presence.delete(connection);
    else this.#presence.set(connection, { ...p, at: this.#now().getTime() });
  }

  /** The user's tabs that are visible and in use now. */
  #activeTabs(userId: string): Presence[] {
    const now = this.#now().getTime();
    return [...this.#presence.values()].filter((p) => p.userId === userId && p.visible && p.active && now - p.at < ACTIVE_MS);
  }

  /* ---------- Events ---------- */

  async handle(e: NotifyEvent): Promise<void> {
    if (e.kind === 'test') return; // tests go through `test()`, to one destination
    const owners = new Set(e.audience ?? this.d.owner.ownersOf(e.subject));
    const sharers = e.audience ? [] : this.d.owner.sharersOf(e.subject).filter((u) => !owners.has(u));
    const recipients = [...[...owners].map((u) => ({ userId: u, owner: true })), ...sharers.map((u) => ({ userId: u, owner: false }))].filter(
      (r) => this.d.owner.userEnabled(r.userId) && this.d.owner.can(r.userId, 'view', e.subject),
    );
    if (!recipients.length) return;
    const historyOnly = e.kind === 'quota_low' && e.facts.level === 'near';
    const quota = e.kind === 'quota_low' ? quotaStage(e) : null;
    // T-126: the Inbox row keeps its times as instants (marks), shown in the reader's own zone; never the server's UTC.
    const forHistory = render(e, { marks: true });
    const scope = muteScopesOf(e)[0] ?? null;
    for (const r of recipients) {
      // T-126 item 1: a Claude no chat runs on is information (its own page lists the alert), not an alert, unless the person watches it.
      if (quota && e.facts.chats === 0 && !this.d.history.watches(r.userId, e.subject.id)) continue;
      // A sharer gets an Inbox row only where they asked to hear of shared things.
      const dests = this.d.destinations.forUsers([r.userId]).filter((x) => x.userId === r.userId && (r.owner || x.includeShared));
      // Mute rules: one for all destinations marks the Inbox row muted and sends nothing; one for a destination hushes that one only.
      const muted = this.d.mutes.match(r.userId, e);
      const keep = r.owner || dests.length;
      // T-126 item 2: one quota row per Claude, window and period, updated in place; a push only when it got worse.
      const row = keep && quota ? this.d.history.addQuota(r.userId, e, forHistory, quota, { muted: muted.everywhere, scope }) : null;
      const stored = keep ? (quota ? row?.id ?? null : this.d.history.add(r.userId, e, forHistory, { muted: muted.everywhere, scope })) : null;
      if (stored || dests.some((x) => muted.destinations.has(x.id))) this.d.mutes.hushed(muted.ids);
      if (historyOnly) continue;
      for (const dest of dests) {
        if (row && !row.worse) this.#log(r.userId, e, dest, 'suppressed', 'collapsed');
        else if (muted.everywhere || muted.destinations.has(dest.id)) this.#log(r.userId, e, dest, 'suppressed', 'muted');
        else this.#route(e, dest, r.userId);
      }
    }
    this.d.publish();
  }

  #log(userId: string, e: NotifyEvent, dest: NotifyDestination, status: 'sent' | 'failed' | 'suppressed' | 'held', code: Parameters<NotifyHistory['log']>[1]['code'], attempts = 0, httpStatus: number | null = null) {
    this.d.history.log(userId, { eventId: e.id, kind: e.kind, destinationId: dest.id, status, code, attempts, httpStatus });
  }

  #wants(e: NotifyEvent, dest: NotifyDestination, userId: string): boolean {
    if (e.kind === 'session_done') {
      // "Notify when done" on this session is the person's explicit ask; otherwise only a long turn, where the kind is on.
      if (e.subject.type === 'session' && this.d.destinations.sessionDone(e.subject.id, userId)) return true;
      return dest.kinds.includes('session_done') && typeof e.facts.minutes === 'number' && e.facts.minutes >= 5;
    }
    return dest.kinds.includes(e.kind);
  }

  #route(e: NotifyEvent, dest: NotifyDestination, userId: string): void {
    if (!this.#wants(e, dest, userId)) return this.#log(userId, e, dest, 'suppressed', 'kind_off');
    if (dest.state === 'disabled') return this.#log(userId, e, dest, 'suppressed', 'disabled');
    if (dest.state === 'failing' && dest.lastErrorAt && this.#now().getTime() - Date.parse(dest.lastErrorAt) < FAILING_RETRY_MS) return this.#log(userId, e, dest, 'suppressed', 'disabled');
    const tag = tagOf(e);
    if (holds(dest.quiet, e.kind, this.#now())) {
      this.d.history.hold(userId, dest.id, e, tag);
      return this.#log(userId, e, dest, 'held', 'quiet_hours');
    }
    if (dest.type === 'push') {
      const tabs = this.#activeTabs(userId);
      const showing = [...this.#presence.values()].some((p) => p.userId === userId && p.visible && p.device === dest.id && e.subject.type === 'session' && p.session === e.subject.id);
      if (showing) return this.#log(userId, e, dest, 'suppressed', 'active_device');
      if (tabs.length) {
        if (tabs.some((t) => t.device === dest.id)) return this.#log(userId, e, dest, 'suppressed', 'active_device'); // it gets the toast
        if (e.kind === 'approval') return this.#later(tag, ESCALATE_MS, () => this.#stillOpen(e) ? this.#send(e, dest, userId, tag) : this.#log(userId, e, dest, 'suppressed', 'resolved'));
        if (e.kind !== 'cost_spike') return this.#log(userId, e, dest, 'suppressed', 'active_device');
      }
    }
    if (e.kind === 'approval') return this.#later(tag, ANNOUNCE_MS, () => (this.#stillOpen(e) ? this.#send(e, dest, userId, tag) : this.#log(userId, e, dest, 'suppressed', 'resolved')));
    this.#send(e, dest, userId, tag);
  }

  #later(tag: string, ms: number, fn: () => void): void {
    const list = this.#pending.get(tag) ?? [];
    let cancel = () => {};
    const run = () => {
      const l = this.#pending.get(tag);
      if (l) {
        const i = l.indexOf(cancel);
        if (i >= 0) l.splice(i, 1);
        if (!l.length) this.#pending.delete(tag);
      }
      fn();
    };
    cancel = this.#schedule(ms, run);
    list.push(cancel);
    this.#pending.set(tag, list);
  }

  #stillOpen(e: NotifyEvent): boolean {
    if (e.subject.type !== 'session' || typeof e.facts.requestId !== 'string') return false;
    return this.d.chat.openRequests(e.subject.id).some((r) => r.requestId === e.facts.requestId);
  }

  /** Collapse (one per tag a minute) and the per-destination cap (10 in 10 minutes; the rest become one "more waiting"). */
  #admit(e: NotifyEvent, dest: NotifyDestination, tag: string): 'ok' | 'collapsed' | 'throttled' {
    const now = this.#now().getTime();
    const key = `${dest.id}|${tag}`;
    const last = this.#tagSent.get(key);
    if (last !== undefined && now - last < TAG_WINDOW_MS && e.kind !== 'approval') return 'collapsed';
    const sent = (this.#destSent.get(dest.id) ?? []).filter((t) => now - t < DEST_WINDOW_MS);
    if (sent.length >= DEST_MAX) {
      this.#destSent.set(dest.id, sent);
      const t = this.#throttled.get(dest.id) ?? { count: 0, kind: e.kind };
      this.#throttled.set(dest.id, { count: t.count + 1, kind: e.kind });
      return 'throttled';
    }
    sent.push(now);
    this.#destSent.set(dest.id, sent);
    this.#tagSent.set(key, now);
    if (this.#tagSent.size > 5000) for (const [k, v] of this.#tagSent) if (now - v > TAG_WINDOW_MS) this.#tagSent.delete(k);
    return 'ok';
  }

  #send(e: NotifyEvent, dest: NotifyDestination, userId: string, tag: string): void {
    // The recipient may have lost the right meanwhile (a share revoked, a user disabled).
    if (!this.d.owner.userEnabled(userId) || !this.d.owner.can(userId, 'view', e.subject)) return;
    const fresh = this.d.destinations.find(dest.id);
    if (!fresh || !fresh.enabled || fresh.userId !== userId) return;
    const admitted = this.#admit(e, fresh, tag);
    if (admitted !== 'ok') return this.#log(userId, e, fresh, 'suppressed', admitted);
    void this.#limit(fresh.id, () => this.#deliver(e, fresh, userId, { retries: true }));
  }

  /** At most 4 deliveries in flight per destination. */
  async #limit<T>(destId: string, fn: () => Promise<T>): Promise<T> {
    if ((this.#inFlight.get(destId) ?? 0) >= IN_FLIGHT_MAX) await new Promise<void>((r) => this.#queue.set(destId, [...(this.#queue.get(destId) ?? []), r]));
    this.#inFlight.set(destId, (this.#inFlight.get(destId) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      this.#inFlight.set(destId, (this.#inFlight.get(destId) ?? 1) - 1);
      const next = this.#queue.get(destId)?.shift();
      if (next) next();
    }
  }

  /** The decisions this recipient's notification may carry: the event's offer, cut by their own switches and the ceiling now. */
  #decisions(e: NotifyEvent, userId: string): { decisions: NotifyDecision[]; request: { toolName: string | null; full?: string | null } } | null {
    if (e.kind !== 'approval' || !e.answer) return null;
    const open = this.d.chat.openRequests(e.answer.sessionId).find((r) => r.requestId === e.answer!.requestId);
    const session = this.d.chat.get(e.answer.sessionId);
    if (!open || !session) return null;
    const offer = answerOffer({ request: open, cwd: session.worktree?.path ?? session.cwd, untrusted: this.d.untrusted(session.id), policy: this.d.destinations.prefs(userId), ceiling: this.d.ceiling() });
    const decisions = offer.decisions.filter((x) => e.answer!.decisions.includes(x));
    return decisions.length ? { decisions, request: open } : null;
  }

  async #deliver(e: NotifyEvent, dest: NotifyDestination, userId: string, opts: { retries: boolean; summary?: { title: string; body: string } }): Promise<{ ok: boolean; error: NotifyError | null }> {
    if (this.state() === 'locked' || this.state() === 'frozen') {
      this.d.destinations.noteError(dest.id, 'locked');
      this.#log(userId, e, dest, 'failed', 'locked');
      return { ok: false, error: 'locked' };
    }
    const config = this.d.destinations.config(dest.id);
    if (!config) {
      this.#log(userId, e, dest, 'failed', 'locked');
      return { ok: false, error: 'locked' };
    }
    // The recipient's zone (a device reports its own at registration); a channel that is not a device says which zone it is.
    const r = render(e, { tz: dest.quiet.tz, labelZone: dest.type !== 'push', now: this.#now().getTime(), includeDetail: dest.includeDetail, detailMax: dest.type === 'push' ? 160 : 600 });
    const rendered: Rendered = opts.summary ? { ...r, ...opts.summary, path: '/admin/notifications', tag: `summary:${dest.id}`, renotify: false } : r;
    let attempt = 0;
    let res: EgressResult;
    for (;;) {
      attempt++;
      res = await this.#once(e, dest, config, rendered, userId, !!opts.summary);
      if (res.ok || !opts.retries || !res.error || !RETRYABLE.has(res.error) || attempt > RETRY_DELAYS_MS.length) break;
      const wait = res.retryAfterS !== null ? Math.min(res.retryAfterS * 1000, 5 * 60_000) : RETRY_DELAYS_MS[attempt - 1]!;
      await this.#sleep(wait);
      const still = this.d.destinations.find(dest.id);
      if (!still || !still.enabled) break;
    }
    this.d.destinations.recordResult(dest.id, res.ok, res.error);
    this.#log(userId, e, dest, res.ok ? 'sent' : 'failed', res.error, attempt, res.status);
    this.d.publish();
    return { ok: res.ok, error: res.error };
  }

  async #once(e: NotifyEvent, dest: NotifyDestination, config: DestinationConfig, r: Rendered, userId: string, isSummary: boolean): Promise<EgressResult> {
    if (dest.type === 'push') {
      if (!('endpoint' in config)) return { ok: false, status: null, error: 'bad_subscription', retryAfterS: null };
      const keys = this.d.keys.keys();
      if (!keys) return { ok: false, status: null, error: this.d.store.secrets ? 'no_key' : 'locked', retryAfterS: null };
      const message: PushMessage = { eventId: e.id, kind: e.kind, title: r.title, body: r.body, path: r.path, tag: r.tag, renotify: r.renotify, mute: !isSummary && e.kind !== 'test' && !isMuteGuarded(e.kind) };
      const offer = isSummary ? null : this.#decisions(e, userId);
      if (offer) {
        const t = this.d.actions.issue({ ownerId: userId, destinationId: dest.id, eventId: e.id, sessionId: e.answer!.sessionId, requestId: e.answer!.requestId, decisions: offer.decisions, toolClass: e.answer!.toolClass, request: offer.request });
        if (t) message.act = { t: t.token, d: offer.decisions, exp: t.exp };
      }
      return sendPush({ egress: this.d.egress, keys, subscription: config, message, origin: this.d.origin(), contact: this.d.contact(), nowS: Math.floor(this.#now().getTime() / 1000) });
    }
    if (!('url' in config)) return { ok: false, status: null, error: 'invalid_url', retryAfterS: null };
    // A channel gets at most one message a second.
    const now = this.#now().getTime();
    const next = this.#channelNext.get(dest.id) ?? 0;
    this.#channelNext.set(dest.id, Math.max(now, next) + CHANNEL_GAP_MS);
    if (next > now) await this.#sleep(next - now);
    const base = this.d.baseUrl();
    const url = base ? `${base}${r.path}` : null;
    const detail = dest.includeDetail && e.detail ? { text: e.detail.text.slice(0, 600), truncated: e.detail.truncated || e.detail.text.length > 600 } : null;
    let m: ChannelMessage;
    if (dest.type === 'webhook') m = webhookMessage(e, r, { url, deliveryId: `dlv_${e.id.slice(4)}_${dest.id.slice(4)}`, nowS: Math.floor(this.#now().getTime() / 1000), secret: dest.signed ? config.secret : null, detail });
    else if (dest.type === 'discord') m = discordMessage(r, { url, detail: detail?.text ?? null });
    else m = slackMessage(r, { url, detail: detail?.text ?? null, kindLabel: NOTIFY_KIND_INFO[e.kind].label, when: `${zonedTime(e.at, this.#now().getTime(), dest.quiet.tz)} ${zoneLabel(e.at, dest.quiet.tz)}` });
    return this.d.egress.send({ url: config.url, headers: m.headers, body: m.body, allowPrivate: dest.type === 'webhook' && dest.allowPrivateNetwork });
  }

  /** The Send test button: through the same path, except quiet hours, presence and the throttle; one try. */
  async test(destId: string, userId: string): Promise<TestResult> {
    const dest = this.d.destinations.get(destId, userId);
    const e = this.d.bus.emit({ kind: 'test', subject: { type: 'portal', id: 'test' }, facts: {}, audience: [userId] });
    if (!e) return { ok: false, error: 'invalid_url' };
    this.d.history.add(userId, e, render(e));
    const res = await this.#deliver(e, dest, userId, { retries: false });
    return { ok: res.ok, error: res.ok ? null : res.error };
  }

  /* ---------- Dealt with elsewhere ---------- */

  /** A request was answered or withdrawn: nothing more is sent for it, its tokens die, its Inbox rows dim. */
  resolveRequest(sessionId: string, requestId: string, outcome: string): void {
    const tag = `approval:${sessionId}:${requestId}`;
    for (const cancel of this.#pending.get(tag) ?? []) cancel();
    this.#pending.delete(tag);
    this.d.actions.closeRequest(sessionId, requestId);
    if (this.d.history.resolve(tag, outcome).length) this.d.publish();
  }

  /** Something else was dealt with (a run passed, a ticket closed). */
  resolveTag(tag: string, resolution: string): void {
    for (const cancel of this.#pending.get(tag) ?? []) cancel();
    this.#pending.delete(tag);
    if (this.d.history.resolve(tag, resolution).length) this.d.publish();
  }

  /* ---------- The clock ---------- */

  /** Every 30 s: the summary that ends quiet hours, and the one that stands for what the throttle held back. */
  async tick(): Promise<void> {
    if (this.state() !== 'ready') return;
    const now = this.#now();
    if (this.d.history.recoverQuota() > 0) this.d.publish();
    for (const id of this.d.history.heldDestinations()) {
      const dest = this.d.destinations.find(id);
      if (!dest) continue;
      if (inQuietHours(dest.quiet, now)) continue;
      const items = this.d.history.takeHeld(id);
      if (!items.length) continue;
      await this.#summary(dest, items.at(-1)!.kind, summary(items.length, 'quiet'));
    }
    for (const [id, t] of [...this.#throttled]) {
      const sent = (this.#destSent.get(id) ?? []).filter((x) => now.getTime() - x < DEST_WINDOW_MS);
      if (sent.length >= DEST_MAX) continue;
      this.#throttled.delete(id);
      const dest = this.d.destinations.find(id);
      if (dest) await this.#summary(dest, t.kind, summary(t.count, 'throttle'));
    }
  }

  async #summary(dest: NotifyDestination, kind: NotifyKind, text: { title: string; body: string }): Promise<void> {
    const e: NotifyEvent = { id: `evt_${Date.now().toString(16).padStart(16, '0').slice(-16)}`, kind, at: this.#now().toISOString(), subject: { type: 'portal', id: 'summary' }, facts: {} };
    await this.#limit(dest.id, () => this.#deliver(e, dest, dest.userId, { retries: true, summary: text }));
  }
}

/** How bad a quota alert is (T-126 item 2): near 0, projected to run out 1, high 2, out 3; and its period (the window's reset, ms). */
export function quotaStage(e: NotifyEvent): { stage: number; period: number | null } {
  const level = e.facts.level;
  const stage = level === 'exhausted' ? 3 : level === 'high' ? 2 : level === 'projection' || e.facts.projection === true ? 1 : 0;
  const reset = typeof e.facts.resetsAt === 'string' ? Date.parse(e.facts.resetsAt) : Number.NaN;
  return { stage, period: Number.isNaN(reset) ? null : reset };
}
