// The one place CI touches tickets (interface I10 with the tickets module). Everything else in CI talks to `CiTicketsPort`, so a
// fake stands in for it in tests and nothing imports the ticket service. CI only ever attaches a check and adds a timeline note:
// it never changes a ticket's status or assignee (PRD §5).
import type { TicketCheckState } from '@portal/contracts';
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
}

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
}
