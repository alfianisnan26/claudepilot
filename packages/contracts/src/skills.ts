/**
 * Skillsets (Skillset PRD): the skill library (imported, reviewed skill versions), the skillset pool
 * type's content, and what a workspace has. Skillsets themselves are multi-assignment pools of type
 * `skillset` (`POOLS_API`); everything else lives under `/api/skills`.
 */

import { claudeMinimum } from './claudeversion.js';

/** Claude Code version skillsets need (Skillset FR20): the one the M1 sandbox verified. Below it nothing is delivered. From the feature-minimum registry. */
export const SKILLSET_MIN_CLAUDE_VERSION = claudeMinimum('skillsets');

/** Upload limits (Skillset FR1). */
export const SKILL_UPLOAD_LIMITS = {
  /** Uncompressed bytes in one upload. */
  bytes: 30 * 1024 * 1024,
  files: 5000,
  /** Largest uncompressed : compressed ratio a zip may claim. */
  ratio: 100,
  /** How deep skill folders, plugins and marketplaces are looked for. */
  depth: 4,
} as const;

/** A skill's description plus `when_to_use` beyond this is cut off in Claude Code's listing (FR5). */
export const SKILL_LISTING_CAP = 1536;
/** Listing budget without a known context window: 8,000 characters (Skillset §12). */
export const SKILL_LISTING_BUDGET = 8000;
/** A file viewer page (Skillset §13). */
export const SKILL_FILE_PAGE_LINES = 500;

export type SkillSourceKind = 'upload' | 'git' | 'anthropic' | 'marketplace';
export type SkillRisk = 'low' | 'medium' | 'high';
export type SkillFindingTier = 'high' | 'medium' | 'low';
/** The latest review decision for a version's tree hash decides (§9); none yet is `needs_review`. */
export type SkillReviewState = 'needs_review' | 'approved' | 'rejected' | 'revoked';
export type SkillFileKind = 'skill_md' | 'markdown' | 'text' | 'script' | 'asset';

/** What the scanner looks for (Skillset §11.1). */
export type SkillFindingCode =
  | 'executable'
  | 'injected_command'
  | 'hooks'
  | 'broad_allowed_tools'
  | 'mcp_reference'
  | 'network'
  | 'credential'
  | 'instruction_manipulation'
  | 'outside_paths'
  | 'writes_skill_dir'
  | 'fork_context'
  | 'dense_file'
  | 'spec';

export interface SkillFinding {
  /** Stable for the same content: `<code>:<file>:<line>`. Acknowledgements name it. */
  id: string;
  tier: SkillFindingTier;
  code: SkillFindingCode;
  /** One plain sentence. */
  title: string;
  /** Path inside the skill, or null for the skill as a whole. */
  file: string | null;
  /** 1-based, or null for a whole file. */
  line: number | null;
  /** The matching text, cut short, credentials masked. */
  excerpt: string | null;
  /** High findings the reviewer must tick before approving; credentials can never be acknowledged. */
  needsAck: boolean;
}

export interface SkillFileInfo {
  path: string;
  size: number;
  /** 0o644, or 0o755 when the review marks it executable. */
  mode: number;
  kind: SkillFileKind;
  /** `bash`, `python3`, `node`, … for scripts. */
  interpreter: string | null;
  /** Not UTF-8 text: shown as size only, never as content. */
  binary: boolean;
}

/** What an agent's skill proposal may hold, and how many may wait for a person (Skillset FR-P, interface I11). */
export const SKILL_PROPOSAL_LIMITS = {
  /** `SKILL.md` as the portal writes it, frontmatter included. */
  skillMdBytes: 16 * 1024,
  /** Extra text files beside it (scripts, references). */
  files: 8,
  fileBytes: 32 * 1024,
  totalBytes: 96 * 1024,
  descriptionChars: 1024,
  reasonChars: 500,
  /** Proposals waiting for review: per proposer, per workspace, and in all. */
  waitingPerActor: 5,
  waitingPerWorkspace: 15,
  waitingTotal: 40,
} as const;

/** A skill version that arrived as a proposal (an agent's or a token's) rather than an import. */
export interface SkillProposalInfo {
  /** `session:<id>` or `portal-mcp:<token id>`. */
  actor: string;
  /** The workspace it was proposed for: verified from the agent's token, never from what the agent said. */
  workspaceId: string | null;
  /** The proposer's own words, plain text. */
  reason: string;
  /** The skill it changes, as the proposer names it. */
  replaces: string | null;
  at: string;
}

