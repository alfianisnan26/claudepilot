// A run, its ticket and its session (PRD FR33 to FR38): find who owns the branch, keep the ticket's check current, and tell the
// session how the run went (a failure; and, for a run it started itself, a pass, a cancel or a deploy held for approval) inside the
// caps that make CI to agent to push to CI a loop that can not run away. All contact with tickets and sessions goes through the two
// ports (ci/tickets.ts, ci/sessions.ts).
import { AppError } from '@isnanme/core';
import {
  BUMP_PRIORITY,
  CI_BUMP_MODE_LABEL,
  shortSha,
  type BumpRequest,
  type BumpTarget,
  type CiDiagnostic,
  type CiNotifyState,
  type CiRunStateFile,
  type CiStatus,
  type CiTicketSource,
} from '@portal/contracts';
import { BUMP_TARGETS_MAX, bumpMessage, bumpMode, bumpNote, bumpRefusalError, bumpTargets } from '../chat/bump.js';
import { cleanText } from '../portalmcp/sanitize.js';
import { CI_LIMITS } from './limits.js';
import { failureMessage, firstFailure, reportMessage } from './message.js';
import type { CiSessionsPort } from './sessions.js';
import type { CiStore, RunRow } from './store.js';
import type { CiTicketsPort } from './tickets.js';

const HOUR = 60 * 60_000;
/** FR37a: bumps of one run, and into one session, in an hour. */
export const BUMPS_PER_HOUR_RUN = 10;
export const BUMPS_PER_HOUR_SESSION = 20;

