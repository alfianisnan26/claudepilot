// The job-run Mac door (T-1083 S1b, D-84; docs/prd/local-git-ci.md §25): `scripts/job-run.sh` asks the portal for a slot on the owner's Mac
// and runs a Job there through the Mac workspace's Docker. The door's key is the calling session's own agent token (`PILOT_MCP_TOKEN`, `cpst_`):
// no token of its own, no table (coordinator, T-1083 #11498). Wire types shared by the server and the script's tests.

/** The door's guards: the request body cap, the read of a body, and the requests a session or a refused address may make a minute. */
export const JOBRUN_DOOR_LIMITS = { bodyMaxBytes: 64 * 1024, bodyReadMs: 10_000, sessionMinute: 120, refusedMinute: 30 } as const;

/** How many Jobs run on the Mac at once (T-1083: start at 2, 2 GiB each). */
export const JOBRUN_MAC_SLOTS = 2;

/** The setting that names the workspace whose Docker runs Mac Jobs (`<target>/<name>`). Empty: no Mac, every Job runs in the cluster. */
export const JOBRUN_MAC_WORKSPACE_SETTING = 'jobrun.macWorkspace';
/** The setting that lists the workspaces whose sessions may use the door. Empty: none (fail closed). */
export const JOBRUN_MAC_CLIENTS_SETTING = 'jobrun.macClients';

/** Why there is no Mac slot: job-run.sh shows it as `mac=no-slot reason=<x>`. */
export type JobRunNoSlot = 'no-mac' | 'mac-not-running' | 'mac-full' | 'no-runtime';

export type JobRunSlot = { slot: true; free: number } | { slot: false; reason: JobRunNoSlot };

/** One run on the Mac, as the door lists it. `where` is always `mac`: a door run never runs anywhere else. */
export interface JobRunMacRun {
  id: string;
  where: 'mac';
  chat: string | null;
  state: 'fetching' | 'running' | 'done';
  startedAt: string;
}
