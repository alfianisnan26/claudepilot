/**
 * Personas and instruction contexts (Persona pool PRD): what Claude is told and how a session starts.
 * A persona is a pool of type `persona` (one per workspace); an instruction context is a pool of type
 * `context` (several per workspace), a reusable fragment of instructions that can be assigned on its own
 * or held by personas (PRD A9). Both go through the shared pool API (`POOLS_API`). They hold no secrets,
 * so the API shows the content as stored. The server is the authority on every rule here; the editor
 * runs the same checks to say so before saving.
 */

/** FR5: `max` isn't a persona default (`effortLevel` refuses it; ultracode belongs to Settings & policies). */
export type PersonaEffort = 'low' | 'medium' | 'high' | 'xhigh';
export const PERSONA_EFFORTS: readonly PersonaEffort[] = ['low', 'medium', 'high', 'xhigh'];

/** FR3: an output style, which changes the system prompt itself (tone and format). */
export interface PersonaStyle {
  /** Letters, digits and hyphens, starting with a letter, at most 40 characters. */
  name: string;
  /** One line. */
  description: string;
  /** Keep Claude Code's own coding instructions in the system prompt (on by default). */
  keepCodingInstructions: boolean;
  body: string;
}

/** FR4: a subagent with its own prompt. Never carries `permissionMode`, `hooks`, `mcpServers` or `skills` (§6 rule 2). */
export interface PersonaAgent {
  /** Lowercase letters, digits and hyphens, starting with a letter, at most 40 characters. */
  name: string;
  /** Required: Claude reads it to decide when to use the agent. One line. */
  description: string;
  prompt: string;
  /** Empty inherits every tool. */
  tools: string[];
  disallowedTools: string[];
  /** `inherit`, an alias (`opus`, `sonnet`, `haiku`) or a model ID. Empty: Claude Code's default for subagents. */
  model: string;
  effort: PersonaEffort | null;
  maxTurns: number | null;
}

/** A persona revision's content (FR1). An empty persona is valid and changes nothing. */
export interface PersonaContent {
  /** Markdown, at most 100 KB, delivered as the managed CLAUDE.md: it adds to the repository's and the user's, never replaces them. */
  instructions: string;
  /** At most 5. */
  styles: PersonaStyle[];
  /** One of `styles`, or null: users keep choosing their own. */
  defaultStyle: string | null;
  /** At most 20. */
  agents: PersonaAgent[];
  /** The default model: an alias, a model ID, or null for Claude Code's own default. A starting point: users change it in a session. */
  model: string | null;
  effort: PersonaEffort | null;
  /** Appended to the system prompt of portal-run chat sessions only (FR6, P5: the session runner reads it). At most 32 KB. */
  chatPrompt: string;
  /** Instruction contexts the persona holds (pool IDs): delivered with it wherever it's assigned (PRD A9). */
  contexts: string[];
}

/** An instruction context's revision content (PRD A9). */
export interface ContextContent {
  /** Markdown, at most 20 KB, delivered as a managed rule file. */
  body: string;
}

export const PERSONA_LIMITS = {
  instructionsBytes: 100 * 1024,
  chatPromptBytes: 32 * 1024,
  styles: 5,
  agents: 20,
  contexts: 10,
  contextBytes: 20 * 1024,
  /** Everything a workspace gets from personas and contexts (the foundation's per-owner budget in the shared 1 MiB Secret). */
  compiledBytes: 256 * 1024,
  /** FR2: Claude Code's guidance per file. */
  instructionLinesWarn: 200,
  name: 40,
  description: 300,
} as const;

export const PERSONA_STYLE_NAME = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
export const PERSONA_AGENT_NAME = /^[a-z][a-z0-9-]{0,39}$/;
/** An alias or a model ID: `opus`, `sonnet[1m]`, `claude-sonnet-4-6`. */
export const PERSONA_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,99}$/;
/** A tool as an agent's `tools` line names it: `Read`, `Bash(npm test:*)`, `mcp__plugin_cpm-team_github__create_issue`. */
export const PERSONA_TOOL = /^[A-Za-z0-9_*.:-]{1,100}(?:\([^\n()]{0,100}\))?$/;

/** The rough size of a text for the editor's counter: about four characters per token (Claude Code's own rule of thumb). */
export const approxTokens = (text: string) => Math.ceil(text.length / 4);

/** An editor's empty persona. */
export const emptyPersona = (): PersonaContent => ({ instructions: '', styles: [], defaultStyle: null, agents: [], model: null, effort: null, chatPrompt: '', contexts: [] });

/** I5: what other parts of the portal (sessions, tickets) may read about a workspace's persona. Never secret: personas hold none. */
export interface WorkspacePersona {
  workspaceId: string;
  /** `avatar` is the image's address (I11), or null: the UI shows generated initials (`PersonaAvatar`). */
  persona: { poolId: string; name: string; revision: number; description: string; avatar: string | null } | null;
  /** The instruction contexts it gets: assigned to it directly, or held by its persona. */
  contexts: { poolId: string; name: string; revision: number; via: 'assigned' | 'persona' }[];
  /** What the persona sets: parts it carries, for a summary line ("48 lines · 2 styles · 3 subagents · opus, high"). */
  parts: { instructionLines: number; styles: string[]; defaultStyle: string | null; agents: string[]; model: string | null; effort: PersonaEffort | null; hasChatPrompt: boolean };
}

