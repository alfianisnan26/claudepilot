// The generic signed webhook (docs/prd/web-app-pwa.md §11.5): JSON `{v:1, id, kind, at, title, body, url, subject, severity}` with
// `X-Pilot-Event`, `X-Pilot-Delivery`, `X-Pilot-Timestamp` (Unix seconds) and, when "Sign" is on,
// `X-Pilot-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>`. Body at most 8 KB. No buttons: a link. Pure.

import { createHmac, randomBytes } from 'node:crypto';
import type { NotifyEvent } from '@portal/contracts';
import type { Rendered } from '../templates.js';

export const WEBHOOK_BODY_MAX = 8 * 1024;
export const SIGNING_SECRET_PREFIX = 'cpws_';

/** A new signing secret, shown once. */
export const newSigningSecret = () => `${SIGNING_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;

export function signature(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export interface ChannelMessage {
  body: string;
  headers: Record<string, string>;
}

export function webhookMessage(e: NotifyEvent, r: Rendered, opts: { url: string | null; deliveryId: string; nowS: number; secret: string | null; detail: { text: string; truncated: boolean } | null }): ChannelMessage {
  const payload = {
    v: 1,
    id: e.id,
    kind: e.kind,
    at: e.at,
    title: r.title,
    body: r.body.split('\n')[0],
    url: opts.url,
    subject: { type: e.subject.type, id: e.subject.id, workspaceId: e.subject.workspaceId ?? null },
    severity: r.severity,
    ...(opts.detail ? { detail: { text: opts.detail.text, truncated: opts.detail.truncated, untrusted: true } } : {}),
  };
  let body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > WEBHOOK_BODY_MAX) body = JSON.stringify({ ...payload, detail: undefined });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'pilot-notify/1',
    'X-Pilot-Event': e.kind,
    'X-Pilot-Delivery': opts.deliveryId,
    'X-Pilot-Timestamp': String(opts.nowS),
  };
  if (opts.secret) headers['X-Pilot-Signature'] = signature(opts.secret, opts.nowS, body);
  return { body, headers };
}
