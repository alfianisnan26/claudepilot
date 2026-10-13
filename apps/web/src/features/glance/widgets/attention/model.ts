import { requestReview, TICKET_PRIORITY_LABEL, type CiReason, type GlanceApproval, type GlanceCiRun, type GlanceTicket } from '@portal/contracts';
import type { GlanceCompact, GlanceLevel } from '../../types';
import { chipCount, listWords, plural } from '../shared/format';
import type { Readings } from '../shared/readings';

// The Needs-attention widget's logic, apart from React so it can be tested (docs/prd/glance-widgets.md §6.4).

/**
 * The chip: what waits on a person, added up (open requests, tickets assigned to a person, failed CI runs that still stand). Red while a
 * request waits (a session is stopped on it), amber for the rest, grey when nothing waits. `count` is what the installed app's badge shows.
 */
export function attentionCompact({ data, failed, stale }: Readings): GlanceCompact {
  if (!data) return failed ? { value: '-', level: 'unknown', title: 'Needs attention: not available', stale: true } : { value: null, level: 'unknown', title: 'Needs attention: loading', loading: true };
  const a = data.attention;
  const blind = [!a.approvals.ok && 'requests', !a.tickets.ok && 'tickets', !a.ci.ok && 'CI'].filter((x): x is string => !!x);
  if (blind.length === 3) return { value: '-', level: 'unknown', title: 'Needs attention: could not be read', stale };
  const level: GlanceLevel = a.approvals.count > 0 ? 'critical' : a.tickets.count + a.ci.count > 0 ? 'warn' : blind.length ? 'unknown' : 'idle';
  const found = listWords([
    a.approvals.count ? plural(a.approvals.count, 'approval') : null,
    a.tickets.count ? plural(a.tickets.count, 'ticket') : null,
    a.ci.count ? `${a.ci.count} failed CI ${a.ci.count === 1 ? 'run' : 'runs'}` : null,
  ]);
  const unread = blind.length ? ` (${listWords(blind)} could not be read)` : '';
  return { value: chipCount(a.count), level, title: `${found ? `Needs attention: ${found}` : 'Nothing needs attention'}${unread}`, count: a.count, stale };
}

/** Where an item opens. */
export const sessionHref = (sessionId: string): string => `/admin/sessions/${encodeURIComponent(sessionId)}`;
export const ticketHref = (ticketId: string): string => `/admin/tickets/${encodeURIComponent(ticketId)}`;
export const ciRunHref = (runId: string): string => `/admin/ci/runs/${encodeURIComponent(runId)}`;

/**
 * Whether a request can be allowed or denied from the widget, or only opened (Deny stays: it is always the safe answer). Allow is
 * offered only for a tool request whose text the widget shows whole: the portal keeps up to 8,000 characters of what is being allowed
 * (`full`), and a request with none, or cut at that cap, or that is not a tool request (a question, a plan: to read, not to wave
 * through), is opened in its session. The session's own card applies the same rule (`requestReview`, one function for both).
 */
export type ApprovalMode = 'decide' | 'open';
export function approvalMode(a: Pick<GlanceApproval, 'kind' | 'full' | 'fullCut'>): ApprovalMode {
  return a.kind === 'tool' && requestReview(a).allow ? 'decide' : 'open';
}

/** Why Allow is not offered here, for the row's one line; null when it is. */
export function approvalNote(a: Pick<GlanceApproval, 'kind' | 'full' | 'fullCut'>): string | null {
  if (a.kind !== 'tool') return 'Open to read it first.';
  return requestReview(a).note;
}

/** The accessible sentence of an approval: what it asks, of which session. */
export const approvalTitle = (a: GlanceApproval): string => `${a.title}${a.detail ? `: ${a.detail}` : ''} (${a.sessionTitle})`;

export const PRIORITY_WORD = TICKET_PRIORITY_LABEL;

/** A ticket's second line: its id, how urgent, how old. */
export const ticketMeta = (t: GlanceTicket): string => `${t.id} · ${PRIORITY_WORD[t.priority]}`;

const REASON_WORD: Record<CiReason, string> = {
  step_failed: 'step failed',
  timeout: 'timed out',
  invalid_pipeline: 'invalid pipeline',
  runner_lost: 'runner lost',
  no_space: 'out of space',
  runner_error: 'runner error',
  cancelled: 'cancelled',
  superseded: 'superseded',
  needs: 'needs failed',
  condition: 'condition',
  signal: 'stopped by signal',
  fail_fast: 'fail fast',
  rejected: 'rejected',
};

/** A failed run's title: where and what. */
export const ciTitle = (r: GlanceCiRun): string => `${r.repo} · ${r.pipeline} #${r.number}`;

/** A failed run's second line: the branch (or "tag") and why it failed. */
export const ciMeta = (r: GlanceCiRun): string => [r.branch ?? 'tag', r.reason ? REASON_WORD[r.reason] : 'failed'].join(' · ');
