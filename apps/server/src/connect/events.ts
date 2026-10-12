// Connect's audit trail (docs/prd/targets-connect.md FR60, §17.3): lifecycle and admin actions with the client address, never a secret. The
// detail is flat and small BY CONSTRUCTION: this is the only writer, it keeps strings, numbers, booleans and null, clips every string and
// runs it through the redactors (a token or a key that reached a detail would be stored as `[redacted]`). Five thousand rows are kept per target.

import { CONNECT_EVENT_TYPES, type ConnectEvent, type ConnectEventType } from '@portal/contracts';
import { cleanText } from '../portalmcp/sanitize.js';
import type { ConnectStore, EventRow } from './store.js';

/** Who acted, as an audit string. An admin is `actorString(actor)` from the authorization seam (`user:u_owner`); the others are fixed forms. */
export const SYSTEM_ACTOR = 'system';
export const agentActor = (nodeId: string): string => `agent:${nodeId}`;

const DETAIL_KEYS = 12;
const DETAIL_TEXT = 200;
const KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;

/** What may go into a detail: flat, small, text cleaned and redacted. Everything else is dropped, not stored. */
export function flatDetail(detail: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!detail) return out;
  let n = 0;
  for (const [k, v] of Object.entries(detail)) {
    if (n >= DETAIL_KEYS) break;
    if (!KEY.test(k)) continue;
    if (typeof v === 'string') out[k] = cleanText(v, DETAIL_TEXT);
    else if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      out[k] = v;
    } else if (typeof v === 'boolean' || v === null) out[k] = v;
    else continue;
    n++;
  }
  return out;
}

/** An address as stored: a short run of the characters an address has. */
export function cleanIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const s = ip.trim().slice(0, 64);
  return /^[0-9A-Za-z:.%_-]+$/.test(s) ? s : null;
}

export interface EventInput {
  type: ConnectEventType;
  targetId?: string | null;
  nodeId?: string | null;
  enrollmentId?: string | null;
  actor: string;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

const toEvent = (r: EventRow): ConnectEvent => ({
  id: r.id,
  at: r.at,
  type: (CONNECT_EVENT_TYPES as readonly string[]).includes(r.type) ? r.type : 'agent.log',
  targetId: r.targetId,
  nodeId: r.nodeId,
  actor: r.actor,
  ip: r.ip,
  detail: r.detail,
});

export class ConnectEvents {
  constructor(
    private readonly store: ConnectStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Writes one row. A refused write (the store is Locked or read only) is skipped: the audit must never be why an action fails. */
  record(e: EventInput): void {
    try {
      this.store.insertEvent({
        at: this.now().toISOString(),
        type: e.type,
        targetId: e.targetId ?? null,
        nodeId: e.nodeId ?? null,
        enrollmentId: e.enrollmentId ?? null,
        actor: cleanText(e.actor, 80),
        ip: cleanIp(e.ip),
        detail: flatDetail(e.detail),
      });
    } catch (err) {
      console.error(`[connect] audit write failed: ${(err as Error).message}`);
    }
  }

  /** Newest first. `before` is an event id (the one the page before ended on). */
  list(targetId: string, opts: { limit?: number; before?: number } = {}): ConnectEvent[] {
    return this.store.events(targetId, { limit: opts.limit ?? 50, before: opts.before }).map(toEvent);
  }
}
