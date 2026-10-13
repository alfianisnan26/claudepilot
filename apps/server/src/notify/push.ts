// One Web Push delivery (docs/prd/web-app-pwa.md §11.3, §11.4): the Declarative Web Push payload (`web_push: 8030`, `mutable: true`, so
// Safari shows it without our code and our worker gets it first everywhere else), encrypted for the device (RFC 8291), VAPID-signed
// (RFC 8292), with `TTL`, `Urgency` and a hidden `Topic` (RFC 8030), sent through the guarded client.

import { randomBytes } from 'node:crypto';
import { NOTIFY_KIND_INFO, type NotifyDecision, type NotifyError, type NotifyKind, type PushPayload } from '@portal/contracts';
import { statusCode, type Egress, type EgressResult } from './egress.js';
import type { PushKeys } from './vapid.js';
import { encrypt, PUSH_PLAINTEXT_MAX, pushHeaders, topicOf, vapidAuthorization } from './webpush.js';

export interface PushMessage {
  eventId: string;
  kind: NotifyKind;
  title: string;
  body: string;
  /** A portal path (`/admin/...`). */
  path: string;
  tag: string;
  renotify: boolean;
  /** Present only when this device may answer: the single-use token, its decisions and expiry. */
  act?: { t: string; d: NotifyDecision[]; exp: number };
  badge?: number;
  /** Offer "Mute" (opens the mute sheet for this event). Never on approvals, deploy waits, tests or summaries. */
  mute?: boolean;
}

/** The payload, as the PRD shows it. `origin` makes the absolute `navigate` the declarative form requires. */
export function pushPayload(m: PushMessage, origin: string): PushPayload {
  const navigate = `${origin}${m.path}`;
  return {
    web_push: 8030,
    mutable: true,
    notification: {
      title: m.title,
      body: m.body,
      navigate,
      tag: m.tag,
      ...(m.renotify ? { renotify: true } : {}),
      silent: false,
      ...(m.badge !== undefined ? { app_badge: String(Math.max(0, Math.floor(m.badge))) } : {}),
      ...(m.kind === 'approval'
        ? { actions: [{ action: 'review', title: 'Review', navigate }] }
        : m.mute
          ? { actions: [{ action: 'mute', title: 'Mute', navigate: `${origin}/admin/notifications?mute=${encodeURIComponent(m.eventId)}` }] }
          : {}),
      data: { v: 1, id: m.eventId, kind: m.kind, path: m.path, ...(m.act ? { act: m.act } : {}) },
    },
  };
}

/** A push service's answer as a fixed code (RFC 8030: 404 or 410 end the subscription; 401/403 the VAPID token was refused). */
export function pushCode(status: number): NotifyError | null {
  if (status >= 200 && status < 300) return null;
  if (status === 404 || status === 410) return 'gone';
  if (status === 401 || status === 403) return 'vapid_rejected';
  if (status === 400) return 'bad_subscription';
  return statusCode(status);
}

/** The bytes of the payload, the body cut first when it does not fit one record. */
export function payloadBytes(m: PushMessage, origin: string): Buffer | null {
  let bytes = Buffer.from(JSON.stringify(pushPayload(m, origin)));
  if (bytes.length > PUSH_PLAINTEXT_MAX) bytes = Buffer.from(JSON.stringify(pushPayload({ ...m, body: m.body.split('\n')[0]!.slice(0, 120) }, origin)));
  return bytes.length > PUSH_PLAINTEXT_MAX ? null : bytes;
}

export async function sendPush(opts: {
  egress: Egress;
  keys: PushKeys;
  subscription: { endpoint: string; p256dh: string; auth: string };
  message: PushMessage;
  origin: string;
  contact: string | null;
  nowS: number;
}): Promise<EgressResult> {
  const bytes = payloadBytes(opts.message, opts.origin);
  if (!bytes) return { ok: false, status: null, error: 'payload_too_large', retryAfterS: null };
  let body: Buffer;
  try {
    body = encrypt({ plaintext: bytes, uaPublic: Buffer.from(opts.subscription.p256dh, 'base64url'), authSecret: Buffer.from(opts.subscription.auth, 'base64url') }, randomBytes).body;
  } catch {
    return { ok: false, status: null, error: 'bad_subscription', retryAfterS: null };
  }
  const info = NOTIFY_KIND_INFO[opts.message.kind];
  const { header } = vapidAuthorization({ endpoint: opts.subscription.endpoint, privateKey: opts.keys.privateKey, publicKey: opts.keys.publicKey, subject: opts.contact, nowS: opts.nowS });
  const res = await opts.egress.send({
    url: opts.subscription.endpoint,
    headers: pushHeaders({ authorization: header, ttlS: info.ttlSeconds, urgency: info.urgency, topic: topicOf(opts.keys.topicKey, opts.message.tag) }),
    body,
  });
  if (res.status === null) return res;
  const error = pushCode(res.status);
  return { ...res, ok: !error, error };
}
