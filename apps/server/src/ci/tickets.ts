// The one place CI touches tickets (interface I10 with the tickets module). Everything else in CI talks to `CiTicketsPort`, so a
// fake stands in for it in tests and nothing imports the ticket service. CI attaches a check and adds a timeline note: it never changes
// the status or assignee of a ticket somebody made (PRD §5). One exception, its own: the ticket of a flaky test (T-95 item 4), which CI
// opens as the portal and reopens when the test is seen again.
import { isTicketClosed, type TicketCheckState } from '@portal/contracts';
import type { Tickets } from '../tickets/service.js';

export interface CiCheck {
  /** The pipeline's name: one check per ticket and pipeline, holding its latest state. */
  name: string;
  state: TicketCheckState;
  runId: string;
  commit: string;
  /** A portal page: `/admin/ci/runs/<id>`. */
  link: string;
}

export interface CiTicketsPort {
  exists(id: string): boolean;
  /** The existing tickets a branch name and a commit message name, by the branch and then the trailers. */
  find(refs: { branch?: string; message?: string }): string[];
  /** Attaches or updates the pipeline's check on the ticket. False when there is no such ticket. */
  attachCheck(ticketId: string, check: CiCheck, by: { actor: string; label?: string }): boolean;
  /** A note on the ticket's timeline, from CI. False when there is no such ticket. */
  note(ticketId: string, text: string, by: { actor: string; label?: string }): boolean;
  /** Opens a ticket as the portal (a flaky test's, T-95 item 4). Returns its id. */
  open(req: FlakyTicketRequest): string;
  /** Whether the ticket is closed; null when there is no such ticket. */
  closed(ticketId: string): boolean | null;
  /** Reopens a closed ticket as the portal. */
  reopen(ticketId: string): void;
  /** A ticket's summary, type and status now, for the release report (T-591); null when there is no such ticket. */
  info(ticketId: string): { summary: string; type: string; status: string } | null;
}

/** A ticket CI opens by itself: always a bug of normal priority. */
export interface FlakyTicketRequest {
  summary: string;
  description: string;
  tags: string[];
  workspaceId: string | null;
}

const SYSTEM = { kind: 'system' as const };

/** The real thing, over the ticket service. */
export class TicketsAdapter implements CiTicketsPort {
  constructor(private readonly tickets: Tickets) {}

  exists(id: string): boolean {
    return this.tickets.exists(id);
  }

  find(refs: { branch?: string; message?: string }): string[] {
    return this.tickets.find(refs);
  }

  attachCheck(ticketId: string, check: CiCheck, by: { actor: string; label?: string }): boolean {
    return this.tickets.attachCheck(ticketId, { name: check.name, state: check.state, runId: check.runId, commit: check.commit, link: check.link }, by) !== null;
  }

  note(ticketId: string, text: string, by: { actor: string; label?: string }): boolean {
    return this.tickets.note(ticketId, text, by);
  }

  open(req: FlakyTicketRequest): string {
    return this.tickets.create(SYSTEM, { type: 'bug', priority: 'normal', ...req }).id;
  }

  closed(ticketId: string): boolean | null {
    const b = this.tickets.brief(ticketId);
    return b ? isTicketClosed(b.status) : null;
  }

  reopen(ticketId: string): void {
    this.tickets.update(SYSTEM, ticketId, { status: 'open' });
  }

  info(ticketId: string): { summary: string; type: string; status: string } | null {
    const b = this.tickets.brief(ticketId);
    return b ? { summary: b.summary, type: b.type, status: b.status } : null;
  }
}

/** For tests: tickets that exist, and a record of what CI did to them. */
export class FakeTickets implements CiTicketsPort {
  readonly known = new Set<string>();
  readonly checks = new Map<string, Map<string, CiCheck>>();
  readonly history: { ticketId: string; check: CiCheck }[] = [];
  readonly notes: { ticketId: string; text: string; actor: string }[] = [];
  failWith: Error | null = null;

  constructor(...ids: string[]) {
    ids.forEach((i) => this.known.add(i));
  }

  exists(id: string) {
    return this.known.has(id);
  }

  find(refs: { branch?: string; message?: string }): string[] {
    const out: string[] = [];
    const branch = refs.branch ? /(?:^|\/)ticket\/(?:T-)?(\d{1,9})(?:[-_/]|$)/i.exec(refs.branch) : null;
    if (branch) out.push(`T-${Number(branch[1])}`);
    for (const m of (refs.message ?? '').matchAll(/^Ticket:[ \t]*(?:T-|#)?(\d{1,9})\b/gim)) out.push(`T-${Number(m[1])}`);
    return [...new Set(out)].filter((id) => this.known.has(id));
  }

  attachCheck(ticketId: string, check: CiCheck): boolean {
    if (this.failWith) throw this.failWith;
    if (!this.known.has(ticketId)) return false;
    const byName = this.checks.get(ticketId) ?? new Map<string, CiCheck>();
    byName.set(check.name, check);
    this.checks.set(ticketId, byName);
    this.history.push({ ticketId, check });
    return true;
  }

  note(ticketId: string, text: string, by: { actor: string }): boolean {
    if (!this.known.has(ticketId)) return false;
    this.notes.push({ ticketId, text, actor: by.actor });
    return true;
  }

  readonly opened: (FlakyTicketRequest & { id: string })[] = [];
  readonly closedIds = new Set<string>();
  readonly reopened: string[] = [];

  open(req: FlakyTicketRequest): string {
    const id = `T-${900 + this.opened.length}`;
    this.known.add(id);
    this.opened.push({ ...req, id });
    return id;
  }

  closed(ticketId: string): boolean | null {
    return this.known.has(ticketId) ? this.closedIds.has(ticketId) : null;
  }

  reopen(ticketId: string): void {
    this.closedIds.delete(ticketId);
    this.reopened.push(ticketId);
  }

  /** Summaries, types and statuses a test sets for the release report. */
  readonly infos = new Map<string, { summary: string; type: string; status: string }>();
  info(ticketId: string): { summary: string; type: string; status: string } | null {
    return this.infos.get(ticketId) ?? (this.known.has(ticketId) ? { summary: ticketId, type: 'task', status: 'open' } : null);
  }
}