export interface SkillVersionSummary {
  id: string;
  name: string;
  description: string;
  sourceId: string;
  sourceLabel: string;
  sourceKind: SkillSourceKind;
  /** Where it sat in the upload or repository. */
  pathInSource: string;
  /** Skillset FR6 tree hash. */
  treeHash: string;
  license: string | null;
  sizeBytes: number;
  fileCount: number;
  scripted: boolean;
  risk: SkillRisk;
  /** Badges for the library row. */
  network: boolean;
  hooks: boolean;
  review: SkillReviewState;
  reviewedAt: string | null;
  /** Skillsets whose newest or current revision lists it. */
  sets: number;
  /** Name + description + `when_to_use` in the listing, capped (Skillset §12). */
  listingChars: number;
  /** Has `allowed-tools`, so a set can remove the pre-approval (FR13). */
  allowedTools: boolean;
  /** A command file converted to a skill: its old command, e.g. `/frontend:component`. */
  convertedFrom: string | null;
  importedAt: string;
  /** Set when an agent or a token proposed it: it waits for a person like any import, and says who asked. */
  proposal: SkillProposalInfo | null;
}

export interface SkillReviewRecord {
  decision: 'approved' | 'rejected' | 'revoked';
  note: string;
  /** Finding IDs the reviewer ticked. */
  acknowledged: string[];
  licenseConfirmed: boolean;
  /** Short hash of the signed-in session that decided (one shared admin sign-in, Q6). */
  session: string | null;
  at: string;
}

export interface SkillVersionDetail extends SkillVersionSummary {
  files: SkillFileInfo[];
  findings: SkillFinding[];
  /** SKILL.md frontmatter as parsed. */
  frontmatter: Record<string, unknown>;
  /** Declared requirements (frontmatter and files such as requirements.txt), for the image to provide. */
  requirements: string[];
  licenseFiles: string[];
  /** The license is a recognized open-source one; otherwise approving needs `licenseConfirmed`. */
  openSourceLicense: boolean;
  /** Newest first. */
  reviews: SkillReviewRecord[];
  /** Skillsets that list it, with the revisions that do. */
  inSets: { poolId: string; poolName: string; revisions: number[] }[];
}

export interface SkillSourceSummary {
  id: string;
  kind: SkillSourceKind;
  label: string;
  url: string | null;
  ref: string | null;
  resolved: string | null;
  createdAt: string;
  checkedAt: string | null;
  versions: number;
}

/** `GET /api/skills/library`. */
export interface SkillLibrary {
  versions: SkillVersionSummary[];
  /** Sources not removed. */
  sources: SkillSourceSummary[];
  /** Versions waiting for a decision. */
  toReview: number;
  minClaudeVersion: string;
}

/** One skill an import found. */
export interface SkillImportItem {
  name: string;
  versionId: string;
  treeHash: string;
  /** `existing`: the same content was imported before, so its version and review are reused (FR6). */
  status: 'new' | 'existing';
  review: SkillReviewState;
  scripted: boolean;
  findings: { high: number; medium: number; low: number };
  /** For command files: the command before and after (`/frontend:component` → `/<prefix>:frontend-component`). */
  command: { from: string; to: string } | null;
  warnings: string[];
}

/** `POST /api/skills/import`. */
export interface SkillImportResult {
  sourceId: string | null;
  skills: SkillImportItem[];
  /** Skills that can't be imported (FR5), with why. */
  refused: { path: string; reason: string }[];
  /** Plugin parts a skillset doesn't carry (hooks, agents, MCP servers, …) (§4). */
  notImported: { path: string; reason: string }[];
}

/** `GET /api/skills/versions/:id/file?path=…&offset=…`: one page of a file. */
export interface SkillFileContent {
  path: string;
  size: number;
  binary: boolean;
  totalLines: number;
  /** 0-based line the page starts at. */
  offset: number;
  /** Credentials masked. */
  lines: string[];
}

/** `POST /api/skills/versions/:id/review`. */
export interface SkillReviewRequest {
  decision: 'approved' | 'rejected';
  note?: string;
  /** Every High finding that `needsAck` must be listed to approve. */
  acknowledged?: string[];
  /** Needed to approve a skill without a recognized open-source license. */
  licenseConfirmed?: boolean;
}

/** `POST /api/skills/versions/:id/revoke`. */
export interface SkillRevokeRequest {
  note: string;
}

/* ---------- The skillset pool type ---------- */

/** Per skill in a set (FR13): as authored, only when typed (`/name`), or not delivered. */
export type SkillsetMode = 'on' | 'manual' | 'off';

export interface SkillsetEntry {
  versionId: string;
  mode: SkillsetMode;
  /** Removes `allowed-tools` (pre-approval only; injected commands still need review). */
  stripAllowedTools: boolean;
}

/** A skillset revision's content as the editor sends it (`PoolRequest.content`). */
export interface SkillsetContent {
  /** The plugin name: commands are `/<prefix>:<skill>`. */
  prefix: string;
  skills: SkillsetEntry[];
}

