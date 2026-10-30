// T-2885 (PILOT-1009): refusals that file an approval request through the workspace outbox (docs/prd/approvals.md, "From a refusal").
//
// job-run.sh (a deny-listed `--pool-env` name) and the rule guard (a refused tool call) run with no portal token, so they append one line to
// `~/.claudepilot/outbox/approval.jsonl` and print the id they drew; the portal pulls the line (every 10 s) and makes the request with that
// id. The line is the workspace's word (its user writes the file), so: only the two outbox kinds; the session must be a portal chat of the
// workspace the line came from; at most OUTBOX_PENDING_MAX of them wait per session; and the payload goes through the service's own checks
// (schema, size, no secret-shaped value or key). A line that fails any of these makes nothing: the printed id stays unknown.

import { isAppError } from '@isnanme/core';
import { APPROVAL_OUTBOX_KINDS, type ApprovalKind, type ChatServerMessage } from '@portal/contracts';
import type { OutboxEvent } from '../delivery/outbox.js';
import type { Store } from '../store/store.js';
import { portalSession } from '../settings/ruleGuardAudit.js';
import type { Approvals } from './service.js';
import { PASS_HASH } from './pass.js';

/** The outbox channel (`approval.jsonl`). */
export const APPROVAL_CHANNEL = 'approval';
/** Refusal requests that may wait at once per session; more are dropped (a looping agent must not flood Needs you). */
export const OUTBOX_PENDING_MAX = 5;

const isOutboxKind = (k: unknown): k is ApprovalKind => typeof k === 'string' && (APPROVAL_OUTBOX_KINDS as readonly string[]).includes(k);
const SESSION = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Files each `request` line of one workspace's pull. Returns the ids of the cards made or, for a repeat of a waiting refused call (T-3114),
 * of the card it was folded into. `session` is the portal chat id (job-run reads PILOT_SESSION_ID);
 * `claudeSession` is a Claude Code session id (the guard's hook input), mapped to its portal chat.
 */
export function fileRefusalRequests(approvals: Approvals, store: Pick<Store, 'db'>, workspaceId: string, events: OutboxEvent[], log?: (what: string, e: unknown) => void): string[] {
  const made: string[] = [];
  for (const e of events) {
    if (e.type !== 'request' || !isOutboxKind(e.kind)) continue;
    const sessionId =
      typeof e.session === 'string' && SESSION.test(e.session) ? e.session : typeof e.claudeSession === 'string' && SESSION.test(e.claudeSession) ? portalSession(store, e.claudeSession) : null;
    // Only a chat of THIS workspace: a line may not name another workspace's session (its card and its message would go there).
    const session = sessionId ? approvals.chat?.get(sessionId) : null;
    if (!session || session.workspaceId !== workspaceId) continue;
    try {
      // T-3114: the service folds a repeat of a waiting refused call into its card (no new card, so it is not capped) and caps the rest.
      const a = approvals.create(
        { kind: e.kind, payload: e.payload, reason: e.kind === 'jobrun.pool_env' ? 'job-run refused a deny-listed name' : 'the rule guard refused this call' },
        { sessionId: session.id, workspaceId },
        { id: e.id, pendingCap: { max: OUTBOX_PENDING_MAX, kinds: APPROVAL_OUTBOX_KINDS } },
      );
      made.push(a.id);
    } catch (err) {
      // Over the cap: dropped quietly, as before. A refused payload (schema, size, a secret-shaped value): the words are the service's, never
      // the payload.
      if (isAppError(err) && err.code === 'RATE_LIMITED') continue;
      log?.(`approval request from ${workspaceId}`, err instanceof Error ? new Error(err.message) : err);
    }
  }
  return made;
}

/**
 * T-3114: a chat event that ends a session (state `ended`, archived, or deleted) expires the refused calls it filed: nothing waits on them
 * any more. Any other event does nothing. Returns how many cards expired.
 */
export function expireRefusalsOnEnd(approvals: Pick<Approvals, 'expireForSession'>, sessionId: string, msg: ChatServerMessage, log?: (what: string, e: unknown) => void): number {
  const why =
    msg.type === 'session' && msg.session.state === 'ended'
      ? 'The asking session ended.'
      : msg.type === 'session' && msg.session.archivedAt
        ? 'The asking session was archived.'
        : msg.type === 'removed'
          ? 'The asking session was deleted.'
          : null;
  if (!why) return 0;
  try {
    return approvals.expireForSession(sessionId, why);
  } catch (e) {
    log?.(`expiring the refused calls of ${sessionId}`, e);
    return 0;
  }
}

/**
 * T-2889: each `used` line says the workspace used a pass (`{ type: 'used', pass }`). The portal marks the pass used and delivers the
 * workspace again, so the passes file drops it. Only a live pass of THIS workspace is touched. Returns how many passes were marked.
 */
export function markUsedPasses(approvals: Approvals, workspaceId: string, events: OutboxEvent[], log?: (what: string, e: unknown) => void): number {
  let n = 0;
  for (const e of events) {
    if (e.type !== 'used' || typeof e.pass !== 'string' || !PASS_HASH.test(e.pass)) continue;
    if (approvals.markPassUsed(workspaceId, e.pass)) n++;
  }
  if (n) {
    try {
      approvals.delivery?.passesChanged(workspaceId);
    } catch (err) {
      log?.(`delivering ${workspaceId} after a used pass`, err);
    }
  }
  return n;
}
