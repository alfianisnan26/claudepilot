// T-277 layer 4: while a job that deploys to an environment runs, the portal says in its log which chats are attached to a live process
// and how many of its control requests they have not answered yet. The deploy pipeline's release step reads that line (it already reads the
// portal's log in verify; steps get no portal credential, PRD FR20) to record the chats it is about to restart and to wait while one is
// answering; the chats job after verify looks for their integrity endings in the new portal's log (.pilot/scripts/chats.sh).
//
// The line holds ids and facts only, never a title or any text of a chat: short ids, the workspace, the Claude, the mode, the follower key and
// the open count. Every field is cut to a fixed alphabet, so a value can not break the line or reach a shell as anything but a word.
import type { CiAttachedChat } from './sessions.js';

export const DEPLOY_CHATS_TAG = '[deploy-chats]';

const field = (v: string | null | undefined, max: number): string => (v ?? '').replace(/[^A-Za-z0-9._/-]+/g, '_').slice(0, max) || '-';

/** `pending=<n>` over all chats, `?` when the portal can not tell for one of them. */
export function pendingOf(chats: readonly CiAttachedChat[]): string {
  if (chats.some((c) => c.pending === null)) return '?';
  return String(chats.reduce((n, c) => n + (c.pending ?? 0), 0));
}

/**
 * One line: `[deploy-chats] run=<id> job=<job> attached=<n> pending=<n|?> chats=<chat>,<chat>` (or `chats=-`), each chat
 * `<id8>:<claude>:<mode>:<tail8>:<open|?>:<workspace>`.
 */
export function deployChatsLine(runId: string, job: string, chats: readonly CiAttachedChat[]): string {
  const list = chats.map((c) => [field(c.id, 8), field(c.claudeId, 40), field(c.mode, 24), field(c.tail, 8), c.pending === null ? '?' : String(c.pending), field(c.workspaceId, 80)].join(':'));
  return `${DEPLOY_CHATS_TAG} run=${field(runId, 40)} job=${field(job, 64)} attached=${chats.length} pending=${pendingOf(chats)} chats=${list.join(',') || '-'}`;
}

/**
 * Says the line when a deploying job is first seen running, and again each time the open count changes, until the job is no longer running.
 * Never throws: a failure is one log line and the run goes on.
 */
export class DeployChatsWatch {
  /** `<run>/<job>` of each deploying job seen running, with the open count of its last line. */
  readonly #said = new Map<string, string>();

  constructor(
    private readonly attached: () => CiAttachedChat[],
    private readonly log: (line: string) => void = (line) => console.log(line),
  ) {}

  observe(runId: string, deployments: readonly { job: string }[], jobs: readonly { id: string; status: string }[]): void {
    for (const d of deployments) {
      const key = `${runId}/${d.job}`;
      if (jobs.find((j) => j.id === d.job)?.status !== 'running') {
        this.#said.delete(key);
        continue;
      }
      try {
        const chats = this.attached();
        const pending = pendingOf(chats);
        if (this.#said.get(key) === pending) continue;
        this.#said.set(key, pending);
        this.log(deployChatsLine(runId, d.job, chats));
      } catch (e) {
        if (this.#said.get(key) === 'error') continue;
        this.#said.set(key, 'error');
        this.log(`${DEPLOY_CHATS_TAG} run=${field(runId, 40)} job=${field(d.job, 64)} unavailable: ${field((e as Error).message, 120)}`);
      }
    }
  }

  /** The run is over. */
  forget(runId: string): void {
    for (const key of this.#said.keys()) if (key.startsWith(`${runId}/`)) this.#said.delete(key);
  }
}
