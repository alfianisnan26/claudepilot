// The three Git hosts behind one door (docs/prd/triggers.md §9): which headers carry the delivery id and the event, the signature check,
// and the payload mapping. The receiver calls `verifyDelivery` on the RAW bytes first and `normalizeDelivery` only after that passed.

import { createHash } from 'node:crypto';
import type { WebhookProvider, WebhookSpec } from '@portal/contracts';
import { headerId, hostOf, type Normalized } from '../normalize.js';
import { verifyGitea, normalizeGitea } from './gitea.js';
import { normalizeGithub, verifyGithub } from './github.js';
import { normalizeGitlab, verifyGitlab } from './gitlab.js';
import type { HeaderGet } from './signature.js';

export type { HeaderGet } from './signature.js';

export function verifyDelivery(provider: WebhookProvider, get: HeaderGet, raw: Buffer, secret: string, gitlabAuth: WebhookSpec['gitlabAuth'], nowMs: number): boolean {
  if (!secret) return false;
  switch (provider) {
    case 'github':
      return verifyGithub(get, raw, secret);
    case 'gitea':
      return verifyGitea(get, raw, secret);
    case 'gitlab':
      return verifyGitlab(get, raw, secret, gitlabAuth, nowMs);
    default:
      return false;
  }
}

/**
 * The provider's delivery id (FR9): `X-GitHub-Delivery`, `X-Gitea-Delivery`, GitLab's `webhook-id` (then `Idempotency-Key`,
 * `X-Gitlab-Event-UUID`). None (or one with CR, LF or 129+ characters): `body:` + the SHA-256 of the body, so a redelivery is still caught.
 */
export function deliveryIdOf(provider: WebhookProvider, get: HeaderGet, raw: Buffer): string {
  const names = provider === 'github' ? ['x-github-delivery'] : provider === 'gitea' ? ['x-gitea-delivery'] : ['webhook-id', 'idempotency-key', 'x-gitlab-event-uuid'];
  for (const n of names) {
    const v = headerId(get(n));
    if (v) return v;
  }
  return `body:${createHash('sha256').update(raw).digest('hex')}`;
}

/** Maps a verified, parsed body onto the normalised event. */
export function normalizeDelivery(provider: WebhookProvider, get: HeaderGet, body: Record<string, unknown>, host: string | null, at: string): Normalized {
  const h = hostOf(provider, host);
  const event = (name: string) => {
    const v = get(name);
    return v && /^[a-z_]{1,40}$/.test(v) ? v : '';
  };
  switch (provider) {
    case 'github':
      return normalizeGithub(event('x-github-event'), body, h, at);
    case 'gitea':
      return normalizeGitea(event('x-gitea-event'), event('x-gitea-event-type') || null, body, h, at);
    case 'gitlab':
      return normalizeGitlab(body, h, at);
    default:
      return { kind: 'ignore', why: 'unknown_event' };
  }
}
