// A run, its ticket and its session (PRD FR33 to FR38): find who owns the branch, keep the ticket's check current, and tell the
// session about a failure inside the caps that make CI to agent to push to CI a loop that can not run away. All contact with
// tickets and sessions goes through the two ports (ci/tickets.ts, ci/sessions.ts).
import type { CiDiagnostic, CiRunStateFile, CiStatus, CiTicketSource } from '@portal/contracts';
import { CI_LIMITS } from './limits.js';
import { failureMessage, firstFailure } from './message.js';
import type { CiSessionsPort } from './sessions.js';
import type { CiStore, RunRow } from './store.js';
import type { CiTicketsPort } from './tickets.js';

const HOUR = 60 * 60_000;

export class CiLinks {
  constructor(
    private readonly cs: CiStore,
    private readonly tickets: CiTicketsPort | undefined,
    private readonly sessions: CiSessionsPort | undefined,
    private readonly log: (line: string) => void = (l) => console.error(l),
  ) {}

  /**
   * Finds the ticket and the session a new run belongs to and stores them on it. The session that owns the branch comes first
   * (its own ticket link is the portal's, so it is the most reliable), then a `Ticket: T-n` trailer in the commit message, then
   * a branch named for the ticket. A ticket that does not exist is never linked, and CI never makes one.
   */
  link(run: RunRow, message: string | null): RunRow {
    // A rerun keeps what the run it repeats was linked to.
    if (run.ticket_id || run.session_id) return run;
    let ticketId: string | null = null;
    let source: CiTicketSource | null = null;
    let sessionId: string | null = null;
    try {
      const session = run.branch && this.sessions ? this.sessions.byBranch(run.workspace_id, run.branch) : null;
      sessionId = session?.id ?? null;
      if (this.tickets) {
        if (session?.ticketId && this.tickets.exists(session.ticketId)) [ticketId, source] = [session.ticketId, 'session'];
        else {
          const trailer = message ? this.tickets.find({ message })[0] : undefined;
          if (trailer) [ticketId, source] = [trailer, 'trailer'];
          else {
            const branch = run.branch ? this.tickets.find({ branch: run.branch })[0] : undefined;
            if (branch) [ticketId, source] = [branch, 'branch'];
          }
        }
      }
    } catch (e) {
      this.log(`[ci] linking ${run.id} failed: ${(e as Error).message}`);
    }
    if (!ticketId && !sessionId) return run;
    this.cs.updateRun(run.id, { ticket_id: ticketId, ticket_source: source, session_id: sessionId });
    return this.cs.run(run.id) ?? run;
  }

  /** A run's status changed: keep its ticket's check current, and report a failure to its session. */
  async changed(run: RunRow, previous: CiStatus | null): Promise<void> {
    if (run.ticket_id && this.tickets && run.status !== 'queued') {
      try {
        this.tickets.attachCheck(run.ticket_id, { name: run.pipeline, state: run.status, runId: run.id, commit: run.sha, link: `/admin/ci/runs/${run.id}` }, { actor: `ci:${run.id}`, label: 'CI' });
      } catch (e) {
        this.log(`[ci] attaching ${run.id} to ${run.ticket_id} failed: ${(e as Error).message}`);
      }
    }
    if (run.status === 'failed' && previous !== 'failed') await this.#tell(run);
  }

  /** The failure message, if the caps allow it (PRD FR36, FR37). Never throws. */
  async #tell(run: RunRow): Promise<void> {
    try {
      if (!this.sessions || !run.session_id || !run.branch) return;
      // By hand, someone is already watching it.
      if (run.trigger === 'manual' || run.trigger === 'rerun') return;
      const session = this.sessions.get(run.session_id);
      if (!session?.live) return;
      const now = Date.now();
      const record = (outcome: string, note: string | null = null) =>
        this.cs.insertMessage({ run_id: run.id, session_id: run.session_id!, ticket_id: run.ticket_id, at: new Date(now).toISOString(), outcome, note });
      const by = { ticketId: run.ticket_id, sessionId: run.session_id };

      const window = new Date(now - CI_LIMITS.pauseWindowMs).toISOString();
      const streak = this.cs.failureStreak(run.repo_id, run.branch, window);
      if (streak > CI_LIMITS.failuresToPause) {
        // Said once on the ticket, then quiet until a run passes.
        if (!this.cs.pausedSince(run.session_id, window)) {
          record('paused', `${streak} failed runs in a row`);
          if (run.ticket_id) this.tickets?.note(run.ticket_id, `CI has failed ${streak} times in a row on ${run.branch}. It will not message the session again until a run passes.`, { actor: `ci:${run.id}`, label: 'CI' });
        }
        return;
      }

      if (this.cs.sentSince(by, new Date(now - HOUR).toISOString()) >= CI_LIMITS.messagesPerHour || this.cs.sentSince(by, new Date(now - 24 * HOUR).toISOString()) >= CI_LIMITS.messagesPerDay) {
        record('capped');
        return;
      }
      const state = (() => {
        try {
          return run.state ? (JSON.parse(run.state) as CiRunStateFile) : null;
        } catch {
          return null;
        }
      })();
      const fail = firstFailure(state);
      const text = failureMessage({
        number: run.number,
        pipeline: run.pipeline,
        branch: run.branch,
        sha: run.sha,
        reason: run.reason,
        state,
        diagnostics: (run.diagnostics ? (JSON.parse(run.diagnostics) as CiDiagnostic[]) : []) ?? [],
        log: fail?.step ? this.cs.keptLog(run.id, fail.job.id, fail.step.idx) : null,
        lastWarning: streak >= CI_LIMITS.failuresToPause,
      });
      try {
        await this.sessions.send(run.session_id, run.id, text);
        record('sent');
      } catch (e) {
        // Recorded, not retried: the session said no (ended, switching, over its own cap).
        record('refused', (e as Error).message.slice(0, 200));
      }
    } catch (e) {
      this.log(`[ci] telling the session about ${run.id} failed: ${(e as Error).message}`);
    }
  }
}
