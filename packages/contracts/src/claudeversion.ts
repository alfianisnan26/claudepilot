// Claude Code version pinning and the compatibility canary (docs/prd/claude-version-pinning.md).
//
// What this file holds, and the rules it encodes:
// - ONE registry of "feature -> the minimum Claude Code version" (`CLAUDE_FEATURES`), shared by the server (the places that degrade) and the web
//   (the warnings). Each entry says how its minimum is known. The scattered constants of the other areas are derived from it.
// - THE VERSION IS A FACT, NOT A GUESS: a workspace's `pinned` (what its image was built with) and `running` (what `claude --version` said inside it,
//   with the time) are shown side by side, and unknown stays unknown (null), never a guess.
// - PINNED MEANS PINNED: an exact x.y.z, never a range or "latest", in the build argument, the image tag and the image label.
// - UPGRADE IS EXPLICIT AND SAFE: a person picks a version, a canary runs first on a throwaway container from that version's image, only then
//   Apply recreates the workspace's container from the new tag KEEPING its home volume. Rollback is one action: the previous tag is kept.
// - The canary is DATA: each check is a definition here (`CLAUDE_CANARY_CHECKS`) with a runner on the server; other areas add a check by adding
//   a definition and a runner.
// - MULTI-USER (light touch): the registry, the canary schedule and the candidate report are PLATFORM-level (the platform area `version`); applying
//   an upgrade to ONE workspace needs manage rights on it. Every history row, canary run and audit entry carries an `actor` (the audit string).

/* ---------- Versions ---------- */

/** An exact version: three numbers, nothing else (no range, no `latest`, no `v`). */
export const CLAUDE_VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,5}$/;

export const isExactClaudeVersion = (v: unknown): v is string => typeof v === 'string' && CLAUDE_VERSION_PATTERN.test(v);

/** `2.1.296 (Claude Code)` → [2, 1, 296]; the first three-number version in the text, or null. */
export function parseClaudeVersion(text: string | null | undefined): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `2.1.296 (Claude Code)` → `2.1.296`; null when there is no version in the text. */
export function normalizeClaudeVersion(text: string | null | undefined): string | null {
  const v = parseClaudeVersion(text);
  return v ? v.join('.') : null;
}

/** Negative, zero or positive like a comparator; null when either side has no readable version. */
export function compareClaudeVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = parseClaudeVersion(a);
  const y = parseClaudeVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** Whether `have` is at least `need`; null when either is unknown (unknown is shown as unknown, never as fine or as too old). */
export function claudeVersionAtLeast(have: string | null | undefined, need: string): boolean | null {
  const c = compareClaudeVersions(have, need);
  return c === null ? null : c >= 0;
}

/* ---------- The default pin and the image tag scheme ---------- */

/**
 * THE default pin: the one place the version a new workspace gets is written. The image's build argument default
 * (`images/workspace/Dockerfile`, `ARG CLAUDE_CODE_VERSION`) must equal it; a test keeps them equal.
 */
export const DEFAULT_CLAUDE_CODE_VERSION = '2.1.296';

/** The repository of the workspace image on a Docker daemon (a registry prefix goes in front on Kubernetes and remote hosts). */
export const CLAUDE_IMAGE_REPO = 'claudepilot-workspace';

/** Labels the image and the container carry. The runtime is the record: the portal keeps no state about workspaces of its own. */
export const CLAUDE_LABELS = {
  /** On the image (a build label) and the container: the exact version the image installed. */
  version: 'claudepilot.claude-version',
  /** On the container: the image reference it was made from, as the portal asked for it. */
  image: 'claudepilot.image',
} as const;

/** The tag of an exact version: `cc-2.1.296`. Registry-safe, so Kubernetes and remote hosts pull the same tag. */
export const claudeImageTag = (version: string) => `cc-${version}`;

/** `claudepilot-workspace:cc-2.1.296`. */
export const claudeImageRef = (version: string, repo: string = CLAUDE_IMAGE_REPO) => `${repo}:${claudeImageTag(version)}`;

