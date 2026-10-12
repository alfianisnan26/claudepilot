// Failed CI as a source (docs/prd/triggers.md FR10): the bus's `ci_failed` event (N1's CI adapter owns `ci.hooks.changed`; triggers never
// take that slot). The run is read from the CI service, its validated facts become the event, and the end of the failed step's log is
// UNTRUSTED text (the quoted block only). The loop guard: the same remote, pipeline and branch does not fire again for `cooldownMin`, not
// more than `maxPerBranchPerDay` a day, and NEVER for a run that this trigger's own work pushed (`self_triggered`).

import type { CiRun, ChatSession, NotifyEvent, TriggerEventFacts } from '@portal/contracts';
import { startOfLocalDay } from './cron.js';
import { branchName, sha, untrustedText } from './normalize.js';
import type { TriggerRunner } from './runner.js';
import type { TriggerRecord, TriggerStore } from './store.js';

export interface CiReader {
  get(id: string): CiRun;
  log(id: string, job: unknown, step: unknown, offset: unknown): Promise<{ text: string }>;
}

export interface CiSourceDeps {
  ci: CiReader | null;
  store: TriggerStore;
  runner: TriggerRunner;
  chat: { get(id: string): ChatSession | null };
  timezone(): string;
  now?: () => Date;
}

const NAME = /^[A-Za-z0-9._/ -]{1,100}$/;
const name = (v: unknown): string | null => (typeof v === 'string' && NAME.test(v) ? v : null);

/** The facts of a failed run: names validated, the log's end as untrusted text. */
export async function ciFacts(ci: CiReader, run: CiRun, at: string): Promise<TriggerEventFacts> {
  let logTail: string | undefined;
  try {
    const job = run.detail.find((j) => j.status === 'failed' && !j.ignored);
    const step = job?.steps.find((s) => s.status === 'failed');
    if (job && step) logTail = untrustedText((await ci.log(run.id, job.id, step.idx, 0)).text.slice(-4000));
  } catch {
    // No log: the event goes without it.
  }
  return {
    source: 'ci_failed',
    provider: null,
    event: 'ci_failed',
    action: null,
    repo: name(run.repo),
    branch: branchName(run.branch),
    sha: sha(run.sha),
    number: null,
    sender: null,
    url: null,
    fork: null,
    at,
    ci: { runId: run.id, runNumber: run.number, pipeline: name(run.pipeline) ?? 'pipeline', reason: run.reason ? String(run.reason).slice(0, 40) : null, ticketId: run.ticketId, workspaceId: run.workspaceId },
    untrusted: logTail ? { logTail } : {},
  };
}

/** Whether a session (or one above it) was started by this trigger: `portal:trigger-<id>`. */
export function startedBy(chat: { get(id: string): ChatSession | null }, sessionId: string | null, triggerId: string): boolean {
  let s = sessionId ? chat.get(sessionId) : null;
  for (let i = 0; s && i < 16; i++) {
    if (s.startedBy === `portal:trigger-${triggerId}`) return true;
    s = s.parentId ? chat.get(s.parentId) : null;
  }
  return false;
}

/**
 * The loop guard for one trigger and one failed run. `self_triggered`: the run's actor or session is in this trigger's tree, its ticket is
 * one this trigger made, or its branch is the worktree branch of a session this trigger started (a push from that worktree has actor `push`).
 */
export function loopGuard(d: Pick<CiSourceDeps, 'store' | 'chat' | 'timezone'>, t: TriggerRecord, run: CiRun, f: TriggerEventFacts, nowMs: number): { cooldown: boolean; selfTriggered: boolean } {
  const work = d.store.startedWork(t.id);
  const actorSession = /^session:(.+)$/.exec(run.actor)?.[1] ?? null;
  const branches = new Set(work.map((w) => (w.sessionId ? d.chat.get(w.sessionId)?.worktree?.branch : null)).filter((b): b is string => !!b));
  const selfTriggered =
    startedBy(d.chat, actorSession, t.id) ||
    startedBy(d.chat, run.sessionId, t.id) ||
    (!!run.ticketId && work.some((w) => w.ticketId === run.ticketId)) ||
    (!!f.branch && branches.has(f.branch));
  const same = (e: TriggerEventFacts) => e.repo === f.repo && e.ci?.pipeline === f.ci?.pipeline && e.branch === f.branch;
  const c = t.ciFailed!;
  const recent = d.store.ciRunsSince(t.id, new Date(nowMs - c.cooldownMin * 60_000).toISOString()).filter(same).length;
  const today = d.store.ciRunsSince(t.id, new Date(startOfLocalDay(d.timezone(), nowMs)).toISOString()).filter(same).length;
  return { cooldown: recent > 0 || today >= c.maxPerBranchPerDay, selfTriggered };
}

/** The bus listener: one failed run, every CI trigger. */
export function ciSource(d: CiSourceDeps): (e: NotifyEvent) => void {
  const now = d.now ?? (() => new Date());
  return (e) => {
    if (e.kind !== 'ci_failed' || e.subject.type !== 'ci_run' || !d.ci) return;
    const triggers = d.store.bySource('ci_failed');
    if (!triggers.length) return;
    let run: CiRun;
    try {
      run = d.ci.get(e.subject.id);
    } catch {
      return;
    }
    void (async () => {
      const f = await ciFacts(d.ci!, run, now().toISOString());
      for (const t of triggers) {
        const guard = loopGuard(d, t, run, f, now().getTime());
        await d.runner.fire(t, { facts: f, actor: 'ci', guard, deliveryId: `ci:${run.id}` }).catch((err: Error) => console.error(`[triggers] ${t.id}: a CI event failed (${err.message.slice(0, 80)})`));
      }
    })();
  };
}
