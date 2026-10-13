// A run, its ticket and its session (PRD FR33 to FR38): find who owns the branch, keep the ticket's check current, and tell the
// session how the run went (a failure; and, for a run it started itself, a pass, a cancel or a deploy held for approval) inside the
// caps that make CI to agent to push to CI a loop that can not run away. All contact with tickets and sessions goes through the two
// ports (ci/tickets.ts, ci/sessions.ts).
import type { CiDiagnostic, CiNotifyState, CiRunStateFile, CiStatus, CiTicketSource } from '@portal/contracts';
import { CI_LIMITS } from './limits.js';
import { failureMessage, firstFailure, reportMessage } from './message.js';
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

  /** A run's status changed: keep its ticket's check current, and report how it ended to its session. */
  async changed(run: RunRow, previous: CiStatus | null): Promise<void> {
    if (run.ticket_id && this.tickets && run.status !== 'queued') {
      try {
        this.tickets.attachCheck(run.ticket_id, { name: run.pipeline, state: run.status, runId: run.id, commit: run.sha, link: runLink(run.id) }, { actor: `ci:${run.id}`, label: 'CI' });
      } catch (e) {
        this.log(`[ci] attaching ${run.id} to ${run.ticket_id} failed: ${(e as Error).message}`);
      }
    }
    if ((run.status === 'failed' || run.status === 'passed' || run.status === 'cancelled') && previous !== run.status) await this.#report(run, run.status);
  }

  /** A job of the run is held for a person's approval (FR41): the session hears it once per run. */
  async waiting(run: RunRow, environment: string | null): Promise<void> {
    await this.#report(run, 'waiting', environment);
  }

  /**
   * Which states a run reports (FR36). Never a run a person started by hand (`manual` from the UI or an admin token, or a rerun): they
   * are watching it. A failure otherwise always; a pass, a cancel and a held deploy when the session started the run itself (over the
   * Portal MCP, actor `session:<id>`) or when the pipeline's `on.notify` lists that state.
   */
  static reports(run: Pick<RunRow, 'trigger' | 'actor' | 'session_id' | 'plan'>, state: CiNotifyState): boolean {
    if (!run.session_id) return false;
    const bySession = run.actor.startsWith('session:');
    if ((run.trigger === 'manual' || run.trigger === 'rerun') && !bySession) return false;
    if (state === 'failed' || bySession) return true;
    try {
      const notify = run.plan ? (JSON.parse(run.plan) as { notify?: unknown }).notify : undefined;
      return Array.isArray(notify) && notify.includes(state);
    } catch {
      return false;
    }
  }

  /** Runs and states being reported right now: a second call while the first is still sending is not a second message. */
  readonly #inFlight = new Set<string>();

  /** The message, if the run reports this state and the caps allow it (PRD FR36, FR37). Each run and state once. Never throws. */
  async #report(run: RunRow, state: CiNotifyState, environment: string | null = null): Promise<void> {
    const key = `${run.id}:${state}`;
    if (!this.sessions || !CiLinks.reports(run, state) || this.#inFlight.has(key)) return;
    this.#inFlight.add(key);
    try {
      if (this.cs.reported(run.id, state)) return;
      const now = Date.now();
      // Resolved now, not when the run started: a chat that moved to another Claude is reached as it is now; an ended one is not woken.
      const session = this.sessions.get(run.session_id!);
      const record = (outcome: string, note: string | null = null, to = session?.id ?? run.session_id!) =>
        this.cs.insertMessage({ run_id: run.id, session_id: to, ticket_id: run.ticket_id, at: new Date(now).toISOString(), outcome, note, state });
      if (!session?.live) {
        record('ended', session ? null : 'no such session');
        return;
      }
      const by = { ticketId: run.ticket_id, sessionId: session.id };

      // The failure streak pauses failure reports only: a pass ends it, and a cancel or a held deploy is no loop.
      const window = new Date(now - CI_LIMITS.pauseWindowMs).toISOString();
      const streak = state === 'failed' && run.branch ? this.cs.failureStreak(run.repo_id, run.branch, window) : 0;
      if (streak > CI_LIMITS.failuresToPause) {
        // Said once on the ticket, then quiet until a run passes.
        if (!this.cs.pausedSince(session.id, window) && run.ticket_id) {
          this.tickets?.note(run.ticket_id, `CI has failed ${streak} times in a row on ${run.branch}. It will not message the session again until a run passes.`, { actor: `ci:${run.id}`, label: 'CI' });
        }
        record('paused', `${streak} failed runs in a row`);
        return;
      }

      if (this.cs.sentSince(by, new Date(now - HOUR).toISOString()) >= CI_LIMITS.messagesPerHour || this.cs.sentSince(by, new Date(now - 24 * HOUR).toISOString()) >= CI_LIMITS.messagesPerDay) {
        record('capped');
        return;
      }
      const text = state === 'failed' ? this.#failure(run, streak) : reportMessage({ state, number: run.number, pipeline: run.pipeline, branch: run.branch, sha: run.sha, environment, link: runLink(run.id) });
      try {
        await this.sessions.send(session.id, run.id, text);
        record('sent');
      } catch (e) {
        // Recorded, not retried: the session said no (ended, switching, over its own cap).
        record('refused', (e as Error).message.slice(0, 200));
      }
    } catch (e) {
      this.log(`[ci] telling the session about ${run.id} (${state}) failed: ${(e as Error).message}`);
    } finally {
      this.#inFlight.delete(key);
    }
  }

  #failure(run: RunRow, streak: number): string {
    const state = (() => {
      try {
        return run.state ? (JSON.parse(run.state) as CiRunStateFile) : null;
      } catch {
        return null;
      }
    })();
    const fail = firstFailure(state);
    return failureMessage({
      number: run.number,
      pipeline: run.pipeline,
      branch: run.branch,
      sha: run.sha,
      reason: run.reason,
      state,
      diagnostics: (run.diagnostics ? (JSON.parse(run.diagnostics) as CiDiagnostic[]) : []) ?? [],
      log: fail?.step ? this.cs.keptLog(run.id, fail.job.id, fail.step.idx) : null,
      lastWarning: streak >= CI_LIMITS.failuresToPause,
      link: runLink(run.id),
    });
  }
}

/** A run's page in the portal. */
export const runLink = (runId: string): string => `/admin/ci/runs/${runId}`;