/** The version a `…:cc-x.y.z` reference names; null for any other tag (`latest`, an agent's own tag, an image id). */
export function claudeVersionOfImageRef(ref: string | null | undefined): string | null {
  const m = /:cc-(\d{1,4}\.\d{1,4}\.\d{1,5})$/.exec(ref ?? '');
  return m ? m[1]! : null;
}

/* ---------- The feature-minimum registry ---------- */

/**
 * How a minimum is known:
 * - `observed`: `needs` is the OLDEST version the feature was run on (a real Claude Code against a stand-in); the real minimum may be lower.
 * - `documented`: `needs` is the version the vendor's documentation or changelog states; not run by us on anything older.
 * - `unverified`: a claim nobody has checked (not used today).
 */
export type ClaudeFeatureBasis = 'observed' | 'documented' | 'unverified';

export type ClaudeFeatureId =
  | 'pool-delivery'
  | 'mcp-lockdown'
  | 'mcp-sets'
  | 'skillsets'
  | 'browser-pool'
  | 'usage-probe'
  | 'mcp-sign-in'
  | 'chat-protocol'
  | 'personas'
  | 'update-pin'
  | 'safe-mode';

export interface ClaudeFeature {
  id: ClaudeFeatureId;
  /** One or two words (text diet). */
  label: string;
  /** Exact x.y.z. */
  needs: string;
  basis: ClaudeFeatureBasis;
  /** Versions it was run on (basis `observed`): "tested" means one of these or a version whose canary passed. */
  observedOn: string[];
  /** What breaks below the minimum: one sentence, for an InfoTip. */
  why: string;
  /** Whether the portal itself degrades below the minimum (true), or only warns (false). */
  enforced: boolean;
  /** What the portal does below it, when `enforced`: the state a person sees. */
  degrades: string | null;
  /** Where the claim is written down: a PRD section or a documentation address. */
  source: string;
}

/**
 * The registry. Edit minimums here only; the server's older constants (`MCP_MIN_CLAUDE`, `MIN_CLAUDE_VERSION`, `BROWSER_MIN_CLAUDE`,
 * `SKILLSET_MIN_CLAUDE_VERSION`, the account pool's minimum) read it. Every `observed` entry names the version it was observed on.
 */
