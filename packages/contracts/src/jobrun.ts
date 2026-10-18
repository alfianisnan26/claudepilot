// The job-run Mac door (T-1083 S1b, D-84; docs/dev-session.md "Where"): `scripts/job-run.sh` asks the portal for a slot on the owner's Mac
// and runs a Job there through the Mac workspace's Docker. Its token is a `cpjr_` door token: minted by an admin for ONE workspace, accepted by
// `/jobrun/mac/*` only (never by `/mcp` or `/api`), hashed at rest, and the door's only key. Wire types shared by the server and the web.

/** A door token: `cpjr_` plus 43 base64url characters (256 random bits), stored only as a SHA-256 hash. */
export const JOBRUN_TOKEN_PREFIX = 'cpjr_';
/** A door token lives this long unless revoked first. */
export const JOBRUN_TOKEN_TTL_DAYS = 30;

/** The door's guards: the request body cap, the reads of a body, and the requests a token or a refused address may make a minute. */
export const JOBRUN_DOOR_LIMITS = { bodyMaxBytes: 64 * 1024, bodyReadMs: 10_000, tokenMinute: 120, refusedMinute: 30 } as const;

/** How many Jobs run on the Mac at once (T-1083: start at 2, 2 GiB each). */
export const JOBRUN_MAC_SLOTS = 2;

/** One door token as an admin sees it: never the secret. */
export interface JobRunTokenSummary {
  id: string;
  label: string;
  /** The workspace whose Docker runs the Jobs (`<target>/<name>`). */
  workspaceId: string;
  /** `cpjr_…3f9a`: enough to recognise it. */
  hint: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface JobRunTokenCreate {
  label: string;
  workspaceId: string;
}

/** The answer to a mint: the secret, shown once. */
export interface JobRunTokenCreated {
  token: JobRunTokenSummary;
  secret: string;
}

/** Why there is no Mac slot: shown by job-run.sh as `mac=no-slot reason=<x>`. */
export type JobRunNoSlot = 'mac-not-running' | 'mac-full' | 'no-runtime';

export type JobRunSlot = { slot: true; free: number } | { slot: false; reason: JobRunNoSlot };

/** One run on the Mac, as the door lists it. `where` is always `mac`: a door run never runs anywhere else. */
export interface JobRunMacRun {
  id: string;
  where: 'mac';
  chat: string | null;
  state: 'fetching' | 'running' | 'done';
  startedAt: string;
}