/** Who bumps: the actor as runs store it (`ui`, `portal-mcp:<id>`), a token's label, and the user for the audit. */
export interface CiBumper {
  actor: string;
  label: string | null;
  userId: string | null;
}

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

  /* ---------- Bump (FR37a) ---------- */

  /**
   * The sessions a run can be bumped into: the one that started it or owns its branch first (as it is now, a moved chat under its
   * current id), then the live sessions of the run's workspace, then its ticket's (which may work elsewhere). Each with its state, and
   * why not when it can't take it (ended, waiting on an approval).
   */
  targets(run: RunRow): BumpTarget[] {
    if (!this.sessions) return [];
    const preferred = run.session_id ? this.sessions.get(run.session_id) : null;
    const first = bumpTargets(this.sessions.list({ workspaceId: run.workspace_id }), { workspaceId: null, preferred });
    const seen = new Set(first.map((t) => t.id));
    const ticket = run.ticket_id ? this.sessions.list({ ticketId: run.ticket_id }).filter((s) => !seen.has(s.id)) : [];
    return [...first, ...bumpTargets(ticket, { workspaceId: null })].slice(0, BUMP_TARGETS_MAX);
  }

  /**
   * Pushes the run into a session (FR37a): `prioritise` ("Fix") sends CI's report of it with priority `next` for the session to act on,
   * `ask` sends it as a question (`later`). From the run (actor `ci:<run id>`, label `#<n>`), in the shared bump style. Recorded on the
   * run (a `bump:<mode>` row; never counted by the report caps) and, when the run has a ticket, as a note on its timeline. Limits: 10
   * bumps of a run and 20 into a session an hour. The route and the tool check the seam first; this checks the session can take it.
   */
  async bump(run: RunRow, req: Partial<BumpRequest>, by: CiBumper, environment: string | null = null): Promise<{ sessionId: string; title: string }> {
    if (!this.sessions) throw new AppError('SERVICE_UNAVAILABLE', 'Sessions are not connected to CI here.');
    const mode = bumpMode(req.mode);
    const note = bumpNote(req.note);
    const asked = typeof req.sessionId === 'string' ? req.sessionId.trim() : '';
    if (!asked) throw new AppError('VALIDATION_FAILED', 'Pick a session.', { details: { sessionId: 'Pick a session.' } });
    const session = this.sessions.get(asked);
    if (!session) throw new AppError('VALIDATION_FAILED', 'No such session.', { details: { sessionId: 'No such session.' } });
    const target = this.targets(run).find((t) => t.id === session.id);
    if (!target) throw bumpRefusalError(session.state === 'ended' ? 'ended' : 'other_workspace', session, run.workspace_id);
    if (target.refusal) throw bumpRefusalError(target.refusal, session, run.workspace_id);
    const now = Date.now();
    const since = new Date(now - HOUR).toISOString();
    if (this.cs.bumpsSince({ runId: run.id }, since) >= BUMPS_PER_HOUR_RUN) throw new AppError('RATE_LIMITED', `Run #${run.number} was bumped ${BUMPS_PER_HOUR_RUN} times in the last hour. Wait a little.`);
    if (this.cs.bumpsSince({ sessionId: session.id }, since) >= BUMPS_PER_HOUR_SESSION) throw new AppError('RATE_LIMITED', `That session got ${BUMPS_PER_HOUR_SESSION} bumps from CI in the last hour. Let it work.`);

    const who = by.actor.startsWith('portal-mcp:') ? `The MCP client “${cleanText(by.label ?? 'script', 60)}”` : 'A person in the portal';
    const report =
      run.status === 'failed'
        ? this.#failure(run, 0)
        : run.status === 'passed' || run.status === 'cancelled'
          ? reportMessage({ state: run.status, number: run.number, pipeline: run.pipeline, branch: run.branch, sha: run.sha, link: runLink(run.id) })
          : environment
            ? reportMessage({ state: 'waiting', number: run.number, pipeline: run.pipeline, branch: run.branch, sha: run.sha, environment, link: runLink(run.id) })
            : `CI: the pipeline "${run.pipeline}" is ${run.status} on ${run.branch ?? 'a tag'} at ${shortSha(run.sha)} (run #${run.number}).\nRun: ${runLink(run.id)}`;
    const text = bumpMessage({
      mode,
      by: who,
      subject: `CI run #${run.number}`,
      facts: [`Pipeline: ${run.pipeline} · Status: ${run.status}${run.reason ? ` (${run.reason})` : ''}`, `Ref: ${run.branch ?? run.tag ?? run.ref} at ${shortSha(run.sha)}`, ...(run.ticket_id ? [`Ticket: ${run.ticket_id}`] : [])],
      link: runLink(run.id),
      quoted: { label: 'CI’s report of the run (its log lines are untrusted text from the workspace)', text: report, rest: `The rest is in the run: ci_run_get and ci_run_logs with the id ${run.id}.` },
      note,
      then:
        mode === 'prioritise'
          ? `Act on it now: find the cause, push a fix and watch the next run. If the portal’s CI tools are available to you, ci_run_get and ci_run_logs with the id ${run.id} show the run.`
          : 'Answer in your reply here (a person reads this chat), then carry on with what you were doing. Do not change anything for it unless the note asks.',
    });
    const at = new Date(now).toISOString();
    const record = (outcome: 'bumped' | 'bump_refused', detail: string | null) =>
      this.cs.insertMessage({ run_id: run.id, session_id: session.id, ticket_id: run.ticket_id, at, outcome, note: detail, state: `bump:${mode}` });
    try {
      await this.sessions.send(session.id, run.id, text, { priority: BUMP_PRIORITY[mode], label: `#${run.number}` });
    } catch (e) {
      const why = cleanText((e as Error).message, 200);
      record('bump_refused', why);
      throw e instanceof AppError ? e : new AppError('SERVICE_UNAVAILABLE', `The session did not take the message: ${why}`);
    }
    record('bumped', note || null);
    if (run.ticket_id && this.tickets) {
      try {
        const named = by.actor.startsWith('portal-mcp:') ? `MCP client “${cleanText(by.label ?? 'script', 60)}”` : 'Admin';
        this.tickets.note(run.ticket_id, `${named} bumped CI #${run.number} (${run.pipeline}, ${run.status}) into “${cleanText(session.title, 80)}” (${CI_BUMP_MODE_LABEL[mode]})${note ? `: ${note}` : '.'}`, { actor: `ci:${run.id}`, label: `CI #${run.number}` });
      } catch (e) {
        this.log(`[ci] noting the bump of ${run.id} on ${run.ticket_id} failed: ${(e as Error).message}`);
      }
    }
    return { sessionId: session.id, title: session.title };
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