export const CLAUDE_FEATURES: readonly ClaudeFeature[] = [
  {
    id: 'pool-delivery',
    label: 'Pool delivery',
    needs: '2.1.296',
    basis: 'observed',
    observedOn: ['2.1.296'],
    why: 'Managed-settings drop-ins, live env reload and the key helper were observed on this version only.',
    enforced: true,
    degrades: 'The account pool is left out of the delivery, with the reason.',
    source: 'docs/prd/foundation-pools.md §9',
  },
  {
    id: 'mcp-lockdown',
    label: 'MCP lockdown',
    needs: '2.1.273',
    basis: 'documented',
    observedOn: ['2.1.296'],
    why: 'From this version the managed MCP allow and deny lists apply from any admin source, so the lockdown holds when the claude.ai organization pushes its own settings.',
    enforced: true,
    degrades: 'The workspace shows Not protected, with the version it needs.',
    source: 'docs/prd/portal-mcp.md (managed MCP), docs/prd/settings-policies.md §22',
  },
  {
    id: 'mcp-sets',
    label: 'MCP sets',
    needs: '2.1.296',
    basis: 'observed',
    observedOn: ['2.1.296'],
    why: 'Plugin-delivered MCP servers, the launcher and the layout of `claude plugin details` were observed on this version only.',
    enforced: true,
    degrades: 'Servers get the delivery state Claude Code too old; nothing is delivered for them.',
    source: 'docs/prd/mcpset-pool.md FR14',
  },
  {
    id: 'skillsets',
    label: 'Skillsets',
    needs: '2.1.296',
    basis: 'observed',
    observedOn: ['2.1.296'],
    why: 'Skills delivered as plugins, their verification and revocation were observed on this version only.',
    enforced: true,
    degrades: 'The skillset fragment is left out; the workspace row says Claude Code is too old for skillsets.',
    source: 'docs/prd/skillset-pool.md FR20',
  },
  {
    id: 'browser-pool',
    label: 'Browser',
    needs: '2.1.296',
    basis: 'observed',
    observedOn: ['2.1.296'],
    why: 'The browser plugin and its gate were observed on this version only.',
    enforced: true,
    degrades: 'The browser fragment is left out by the delivery engine, with the reason.',
    source: 'docs/prd/browser-desktop-pool.md',
  },
  {
    id: 'usage-probe',
    label: 'Plan usage',
    needs: '2.1.296',
    basis: 'observed',
    observedOn: ['2.1.296'],
    why: 'The `get_usage` control request and the `rate_limit_event` in the stream were observed on this version only.',
    enforced: false,
    degrades: null,
    source: 'docs/prd/claude-usage.md',
  },
  {
    id: 'mcp-sign-in',
    label: 'MCP sign-in',
    needs: '2.1.296',
    basis: 'observed',
    observedOn: ['2.1.296'],
    why: '`claude mcp login --no-browser`, the oauth fields of `.mcp.json` and `claude mcp get` were observed on this version only.',
    enforced: false,
    degrades: null,
    source: 'docs/prd/mcpset-pool.md §13.3',
  },
  {
    id: 'chat-protocol',
    label: 'Chat',
    needs: '2.1.296',
    basis: 'observed',
    observedOn: ['2.1.296'],
    why: 'The stream-json protocol the chat reader parses (init, assistant and user lines, the result, control requests) was observed on this version only.',
    enforced: false,
    degrades: null,
    source: 'docs/prd/chat-sessions.md',
  },
  {
    id: 'personas',
    label: 'Personas',
    needs: '2.1.296',
    basis: 'observed',
    observedOn: ['2.1.296'],
    why: 'Managed instructions, output styles and subagents were observed on this version only; older versions were not tried.',
    enforced: false,
    degrades: null,
    source: 'docs/prd/persona-pool.md §10',
  },
  {
    id: 'update-pin',
    label: 'Update pin',
    needs: '2.1.296',
    basis: 'observed',
    observedOn: ['2.1.296'],
    why: 'The DISABLE_AUTOUPDATER and DISABLE_UPDATES switches (also as a managed `env` entry) and the doctor line that reports them were observed on this version only.',
    enforced: false,
    degrades: null,
    source: 'docs/prd/claude-version-pinning.md §6',
  },
  {
    id: 'safe-mode',
    label: 'Safe mode',
    needs: '2.1.169',
    basis: 'documented',
    observedOn: ['2.1.287', '2.1.296'],
    why: 'The usage probe and side questions start Claude Code with `--safe-mode` so a person’s own hooks, skills and plugins never run in a poll or a one-shot. The flag came in 2.1.169; 2.1.168 answers “unknown option” (observed), and it is in the help of 2.1.287 and 2.1.296 (observed).',
    enforced: false,
    degrades: null,
    source: 'docs/prd/chat-sessions.md §20, docs/prd/claude-usage.md §11',
  },
];

export const claudeFeature = (id: ClaudeFeatureId): ClaudeFeature => {
  const f = CLAUDE_FEATURES.find((x) => x.id === id);
  if (!f) throw new Error(`No Claude Code feature “${id}” in the registry.`);
  return f;
};

/** The minimum version a feature needs. */
export const claudeMinimum = (id: ClaudeFeatureId): string => claudeFeature(id).needs;

/** A feature a version is below. */
export interface ClaudeBelowMinimum {
  feature: ClaudeFeatureId;
  label: string;
  needs: string;
  enforced: boolean;
}

/** The features `version` is below; empty when it meets them all or is unknown (an unknown version warns about nothing). */
export function claudeBelowMinimum(version: string | null | undefined): ClaudeBelowMinimum[] {
  if (!parseClaudeVersion(version)) return [];
  return CLAUDE_FEATURES.filter((f) => claudeVersionAtLeast(version, f.needs) === false).map((f) => ({ feature: f.id, label: f.label, needs: f.needs, enforced: f.enforced }));
}