/* ---------- Identity, self-edit and proposals (I11) ---------- */

/** A persona's name and avatar as the rest of the portal shows them (chat headers and rows, ticket assignees). */
export interface PersonaIdentity {
  poolId: string;
  name: string;
  /** The avatar image's address (`PERSONAS_API.avatar`), or null: the UI shows generated initials. */
  avatar: string | null;
}

/**
 * Avatar limits (I11). An image is checked by its bytes, decoded and re-encoded as PNG, so what is stored and served
 * is never what was uploaded: no SVG, no animation, no metadata, at most `maxSide` pixels, always square.
 */
export const PERSONA_AVATAR = {
  /** What the portal reads of an upload or of a file in a workspace. */
  inputBytes: 3 * 1024 * 1024,
  /** What an agent may send inline, decoded. */
  inlineBytes: 192 * 1024,
  /** The most pixels the decoder is asked to open (a decompression-bomb guard). */
  inputPixels: 24_000_000,
  maxSide: 512,
  /** What the stored PNG may weigh. */
  outputBytes: 256 * 1024,
} as const;

/** A persona's own switches (I11); the editor sends them on their own, they are not part of a revision. */
export interface PersonaPolicy {
  /** Agents in a workspace with this persona may propose changes to it. Off by default. */
  agentsMayPropose: boolean;
  /** A proposed name or avatar is applied at once; instructions never are. Off by default. */
  autoApproveCosmetic: boolean;
  /** The portal-wide switch (`agents.selfEdit`); while it is off no proposal is accepted, whatever the persona says. */
  portalAllows: boolean;
  /** The persona is the one new workspaces start with (the create dialog preselects it). */
  isDefault: boolean;
  /** Its avatar's address, or null: initials. */
  avatar: string | null;
}

/** What a persona's card and the pickers show about it besides its revisions (`GET /api/personas/pools`). */
export interface PersonaPoolInfo {
  poolId: string;
  avatar: string | null;
  isDefault: boolean;
  agentsMayPropose: boolean;
  /** Proposals from agents waiting for a person. */
  pendingProposals: number;
}

export type PersonaProposalKind = 'name' | 'avatar' | 'instructions';
/** `stale`: the persona changed since (the name is taken, the text the edit named is gone); it can only be rejected. */
export type PersonaProposalStatus = 'pending' | 'approved' | 'rejected' | 'stale';

/** One thing a session asked to change about its own persona, waiting for a person (or already decided). */
export interface PersonaProposal {
  id: string;
  poolId: string;
  kind: PersonaProposalKind;
  status: PersonaProposalStatus;
  /** Who asked: `session:<id>`. */
  actor: string;
  workspaceId: string;
  /** The agent's own words, cleaned. Untrusted text. */
  reason: string;
  createdAt: string;
  decidedAt: string | null;
  /** `Admin`, or `auto` for a name or avatar the persona's switch applied. */
  decidedBy: string | null;
  /** The proposed name. */
  name: string | null;
  /** The proposed avatar's address. */
  avatar: string | null;
  /** The instructions as they are and as they would be, for the diff. */
  instructions: { before: string; after: string } | null;
  /** Why it can't be approved now (stale), or null. */
  problem: string | null;
}

/** What the persona tools take: the edits an agent may ask for in its instructions. */
export const PERSONA_PROPOSAL_LIMITS = {
  reasonChars: 500,
  /** The text an agent may add or replace in one proposal, in bytes. */
  instructionsBytes: 8 * 1024,
  edits: 5,
  /** Pending proposals per persona, so a looping agent can't bury the queue. */
  pendingPerPersona: 10,
  perHour: 10,
} as const;

/** `GET /api/personas/workspaces/:target/:name`. */
export const PERSONAS_API = {
  /** `/api/personas/workspaces/<target>/<name>` */
  workspace: (workspaceId: string) => `/api/personas/workspaces/${workspaceId}`,
  /** `GET`: every workspace's persona identity at once, for lists (`{ [workspaceId]: PersonaIdentity }`). */
  identities: '/api/personas/identities',
  /** `GET`: `PersonaPoolInfo` for every persona. */
  pools: '/api/personas/pools',
  /** `GET`/`PUT { poolId }`: the persona new workspaces start with. */
  default: '/api/personas/default',
  /** `GET`/`PUT`: one persona's self-edit switches and default flag. */
  policy: (poolId: string) => `/api/personas/pools/${poolId}/policy`,
  /** `POST` an image (the raw bytes) to set the avatar; `DELETE` to clear it. */
  avatarOf: (poolId: string) => `/api/personas/pools/${poolId}/avatar`,
  /** `GET`: the image, a PNG. Content-addressed, so it never changes. */
  avatar: (sha256: string) => `/api/personas/avatars/${sha256}`,
  /** `GET ?pool=<id>&status=pending`: proposals, newest first. */
  proposals: '/api/personas/proposals',
  decide: (id: string, verb: 'approve' | 'reject') => `/api/personas/proposals/${id}/${verb}`,
  /** `GET`: the revisions of a persona or context (no content), newest first, for the history. */
  revisions: (poolId: string) => `/api/personas/pools/${poolId}/revisions`,
  /** `GET`: one revision with its content, for a diff or a restore. */
  revision: (poolId: string, revision: number) => `/api/personas/pools/${poolId}/revisions/${revision}`,
} as const;
