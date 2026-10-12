// Workspace git (docs/prd/workspace-git.md): the git repositories inside a workspace, found by scanning (no registration), each tracked
// on its own, with the worktrees that belong to them, an event log for audit, and a summary for monitoring. Everything that came out of a
// workspace (branch names, subjects, authors, paths, remote URLs) is untrusted text: the server validates and clips it, and a page
// shows it as plain text, never as markup or a link target it didn't build itself.

/**
 * What a git working folder is to the portal.
 * `repo`: a repository of its own. `submodule`: one the superproject above it records (a gitlink). `worktree`: a linked worktree of another
 * repository (`git worktree add`), the portal's own session worktrees included. `nested`: a repository inside another one's folder that
 * the outer one doesn't record (a pool of sibling clones under a parent). `missing`: declared in a `.gitmodules` but not cloned.
 */
export type RepoKind = 'repo' | 'submodule' | 'worktree' | 'nested' | 'missing';

export const REPO_KINDS: readonly RepoKind[] = ['repo', 'submodule', 'worktree', 'nested', 'missing'];

export interface RepoRemote {
  name: string;
  /** The fetch URL with credentials, query and fragment removed. */
  url: string;
  /** The push URL when it differs, cleaned the same way. */
  pushUrl: string | null;
  /** The workspace-local remote (local-git-ci) this remote points at, by its name; null for any other. */
  local: string | null;
}

export interface RepoHead {
  /** Full commit id. */
  sha: string;
  /** The commit's subject, clipped. */
  subject: string;
  /** Commit time, ISO 8601 (UTC). */
  at: string | null;
  author: string | null;
}

export interface RepoUpstream {
  /** The branch it follows, as git names it (`origin/main`). */
  name: string;
  /** Commits here and not there; null when the upstream is gone or not known. */
  ahead: number | null;
  /** Commits there and not here. */
  behind: number | null;
  /** The upstream branch no longer exists (deleted on the remote, or never fetched). */
  gone: boolean;
}