/** Versions the lab ran on or whose canary passed: the registry's `observedOn` of every feature, deduplicated, oldest first. */
export function claudeObservedVersions(): string[] {
  const all = new Set(CLAUDE_FEATURES.flatMap((f) => f.observedOn));
  return [...all].sort((a, b) => compareClaudeVersions(a, b) ?? 0);
}

/* ---------- A workspace's version ---------- */

/** What looks wrong about a workspace's Claude Code (the chip shows a dot when there is any). */
export type ClaudeVersionFlag =
  /** `pinned` and `running` are both known and differ. */
  | 'differs'
  /** The running version is below a feature's minimum. */
  | 'below-minimum'
  /** Claude Code in the workspace may update itself (its auto-update switch is not off). */
  | 'auto-update-on'
  /** The running version was never tested: no canary passed on it and the lab never ran on it. */
  | 'untested';

/** What the workspace list carries (`Workspace.claude`): small, from caches, never a probe. */
export interface WorkspaceClaudeBrief {
  /** What its image was built with (the image label); null when the image carries none or the workspace has no image. */
  pinned: string | null;
  /** What `claude --version` last said inside it; null when unknown (stopped, not read yet, no Claude Code). */
  running: string | null;
  flags: ClaudeVersionFlag[];
}

export type ClaudeAutoUpdate = 'off' | 'on' | 'unknown';