/** As the API shows each entry: the version's facts alongside the choice. */
export interface SkillsetEntryView extends SkillsetEntry {
  name: string;
  description: string;
  treeHash: string;
  scripted: boolean;
  risk: SkillRisk;
  review: SkillReviewState;
  allowedTools: boolean;
  listingChars: number;
  /** The version no longer exists (its source was removed with its versions). */
  missing?: boolean;
}

export interface SkillsetContentView {
  prefix: string;
  skills: SkillsetEntryView[];
}

/** Prefixes `claude plugin validate` refuses and those other pool types own (FR12, foundation §7). */
export const SKILLSET_RESERVED_PREFIXES = ['claude-', 'anthropic-', 'anthropics-', 'cc-plugin-', 'cpm-', 'cpp-', 'cpb-'] as const;
/** Names Claude Code reserves for its own plugins. */
export const SKILLSET_RESERVED_NAMES = ['claude', 'anthropic', 'anthropics', 'claude-code', 'claude-mods'] as const;
export const SKILLSET_PREFIX_MAX = 40;

/** Why a skillset prefix can't be used, or null. The portal checks it again, and uniqueness too. */
export function skillsetPrefixProblem(prefix: string): string | null {
  if (!prefix) return 'Give it a prefix.';
  if (prefix.length > SKILLSET_PREFIX_MAX) return `Use at most ${SKILLSET_PREFIX_MAX} characters.`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(prefix)) return 'Lowercase letters, digits and single dashes, like “frontend” or “team-tools”.';
  const reserved = SKILLSET_RESERVED_PREFIXES.find((p) => prefix.startsWith(p));
  if (reserved) return `Prefixes can’t start with “${reserved}”: Claude Code or another pool type uses it.`;
  if ((SKILLSET_RESERVED_NAMES as readonly string[]).includes(prefix) || /(?:claude|anthropic)-?official|official-?(?:claude|anthropic)/.test(prefix))
    return 'Claude Code reserves that name.';
  return null;
}

/* ---------- A workspace's skills ---------- */

/** FR21 results, plus `pending` before the first check of a new delivery. */
export type SkillVerifyStatus = 'verified' | 'mismatch' | 'error' | 'not_verified' | 'pending';

export interface WorkspaceSkill {
  name: string;
  /** `/<prefix>:<name>`. */
  command: string;
  mode: SkillsetMode;
  scripted: boolean;
  /** Short tree hash. */
  hash: string;
}

export interface WorkspaceSkillset {
  poolId: string;
  poolName: string;
  /** The revision the workspace gets; 0 when none is deliverable yet. */
  revision: number;
  prefix: string;
  status: SkillVerifyStatus;
  /** Claude Code's own message for a load error, or what didn't match. */
  message: string | null;
  skills: WorkspaceSkill[];
  /** Skills left out of the delivery, with why (not approved, revoked, files missing). */
  leftOut: { name: string; reason: string }[];
  /** Commands blocked after a revocation (Skill deny rules, 14 days). */
  blocked: { command: string; until: string }[];
}

/** `GET /api/skills/workspaces/:target/:name`: the Configuration panel's Skills row (FR24). */
export interface WorkspaceSkills {
  workspaceId: string;
  minClaudeVersion: string;
  claudeVersion: string | null;
  /** Below `minClaudeVersion`: skillsets are left out (FR20). */
  tooOld: boolean;
  sets: WorkspaceSkillset[];
  /** The last verification (FR21), or null before the first. */
  verification: { status: SkillVerifyStatus; at: string; detail: string | null } | null;
  /** When the delivered skills last changed, for "Run /reload-plugins in open sessions" (§10.4). */
  changedAt: string | null;
}

export const SKILLS_API = {
  library: '/api/skills/library',
  import: '/api/skills/import',
  version: (id: string) => `/api/skills/versions/${id}`,
  file: (id: string, path: string, offset = 0) => `/api/skills/versions/${id}/file?path=${encodeURIComponent(path)}&offset=${offset}`,
  review: (id: string) => `/api/skills/versions/${id}/review`,
  revoke: (id: string) => `/api/skills/versions/${id}/revoke`,
  /** `DELETE`; `?versions=1` removes its versions too (refused while a set lists one). */
  source: (id: string, withVersions = false) => `/api/skills/sources/${id}${withVersions ? '?versions=1' : ''}`,
  workspace: (workspaceId: string) => `/api/skills/workspaces/${workspaceId}`,
  /** `POST`: check the workspace's skills again now. */
  verify: (workspaceId: string) => `/api/skills/workspaces/${workspaceId}/verify`,
} as const;
