// Local git and CI/CD: every number the PRD names (docs/prd/local-git-ci.md §11.5), in one place. No imports:
// the runner script that runs inside workspaces is bundled from code that includes this file.

const KiB = 1024;
const MiB = 1024 * KiB;
const MINUTE = 60_000;

export const CI_LIMITS = {
  /** Remotes one workspace may host. */
  reposPerWorkspace: 20,
  /** `.pilot/*.yml` files read per commit, and the size of each. */
  pipelineFiles: 20,
  pipelineFileBytes: 128 * KiB,
  /** The context pack (`docs/context-pack.md`, T-292) a snapshot reads: an instruction context's cap (PERSONA_LIMITS.contextBytes). */
  contextPackBytes: 20 * KiB,
  /** How deep a YAML file may nest, and how many aliases (`*name`) it may use. */
  yamlDepth: 40,
  yamlAliases: 20,
  jobs: 50,
  stepsPerJob: 100,
  matrixCombinations: 25,
  /** Ref updates one push may turn into events, and events one poll returns. */
  eventsPerPush: 50,
  eventsPerPoll: 100,
  /** Runs waiting for a slot in one workspace; a newer event is dropped beyond this. */
  queuedPerWorkspace: 20,
  /** Timeouts: what a job and a run get when the file says nothing, and the most any may be. */
  jobTimeoutMs: 30 * MINUTE,
  runTimeoutMs: 60 * MINUTE,
  maxTimeoutMs: 6 * 60 * MINUTE,
  /** A run needs this much free space on the workspace's volume to start. */
  freeDiskBytes: 512 * MiB,
  /** A step's log, and a whole run's, in the workspace; past it output is dropped. */
  stepLogBytes: 16 * MiB,
  runLogBytes: 64 * MiB,
  /** What the portal keeps of a finished run's logs: per step the head and the tail, and in all. */
  archiveHeadBytes: 64 * KiB,
  archiveTailBytes: 192 * KiB,
  archiveRunBytes: 2 * MiB,
  /** One live read of a log. */
  logChunkBytes: 64 * KiB,
  /** Artifacts: files per job, bytes per file, bytes per run, and how long they are kept. */
  artifactFiles: 100,
  artifactFileBytes: 32 * MiB,
  artifactRunBytes: 128 * MiB,
  artifactExpireDays: 14,
  /** How long finished runs' folders and acknowledged events stay in the workspace. */
  runDirDays: 14,
  eventDays: 7,
  /** What the portal keeps: run records, event records, and runs per workspace. */
  runRecordDays: 30,
  eventRecordDays: 14,
  runRecordsPerWorkspace: 300,
  /** Seconds between polls of a workspace that has work pending, and of one that is idle. */
  pollActiveMs: 5_000,
  pollIdleMs: 15_000,
  /** A failed run is told to its session at most this often (per ticket, or per session without one). */
  messagesPerHour: 3,
  messagesPerDay: 10,
  /** After this many failed runs of one branch within the window, no more messages until one passes. */
  failuresToPause: 3,
  pauseWindowMs: 30 * MINUTE,
  /** A step is killed this long after the polite signal. */
  killGraceMs: 5_000,
} as const;