/** What an upgrade or a rollback in flight says. */
export interface ClaudeOperation {
  id: string;
  workspaceId: string;
  kind: 'upgrade' | 'rollback';
  status: 'running' | 'done' | 'failed';
  /** The step it is on, or why it failed. */
  detail: string;
  from: string | null;
  to: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** `GET /api/workspaces/<id>/claude-version`: one workspace's version, in full. */
export interface ClaudeVersionInfo {
  workspaceId: string;
  pinned: string | null;
  running: string | null;
  /** The image reference its container was made from (the container's `claudepilot.image` label), when known. */
  imageTag: string | null;
  /** When `running` was read, ISO; null when it never was. */
  checkedAt: string | null;
  /** `pinned` and `running` both known, and different. */
  differs: boolean;
  autoUpdate: ClaudeAutoUpdate;
  belowMinimum: ClaudeBelowMinimum[];
  /** Whether a canary passed on `running` (or the lab ran on it); null when `running` is unknown. */
  tested: boolean | null;
  flags: ClaudeVersionFlag[];
  /** What Rollback would go back to; null when there is nothing to go back to. */
  previous: { version: string | null; image: string; at: string } | null;
  /** The target can recreate this workspace from another tag (Docker, Kubernetes); This machine cannot. */
  canRecreate: boolean;
  /** An upgrade or rollback running on it now. */
  operation: ClaudeOperation | null;
}

/** One change of a workspace's Claude Code (the small history Rollback reads). */
export interface ClaudeVersionHistoryEntry {
  id: number;
  at: string;
  workspaceId: string;
  /** `upgrade` to another version, `rollback` to the previous tag, `repin`: recreated on the same version (an image from before pinning, or a rebuilt tag). */
  kind: 'upgrade' | 'rollback' | 'repin';
  fromVersion: string | null;
  toVersion: string | null;
  fromImage: string;
  toImage: string;
  /** The canary run that cleared it; null for a rollback (it goes back to what ran before) and for an older tag. */
  canaryRunId: number | null;
  /** That run's result when it was applied: `pass`, `partial` (some skipped), `fail` (failed items were accepted), `none`. */
  canary: ClaudeCanaryVerdict | 'none';
  /** Failed items someone accepted by name. */
  accepted: string[];
  outcome: 'applied' | 'failed' | 'restored';
  detail: string | null;
  /** Who acted, as the audit string (`user:u_owner`, `portal-mcp:<token>`). */
  actor: string;
}

/* ---------- The canary ---------- */

/** Bump when a check is added or its meaning changes, so a report says whether two runs are comparable. */
export const CLAUDE_CANARY_SUITE = 1;

/** `pass`: every check passed. `partial`: none failed, some were skipped. `fail`: at least one failed. */
export type ClaudeCanaryVerdict = 'pass' | 'partial' | 'fail';

export type ClaudeCanaryCheckId =
  | 'version'
  | 'stream-turn'
  | 'control-requests'
  | 'get-usage'
  | 'rate-limit-event'
  | 'probe-safe-mode'
  | 'mcp-plugin-format'
  | 'mcp-login'
  | 'managed-settings'
  | 'plugin-details'
  | 'session-host'
  | 'btw-oneshot'
  | 'update-pin';

export interface ClaudeCanaryCheckDef {
  /** A string id so other areas can add checks (`ClaudeCanaryCheckId` is today's list). */
  id: string;
  /** One or two words. */
  label: string;
  /** The area that relies on the behaviour. */
  area: string;
  /** The registry features it exercises: a failure warns about these. */
  features: ClaudeFeatureId[];
  /** What it runs and what it asserts: the text behind an ⓘ. */
  what: string;
}

/** The checks, in the order they run (`update-pin` last: it asserts the version is unchanged after everything else ran). The server keeps one runner per id (a test keeps the two lists equal). */
export const CLAUDE_CANARY_CHECKS: readonly ClaudeCanaryCheckDef[] = [
  { id: 'version', label: 'Version', area: 'pin', features: ['update-pin'], what: '`claude --version` prints an exact x.y.z, and it is the version under test.' },
  {
    id: 'stream-turn',
    label: 'Stream',
    area: 'chat',
    features: ['chat-protocol'],
    what: 'A stream-json turn against the stand-in API: the init line, the assistant and user lines and the result with usage and cost, read by the portal’s own protocol reader.',
  },
  {
    id: 'control-requests',
    label: 'Controls',
    area: 'chat',
    features: ['chat-protocol'],
    what: 'The control requests the chat host sends: a tool permission asked and answered (allow and deny), `set_model` and `interrupt`.',
  },
  {
    id: 'get-usage',
    label: 'Usage',
    area: 'usage',
    features: ['usage-probe'],
    what: 'The `get_usage` control request answers with the plan windows, read by the usage parser, against a fake subscription login and the stand-in usage endpoint.',
  },
  {
    id: 'rate-limit-event',
    label: 'Rate limit',
    area: 'usage',
    features: ['usage-probe'],
    what: 'A turn whose response carries the unified rate-limit headers streams a `rate_limit_event` the usage parser reads.',
  },
  {
    id: 'probe-safe-mode',
    label: 'Probe safety',
    area: 'usage',
    features: ['usage-probe', 'safe-mode'],
    what: 'The usage probe’s own command passes `--safe-mode`; `claude --help` lists the flag; `get_usage` answers under it with the same plan and windows as without it; a SessionStart or SessionEnd hook in the Claude’s settings and in the project’s leaves no marker during a probe. As controls, the probe without the flag is shown to run them, and `CLAUDE_CODE_SAFE_MODE=1` alone is shown not to be a substitute (reported, not required).',
  },
  {
    id: 'mcp-plugin-format',
    label: 'MCP plugin',
    area: 'mcp',
    features: ['mcp-sets'],
    what: 'A plugin with an `.mcp.json` (an oauth scopes string, a headers helper, a stdio server) is listed by `claude mcp list` and the stdio server connects.',
  },
  {
    id: 'mcp-login',
    label: 'MCP sign-in',
    area: 'mcp',
    features: ['mcp-sign-in'],
    what: '`claude mcp login --no-browser` prints the authorization address and takes the pasted redirect, against the stand-in OAuth provider; the server then reads as signed in.',
  },
  {
    id: 'managed-settings',
    label: 'Managed settings',
    area: 'settings',
    features: ['pool-delivery', 'mcp-lockdown'],
    what: 'The managed drop-in folder is read, its `env` merges across files, a deny rule stops a tool call, and the MCP lockdown keys hide a server the user config names.',
  },
  {
    id: 'plugin-details',
    label: 'Plugin details',
    area: 'mcp',
    features: ['mcp-sets'],
    what: '`claude plugin details` prints the layout the MCP verification reads (the server count line), for a plugin in the portal’s marketplace.',
  },
  {
    id: 'session-host',
    label: 'Session host',
    area: 'chat',
    features: ['chat-protocol'],
    what: 'The portal’s session host (`cp-session`) starts a session with this Claude Code, a message produces a turn and an events file the portal reads.',
  },
  {
    id: 'btw-oneshot',
    label: 'Side question',
    area: 'chat',
    features: ['chat-protocol', 'safe-mode'],
    what: 'The tool-free one-shot run a side question (btw) uses: with `--tools "" --safe-mode --no-session-persistence` the init line lists no tools and no MCP servers, no model request offers a tool, no user hook runs, no session file is written, and the result carries the usage the portal records. Also observed, never failed: `/btw` as a stream-json line is answered locally, and the `side_question` control request.',
  },
  {
    id: 'update-pin',
    label: 'Update pin',
    area: 'pin',
    features: ['update-pin'],
    what: '`claude doctor` reports auto-updates off (with the environment variables removed too), `claude update` refuses, and the installed version is the same after all the other checks ran.',
  },
];

export type ClaudeCanaryStatus = 'pass' | 'fail' | 'skipped';

/** One check's outcome, with the real output behind it. */
export interface ClaudeCanaryResult {
  id: string;
  status: ClaudeCanaryStatus;
  durationMs: number;
  /** One line: what was seen, or why it failed or was skipped. */
  summary: string;
  /** The real output (the lines that matter), redacted and clipped to a few kilobytes. Untrusted text: never render as HTML. */
  detail: string;
}

/** What a run tests. `installed`: the version workspaces are made with. `candidate`: the registry's newest. `target`: a version a person picked. */
export type ClaudeCanarySubject = 'installed' | 'candidate' | 'target';

export type ClaudeCanaryTrigger = 'manual' | 'scheduled' | 'upgrade';

/**
 * How the version under test got into the throwaway container: `image` (the container is made from that version's image) or `scratch`
 * (the container is made from the installed image and the candidate Claude Code is installed beside it, in a scratch folder: no image is built).
 */
export type ClaudeCanaryMode = 'image' | 'scratch';

export type ClaudeCanaryRunStatus = 'running' | 'done' | 'error' | 'unavailable';

export interface ClaudeCanaryRun {
  id: number;
  trigger: ClaudeCanaryTrigger;
  subject: ClaudeCanarySubject;
  /** The exact version under test; null when it could not be determined (`unavailable`). */
  version: string | null;
  /** What `claude --version` printed in the container; differs from `version` only when the install did not give what was asked. */
  reported: string | null;
  image: string | null;
  mode: ClaudeCanaryMode;
  status: ClaudeCanaryRunStatus;
  /** What it is doing while `running`; why when `error` or `unavailable` (offline, the registry unreadable, no Docker). */
  note: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** `CLAUDE_CANARY_SUITE` when it ran. */
  suite: number;
  results: ClaudeCanaryResult[];
  pass: number;
  fail: number;
  skipped: number;
  /** Null until it has finished, or when there are no results. */
  verdict: ClaudeCanaryVerdict | null;
  /** Who started it, as the audit string (`user:u_owner`, `system:claude-canary` for the schedule). */
  actor: string;
}

/** One item of the report: how the installed version and the candidate did on it. */
export interface ClaudeCanaryItem {
  id: string;
  label: string;
  features: ClaudeFeatureId[];
  installed: ClaudeCanaryStatus | null;
  candidate: ClaudeCanaryStatus | null;
  /** Passes on the installed version, fails on the candidate. */
  breaks: boolean;
}

/**
 * The registry's newest version, read from the npm registry. `unavailable` says so plainly (offline, an error): never a guess.
 * `same`: it is what is installed. `newer`: a version beyond it exists. `older`: the installed one is beyond the registry's newest (a pre-release).
 */
export interface ClaudeCandidate {
  status: 'unavailable' | 'same' | 'newer' | 'older' | 'unknown';
  version: string | null;
  /** The registry's channels as it says them (`latest`, `stable`, `next`), when it was read. */
  channels: Record<string, string>;
  checkedAt: string | null;
  reason: string | null;
}

/** The scheduled canary's report: the installed version and the candidate, item by item. */
export interface ClaudeCanaryReport {
  installed: ClaudeCanaryRun | null;
  candidate: ClaudeCanaryRun | null;
  candidateInfo: ClaudeCandidate;
  items: ClaudeCanaryItem[];
  /** The items that pass on the installed version and fail on the candidate (the ids). */
  breaks: string[];
  /** Whether the two runs came from the same suite revision (a changed suite makes the comparison partial). */
  comparable: boolean;
}

/* ---------- Images ---------- */

export interface ClaudeImage {
  /** The target whose daemon holds it (the default target when a request names none). */
  target?: string;
  /** `claudepilot-workspace:cc-2.1.296`. */
  ref: string;
  version: string | null;
  builtAt: string | null;
  sizeBytes: number | null;
  /** The workspaces whose container was made from it now. */
  usedBy: string[];
  /** The workspaces whose Rollback goes back to it. */
  rollbackFor: string[];
  /** The image new workspaces get. */
  isDefault: boolean;
  /** The last canary run on this version. */
  canary: { runId: number; at: string; verdict: ClaudeCanaryVerdict } | null;
}

export interface ClaudeImagePruneResult {
  /** True when nothing was removed (a dry run). */
  dryRun: boolean;
  removed: string[];
  /** What stays, and why (`used by docker/api`, `default`, `rollback for docker/api`). */
  kept: { ref: string; why: string }[];
}

/* ---------- Upgrade, apply and rollback ---------- */

/** `GET /api/workspaces/<id>/claude-version/plan?version=`: what Apply would do, and what stands in the way. */
export interface ClaudeUpgradePlan {
  workspaceId: string;
  from: string | null;
  to: string;
  imageRef: string;
  /** The image exists on the workspace's target. */
  imageReady: boolean;
  /** The newest canary run on `to` (any trigger), with its failed items named; null when none ran. */
  canary: { runId: number; at: string; verdict: ClaudeCanaryVerdict | null; failed: string[]; stale: boolean } | null;
  /** Chat sessions that are running and would be interrupted (only the ones the asker may see). */
  sessions: { id: string; title: string }[];
  /** Running sessions the asker may not see (another user's private ones): counted, never named. */
  hiddenSessions?: number;
  /** Terminals that would close. */
  terminals: number;
  /** What a recreate does not keep, in plain words (software installed outside the home folder, running processes). */
  willLose: string[];
  /** Apply is allowed as the request stands; false lists `blockers`. */
  appliable: boolean;
  blockers: string[];
}

export interface ClaudeApplyRequest {
  /** The exact version to move to. */
  version: string;
  /** The canary run that cleared it (from the plan); the server re-checks that it is green and recent. */
  canaryRunId?: number | null;
  /** The failed checks the person accepts, by id; Apply is refused while any other check failed. */
  acceptFailed?: string[];
  /** The confirmation that names the running sessions: required when any session or terminal is running. */
  confirm?: boolean;
}

export interface ClaudeRollbackRequest {
  confirm?: boolean;
}

export interface ClaudeBuildRequest {
  version: string;
  /** Which target builds it; the default target when absent. */
  target?: string;
}

export interface ClaudeCanaryRequest {
  /** `target` needs `version`; `installed` and `candidate` ignore it. */
  subject: ClaudeCanarySubject;
  version?: string;
  /** Which target runs it; the default target when absent. */
  target?: string;
}

export interface ClaudeDefaultRequest {
  version: string;
}

export interface ClaudeImagePruneRequest {
  /** Refs to remove; absent: every unused image that is not the default and not a rollback target. */
  refs?: string[];
  dryRun?: boolean;
  /** Which target's images; the default target when absent. */
  target?: string;
}

/* ---------- Warnings ---------- */

export type ClaudeWarningKind =
  /** The candidate fails something the installed version passes. */
  | 'candidate-breaks'
  /** The installed version fails a check. */
  | 'installed-fails'
  | 'below-minimum'
  | 'pin-differs'
  | 'auto-update-on';

export interface ClaudeVersionWarning {
  /** Stable for the same finding, so a page and a notification agree it is the same one. */
  id: string;
  kind: ClaudeWarningKind;
  severity: 'info' | 'attention' | 'urgent';
  /** One or two words. */
  title: string;
  /** The words behind an ⓘ: which items, which version, which workspace. */
  detail: string;
  workspaceId: string | null;
  version: string | null;
  at: string;
}

/* ---------- The overview ---------- */

export interface ClaudeSchedule {
  /** Days between scheduled canaries; 0 is off. */
  everyDays: number;
  lastAt: string | null;
  nextAt: string | null;
  /** A canary is running now. */
  running: boolean;
}

/** `GET /api/claude-version`: the platform's view. */
export interface ClaudeVersionOverview {
  /** The version new workspaces get now, and the built-in default it falls back to. */
  defaultVersion: string;
  builtInDefault: string;
  /** What the default image carries (its label); null while it is not built or has no label. */
  installed: string | null;
  schedule: ClaudeSchedule;
  report: ClaudeCanaryReport;
  images: ClaudeImage[];
  warnings: ClaudeVersionWarning[];
  /** Targets that can recreate a workspace from another tag. */
  recreateTargets: string[];
}

/** Settings this module defines (the shared settings store, `GET/PUT /api/settings`). */
export const CLAUDE_SETTING_KEYS = {
  /** Number of days between scheduled canaries; 0 turns it off. Default 7. */
  canaryDays: 'claude.canaryDays',
} as const;

export const CLAUDE_CANARY_DEFAULT_DAYS = 7;

/* ---------- Routes ---------- */

export const CLAUDE_VERSION_API = {
  /** GET `ClaudeVersionOverview`. */
  overview: '/api/claude-version',
  /** GET the registry (`ClaudeFeature[]`) and the canary's check definitions. */
  features: '/api/claude-version/features',
  checks: '/api/claude-version/checks',
  /** GET `ClaudeVersionWarning[]`. */
  warnings: '/api/claude-version/warnings',
  /** GET every workspace's `ClaudeVersionInfo`, keyed by workspace id. */
  workspaces: '/api/claude-version/workspaces',
  /** GET the candidate (cached); POST reads the registry again. */
  candidate: '/api/claude-version/candidate',
  /** GET the runs (`?limit=`), newest first; POST `ClaudeCanaryRequest` starts one (202, `ClaudeCanaryRun`). */
  canary: '/api/claude-version/canary',
  canaryRun: (id: number | string) => `/api/claude-version/canary/${id}`,
  /** GET `ClaudeImage[]`; POST `ClaudeBuildRequest` builds a version's image (202). */
  images: '/api/claude-version/images',
  /** POST `ClaudeImagePruneRequest`. */
  imagesPrune: '/api/claude-version/images/prune',
  /** PUT `ClaudeDefaultRequest`: the version new workspaces get. */
  defaultVersion: '/api/claude-version/default',
  /** GET `ClaudeVersionInfo` with its history. */
  workspace: (id: string) => `/api/workspaces/${id}/claude-version`,
  /** GET `ClaudeUpgradePlan` (`?version=`). */
  plan: (id: string) => `/api/workspaces/${id}/claude-version/plan`,
  /** POST `ClaudeApplyRequest` (202, `ClaudeOperation`). */
  apply: (id: string) => `/api/workspaces/${id}/claude-version/apply`,
  /** POST `ClaudeRollbackRequest` (202, `ClaudeOperation`). */
  rollback: (id: string) => `/api/workspaces/${id}/claude-version/rollback`,
  /** GET `ClaudeVersionHistoryEntry[]`, newest first. */
  history: (id: string) => `/api/workspaces/${id}/claude-version/history`,
} as const;

/** `GET /api/workspaces/<id>/claude-version`. */
export interface ClaudeWorkspaceVersion {
  info: ClaudeVersionInfo;
  history: ClaudeVersionHistoryEntry[];
}