/** Counts, never file names: staged and unstaged count files (one file can be in both), conflicted files are in neither. */
export interface RepoChanges {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

/** What a repository is in the middle of. */
export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

/** What one read-only look at a repository found. */
export interface RepoState {
  /** The branch checked out; null when HEAD is detached or has no commit yet. */
  branch: string | null;
  detached: boolean;
  /** A new repository: HEAD names a branch that has no commit. */
  unborn: boolean;
  head: RepoHead | null;
  /** Null when the branch follows nothing. */
  upstream: RepoUpstream | null;
  changes: RepoChanges;
  stash: number;
  /** Commits on no remote branch (counted up to 1000); null when the repository has no remote at all. */
  unpushed: number | null;
  remotes: RepoRemote[];
  operation: RepoOperation | null;
  /** Clean/smudge filters the repository configures. The portal never runs a repository's filters, so files they rewrite can read as changed. */
  filters: number;
  /** When a fetch last wrote FETCH_HEAD; null when none did. */
  fetchedAt: string | null;
}

/** Why a repository is on the attention list, worst first (the order of `REPO_ATTENTION_ORDER`). */
export type RepoAttention = 'error' | 'conflicted' | 'operation' | 'diverged' | 'behind' | 'unpushed' | 'dirty' | 'detached' | 'drift' | 'missing';

export const REPO_ATTENTION_ORDER: readonly RepoAttention[] = ['error', 'conflicted', 'operation', 'diverged', 'behind', 'unpushed', 'dirty', 'detached', 'drift', 'missing'];

/** Short words for the reasons (a chip or a tooltip says no more). */
export const REPO_ATTENTION_LABEL: Record<RepoAttention, string> = {
  error: 'Unreadable',
  conflicted: 'Conflicts',
  operation: 'Mid-operation',
  diverged: 'Diverged',
  behind: 'Behind',
  unpushed: 'Unpushed',
  dirty: 'Changes',
  detached: 'Detached',
  drift: 'Submodule drift',
  missing: 'Not cloned',
};

export type RepoSyncOutcome = 'updated' | 'current' | 'refused' | 'failed';

/** A chat that runs in a repository or worktree (its folder is that one, or inside it). */
export interface RepoSession {
  id: string;
  /** Clipped; typed by a person or an agent. */
  title: string;
  /** The chat's state (`idle`, `running`, `ended`, ...). */
  state: string;
  /** Its process is alive. */
  live: boolean;
}

/** One repository, submodule, worktree or not-cloned submodule in a workspace's tree. */
export interface RepoNode {
  /** Stable while the folder stays where it is: `r_` and 12 hex characters of the workspace and the folder's real path. */
  id: string;
  workspaceId: string;
  /** The working folder's real path; for a not-cloned submodule, where it would be. */
  path: string;
  /** The folder's name; for a submodule, its path inside the superproject. */
  name: string;
  kind: RepoKind;
  /** The superproject, the enclosing repository, or the repository a worktree belongs to; null at the top. */
  parentId: string | null;
  /** How many parents are above it (indent by this). */
  depth: number;
  /** For a worktree: the repository it belongs to (set even when that one is outside the scanned folders and so not in the tree). */
  mainId: string | null;
  /** Null for a not-cloned submodule, and for a repository that couldn't be read (see `error`). */
  state: RepoState | null;
  /** A short fixed code when the last read failed: `timeout`, `unreadable`, `not_a_repository`, `unsafe`. */
  error: string | null;
  /** Worktrees only. */
  worktree: { locked: boolean; prunable: boolean } | null;
  /** Submodules and not-cloned ones: what the superproject records. */
  submodule: { recorded: string | null; url: string | null; drifted: boolean } | null;
  /** A superproject: how many of its cloned submodules are checked out at a commit other than the recorded one. */
  drifted: number;
  /** Chats running here, live ones first, at most three. */
  sessions: RepoSession[];
  /** "Keep synced" (fast-forward only, when clean) and the last sync's outcome; null where it doesn't apply. */
  sync: { enabled: boolean; at: string | null; outcome: RepoSyncOutcome | null; note: string | null } | null;
  attention: { score: number; reasons: RepoAttention[] };
  firstSeenAt: string;
  /** When this was last read. */
  scannedAt: string;
}

/** Counts over a set of nodes. A repository counts once per condition; `missing` and `drifted` are in submodules' terms. */
export interface RepoSummary {
  /** Repositories, submodules, worktrees and nested ones that were read (not-cloned ones are in `missing`). */
  repos: number;
  worktrees: number;
  dirty: number;
  ahead: number;
  behind: number;
  diverged: number;
  detached: number;
  /** With commits on no remote branch. */
  unpushed: number;
  conflicted: number;
  /** Not-cloned submodules. */
  missing: number;
  /** Submodules checked out at a commit other than the recorded one. */
  drifted: number;
  /** Unreadable. */
  errors: number;
  /** On the attention list. */
  attention: number;
}

/** What the last scan of a workspace did. */
export interface RepoScanInfo {
  /** When it ended; null when the workspace was never scanned. */
  at: string | null;
  ms: number | null;
  /** A short sentence (safe text) when it failed or found only part; null when it was fine. */
  error: string | null;
  /** A limit (depth, count or time) stopped it short: some repositories may be missing. */
  truncated: boolean;
  running: boolean;
  /** The next automatic scan; null when they are off or the workspace isn't running. */
  nextAt: string | null;
}

export interface RepoSettings {
  /** The folders to scan, relative to the home folder (`work`) or absolute under it; null: the default ones. */
  roots: string[] | null;
  /** What `null` means. */
  defaultRoots: string[];
  /** Scan on a timer while the workspace runs (a scan at start and around chats, and on request, always works). */
  auto: boolean;
}

/** `GET REPOS_API.workspace`: a workspace's repositories as a tree (parents first, each followed by its children). */
export interface WorkspaceRepos {
  workspaceId: string;
  running: boolean;
  scan: RepoScanInfo;
  settings: RepoSettings;
  summary: RepoSummary;
  repos: RepoNode[];
}

export interface RepoWorkspaceSummary {
  workspaceId: string;
  name: string;
  running: boolean;
  scannedAt: string | null;
  summary: RepoSummary;
}

/** `GET REPOS_API.overview`: every workspace's summary, for the list's chips, and the repositories that need a look first. */
export interface ReposOverview {
  total: RepoSummary;
  workspaces: RepoWorkspaceSummary[];
  /** Worst first, at most 30, across all workspaces. */
  attention: RepoNode[];
}

/** What the log records. The first group is what scans notice; the second is what the portal did when asked (audit). */
export const REPO_EVENT_KINDS = [
  'discovered',
  'removed',
  'branch_changed',
  'head_moved',
  'dirty',
  'clean',
  'conflicted',
  'diverged',
  'worktree_added',
  'worktree_removed',
  'drift',
  'aligned',
  'scan_failed',
  'scan_requested',
  'worktree_created',
  'worktree_deleted',
  'sync',
  'sync_setting',
  'settings',
] as const;
export type RepoEventKind = (typeof REPO_EVENT_KINDS)[number];

export const REPO_EVENT_LABEL: Record<RepoEventKind, string> = {
  discovered: 'Found',
  removed: 'Gone',
  branch_changed: 'Branch',
  head_moved: 'Commits',
  dirty: 'Changes',
  clean: 'Clean',
  conflicted: 'Conflicts',
  diverged: 'Diverged',
  worktree_added: 'Worktree added',
  worktree_removed: 'Worktree gone',
  drift: 'Drift',
  aligned: 'Aligned',
  scan_failed: 'Scan failed',
  scan_requested: 'Scan',
  worktree_created: 'Worktree made',
  worktree_deleted: 'Worktree removed',
  sync: 'Sync',
  sync_setting: 'Keep synced',
  settings: 'Settings',
};

/** The kinds a person or an agent asked for through the portal (the audit of its own actions). */
export const REPO_AUDIT_KINDS: readonly RepoEventKind[] = ['scan_requested', 'worktree_created', 'worktree_deleted', 'sync', 'sync_setting', 'settings'];

/** The details of an event; which are set depends on its kind. Text is clipped and redacted. */
export interface RepoEventData {
  /** `branch_changed`: the branch names (null: detached). `head_moved`: short commit ids. */
  from?: string | null;
  to?: string | null;
  /** The full commit ids behind `from` and `to`. */
  fromSha?: string | null;
  toSha?: string | null;
  /** `head_moved`: how many new commits, who wrote them (names only, at most 5) and their subjects (at most 5, clipped). */
  commits?: number;
  authors?: string[];
  subjects?: string[];
  /** `head_moved`: the new HEAD descends from the old one (null: the old commit isn't in the repository any more). */
  fastForward?: boolean | null;
  ahead?: number;
  behind?: number;
  staged?: number;
  unstaged?: number;
  untracked?: number;
  conflicted?: number;
  /** A worktree's or a submodule's path, or `settings`' folder. */
  path?: string;
  branch?: string;
  sha?: string;
  recorded?: string;
  checkedOut?: string | null;
  kind?: RepoKind;
  /** `discovered` by the first scan of a workspace. */
  initial?: boolean;
  /** `sync`: what happened; `sync_setting`: the new setting. */
  outcome?: RepoSyncOutcome;
  enabled?: boolean;
  /** `worktree_deleted` and `worktree_removed`. */
  forced?: boolean;
  branchDeleted?: boolean;
  /** A fixed code or one short sentence. */
  error?: string;
  /** Chats that were in the repository meanwhile when more than one could have made the change. */
  sessions?: string[];
  /** `scan_requested`: the repository asked about (null: the whole workspace). */
  repoId?: string | null;
  roots?: string[] | null;
  auto?: boolean;
}

export interface RepoEvent {
  /** Increasing; also the cursor for `RepoEventQuery.before`. A number, as text. */
  id: string;
  at: string;
  workspaceId: string;
  repoId: string | null;
  /** The repository's name when it happened. */
  repo: string | null;
  kind: RepoEventKind;
  /** Who: `ui` (a person), `session:<id>`, `ticket:<id>`, `portal-mcp:<token id>`, `portal:<what>` (the portal on its own timer), or `workspace` (it changed inside the workspace and nothing the portal started explains it). */
  actor: string;
  /** The chat that was in the repository when it changed (the only one that could have), or that did the action. */
  sessionId: string | null;
  /** One short line, ready to show. */
  summary: string;
  data: RepoEventData;
}

/** `GET REPOS_API.events` as a query string. */
export interface RepoEventQuery {
  workspaceId?: string;
  repoId?: string;
  /** One kind, or several separated by commas. */
  kind?: string;
  /** `audit`: only what the portal did when asked (`REPO_AUDIT_KINDS`). */
  group?: 'audit';
  /** Events older than this cursor (an event's `id`). */
  before?: string;
  /** 1 to 200, default 50. */
  limit?: number;
}

export interface RepoEventPage {
  events: RepoEvent[];
  /** Pass as `before` for the next page; null at the end. */
  next: string | null;
}

/** `GET REPOS_API.one`: a repository with what hangs off it and its latest events. */
export interface RepoDetail {
  repo: RepoNode;
  /** Its direct children: submodules, nested repositories, worktrees, not-cloned submodules. */
  children: RepoNode[];
  /** The latest 20; `REPOS_API.events` pages through the rest. */
  events: RepoEvent[];
}

/** `POST REPOS_API.workspaceScan`. Without `repoId` the whole workspace; with it, that repository and what hangs off it. */
export interface ScanReposRequest {
  repoId?: string;
}

/** `POST REPOS_API.worktrees`: a worktree of the repository, made by the session host's hardened git. */
export interface CreateRepoWorktreeRequest {
  /** A new branch, or an existing one no other worktree has. Default: `wt/<6 hex>`. */
  branch?: string;
  /** What a new branch starts from: a branch, tag or commit. Default: the repository's HEAD. */
  base?: string;
  /** Also turn "keep synced" on. */
  sync?: boolean;
}

export interface CreateRepoWorktreeResult {
  worktree: RepoNode;
  branch: string;
  /** The commit the branch is at. */
  commit: string;
}

/** `DELETE REPOS_API.worktree`, `?mode=safe` (default: refused with 409 `WORKTREE_DIRTY` when it has changes) or `force`. */
export interface RemoveRepoWorktreeResult {
  /** Its branch was merged, so it went with the folder; otherwise it stays. */
  branchDeleted: boolean;
}

/** `PUT REPOS_API.sync`. */
export interface SetRepoSyncRequest {
  enabled: boolean;
}

/** `POST REPOS_API.sync`: fetch, then fast-forward when that's all it takes and nothing is lost. Never merges, rebases, stashes or resets. */
export interface RepoSyncResult {
  outcome: RepoSyncOutcome;
  from: string | null;
  to: string | null;
  ahead: number | null;
  behind: number | null;
  /** Why it was refused or failed (one short sentence); null otherwise. */
  note: string | null;
  repo: RepoNode;
}

/** `PUT REPOS_API.workspaceSettings`. */
export interface UpdateRepoSettingsRequest {
  /** Folders to scan, relative to the home folder or absolute under it; null: the defaults. */
  roots?: string[] | null;
  auto?: boolean;
}

export const REPO_ROOTS_MAX = 8;
export const REPO_PATH_MAX = 300;
export const REPO_EVENT_RETENTION_DAYS = 90;

/** `workspaceId` is `<target>/<name>`, as everywhere. All behind the session guard, mutations with the Origin check. */
export const REPOS_API = {
  /** GET: `ReposOverview`. */
  overview: '/api/repos',
  /** GET `RepoEventQuery`: `RepoEventPage`. */
  events: '/api/repos/events',
  /** GET: `RepoDetail`. */
  one: (id: string) => `/api/repos/${encodeURIComponent(id)}`,
  /** POST: read it again (and what hangs off it): the `RepoNode`. */
  scan: (id: string) => `/api/repos/${encodeURIComponent(id)}/scan`,
  /** POST `CreateRepoWorktreeRequest`: `CreateRepoWorktreeResult`. */
  worktrees: (id: string) => `/api/repos/${encodeURIComponent(id)}/worktrees`,
  /** DELETE `?mode=safe|force`: `RemoveRepoWorktreeResult`; the repository must be a worktree that no chat which hasn't ended uses. */
  worktree: (id: string) => `/api/repos/${encodeURIComponent(id)}/worktree`,
  /** PUT `SetRepoSyncRequest`: the `RepoNode` (worktrees only). POST: sync now, `RepoSyncResult`. */
  sync: (id: string) => `/api/repos/${encodeURIComponent(id)}/sync`,
  /** GET: `WorkspaceRepos`. */
  workspace: (workspaceId: string) => `/api/workspaces/${workspaceId}/repos`,
  /** POST `ScanReposRequest`: scan now, `WorkspaceRepos`. It waits for the scan up to about 20 s; when the scan is still going (`scan.running`) the `repos` live topic says when it ends. 409 when the workspace isn't running. */
  workspaceScan: (workspaceId: string) => `/api/workspaces/${workspaceId}/repos/scan`,
  /** GET: `RepoSettings`. PUT `UpdateRepoSettingsRequest`: `RepoSettings`. */
  workspaceSettings: (workspaceId: string) => `/api/workspaces/${workspaceId}/repos/settings`,
} as const;
