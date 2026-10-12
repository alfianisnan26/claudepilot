// Knowledge: vaults of plain Markdown notes, search, history and the graphs (Knowledge PRD, docs/prd/knowledge-graph.md).
// Wire types for the routes under `/api/knowledge`. A note's path is always a query parameter.

/** What agents may do in a vault (PRD FR24). */
export type AgentPolicy = 'off' | 'read' | 'write-own' | 'write';
export const AGENT_POLICIES: readonly AgentPolicy[] = ['off', 'read', 'write-own', 'write'];

/** `vault`: a folder the portal made. `folder`: a directory the operator allowed, read-only unless they said otherwise. */
export type VaultKind = 'vault' | 'folder';

export interface VaultSettings {
  /** Where pasted and uploaded attachments go ('' is the vault root). */
  attachmentsFolder: string;
  /** Renaming a note rewrites the links to it in other notes (Obsidian's default). */
  rewriteLinksOnRename: boolean;
  /** What notes are called in lists and the graph: their file name, or their first heading. */
  labels: 'filename' | 'heading';
}

export interface VaultCounts {
  notes: number;
  /** Attachments. */
  files: number;
  folders: number;
  tags: number;
  unresolved: number;
  bytes: number;
}

export interface VaultSummary {
  id: string;
  name: string;
  kind: VaultKind;
  readOnly: boolean;
  agents: AgentPolicy;
  dailyFolder: string;
  timezone: string;
  settings: VaultSettings;
  counts: VaultCounts;
  /** The newest file change in the vault. */
  lastChangeAt: string | null;
  /** Notes written or edited by agents in the last 7 days (changes, not notes). */
  agentWrites7d: number;
  /** `scanning` while the index is being brought up to date; lists may be partial until it is `ready`. */
  indexState: 'scanning' | 'ready';
  /** Why the vault can't be opened (a folder source whose folder is gone or no longer allowed), or null. */
  problem: string | null;
  scannedAt: string | null;
  /** For a folder source: the operator's name for the folder and the subfolder. */
  source: { root: string; sub: string } | null;
  /** Where a vault's files are, on the portal machine (for people who open the folder in Obsidian). */
  location: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVaultRequest {
  /** Required for a vault; a folder source is named for its folder when this is left out. */
  name?: string;
  agents?: AgentPolicy;
  dailyFolder?: string;
  timezone?: string;
  /** A folder source instead of a new vault: one of `GET /sources`' roots and an optional subfolder. */
  source?: { root: string; sub?: string };
}

export interface UpdateVaultRequest {
  name?: string;
  agents?: AgentPolicy;
  dailyFolder?: string;
  timezone?: string;
  settings?: Partial<VaultSettings>;
}

/** A folder an operator allowed as a source (`PORTAL_KNOWLEDGE_ROOTS`). */
export interface KnowledgeSource {
  name: string;
  writable: boolean;
}

export interface VaultTreeEntry {
  kind: 'folder' | 'note' | 'file';
  /** The file or folder's own name (a note's without `.md`). */
  name: string;
  path: string;
  /** Folder: files under it. */
  count?: number;
  size?: number;
  mtime?: string;
  /** Note: its first heading or `title`, for vaults that label by heading. */
  title?: string | null;
  /** Note: only agents have ever written it. */
  agent?: boolean;
}

export interface VaultTree {
  folder: string;
  entries: VaultTreeEntry[];
}

export interface NoteLink {
  style: 'wiki' | 'md';
  embed: boolean;
  /** As written, without heading and block ('' for a link into the same note). */
  target: string;
  heading: string | null;
  block: string | null;
  alias: string | null;
  /** `[[ticket:T-12]]`: a link to a portal entity. */
  entity: { type: string; key: string } | null;
  line: number;
  /** The path it resolves to, or null (unresolved, or an entity). */
  to: string | null;
  ambiguous: boolean;
  /** The note exists but not the heading or block the link names. */
  anchorMissing: boolean;
}

export interface NoteAuthor {
  /** Who made the newest change: `ui`, `portal-mcp:<token>`, `session:<id>`, `external` ... */
  actor: string;
  kind: 'user' | 'agent' | 'system' | 'external';
  at: string;
}

export interface NoteView {
  vaultId: string;
  path: string;
  /** The file name without `.md`. */
  name: string;
  folder: string;
  /** First heading or `title`. */
  title: string | null;
  content: string;
  /** The version to send back with a change (a hash of the file's bytes). */
  version: string;
  size: number;
  mtime: string;
  /** `bodyOffset`: where the text after the frontmatter block starts in `content`. */
  frontmatter: { raw: string | null; props: Record<string, unknown>; error: string | null; bodyOffset: number };
  tags: string[];
  aliases: string[];
  headings: { level: number; text: string; line: number }[];
  links: NoteLink[];
  backlinkCount: number;
  /** The newest change in history, when the portal has one. */
  author: NoteAuthor | null;
  /** Only agents have ever written it. */
  agentOnly: boolean;
  /** The text contains something shaped like a credential. */
  secretShaped: boolean;
  readOnly: boolean;
}

export interface WriteNoteRequest {
  content: string;
  /** Required to change an existing note. */
  baseVersion?: string;
  /** Fail when the note exists instead of replacing it. */
  create?: boolean;
}

export interface WriteNoteResult {
  path: string;
  version: string;
  created: boolean;
  unchanged: boolean;
  size: number;
  warnings: string[];
}

/** The details of a 409 `CONFLICT` on a note write. */
export interface NoteConflict {
  reason: 'CONFLICT' | 'EXISTS';
  currentVersion: string | null;
  content: string | null;
  deleted: boolean;
}

export interface AppendNoteRequest {
  text: string;
  /** Append under this heading (made if missing). */
  heading?: string;
}

export interface RenameNoteRequest {
  from: string;
  to: string;
  /** Default: the vault's setting. */
  rewriteLinks?: boolean;
}

export interface RenameNoteResult {
  path: string;
  /** Other notes whose links were rewritten. */
  rewritten: string[];
}

export interface NoteHistoryEntry {
  id: number;
  at: string;
  op: 'create' | 'edit' | 'append' | 'rename' | 'delete' | 'restore' | 'import' | 'sync' | 'external';
  actor: string;
  actorKind: 'user' | 'agent' | 'system' | 'external';
  size: number;
  /** A short note: "original", "restored the version of ...", "link to X updated". */
  note: string;
  fromPath: string | null;
  /** The version has text to show or restore (not a delete or a rename). */
  hasContent: boolean;
}

export interface NoteHistory {
  path: string;
  entries: NoteHistoryEntry[];
}

export interface NoteVersion {
  entry: NoteHistoryEntry;
  content: string | null;
  /** The text before this change, when the portal has it, for showing differences. */
  previous: string | null;
}

export interface NoteSearchHit {
  path: string;
  name: string;
  title: string | null;
  folder: string;
  tags: string[];
  /** A piece of the text around the match, and where the matched words are in it. */
  snippet: { text: string; marks: [number, number][] } | null;
  mtime: string;
  agent: boolean;
}

export interface NoteSearchResult {
  hits: NoteSearchHit[];
  total: number;
  tookMs: number;
}

export interface NoteQuickHit {
  path: string;
  name: string;
  kind: 'note' | 'file';
  alias: string | null;
}

export interface VaultTagCount {
  tag: string;
  count: number;
}

export interface NoteBacklink {
  path: string;
  name: string;
  line: number;
  embed: boolean;
}

export interface NoteMention {
  path: string;
  name: string;
}

export interface VaultHealthGroup {
  target: string;
  count: number;
  sources: string[];
}

export interface VaultHealth {
  unresolved: VaultHealthGroup[];
  ambiguous: VaultHealthGroup[];
  anchors: { path: string; target: string; heading: string | null; block: string | null; line: number }[];
  embeds: { path: string; target: string; line: number }[];
  orphans: string[];
  duplicates: { name: string; paths: string[] }[];
  issues: { path: string; kind: string; detail: string }[];
}

export interface VaultDaily {
  date: string;
  path: string;
  exists: boolean;
  /** Only when it exists. */
  note: NoteView | null;
}

export interface DailyAppendRequest {
  text: string;
  date?: string;
  /** Prefix the entry with the time (default true). */
  time?: boolean;
}

export type VaultImportPolicy = 'skip' | 'keep-both' | 'overwrite';

export interface VaultImportSkip {
  reason: 'hidden' | 'not-allowed' | 'dangerous' | 'symlink' | 'too-large' | 'not-text' | 'invalid-name' | 'duplicate';
  count: number;
  examples: string[];
}

export interface VaultImportReport {
  vaultId: string;
  vaultName: string;
  /** A new vault was made for this import. */
  created: boolean;
  notes: number;
  attachments: number;
  renamed: number;
  overwritten: number;
  skippedExisting: number;
  skipped: VaultImportSkip[];
  /** Things worth knowing: names that can't be linked with [[ ]], a wrapper folder removed, the daily-notes folder adopted. */
  warnings: string[];
  ms: number;
}

export interface VaultActivityEntry {
  at: string;
  actor: string;
  op: string;
  path: string | null;
  outcome: string;
  detail: string;
}

export const KNOWLEDGE_API = {
  sources: '/api/knowledge/sources',
  vaults: '/api/knowledge/vaults',
  vault: (id: string) => `/api/knowledge/vaults/${encodeURIComponent(id)}`,
  importZip: '/api/knowledge/vaults/import',
  exportZip: (id: string) => `/api/knowledge/vaults/${encodeURIComponent(id)}/export`,
  tree: (id: string, folder = '') => `/api/knowledge/vaults/${encodeURIComponent(id)}/tree?folder=${encodeURIComponent(folder)}`,
  note: (id: string, path: string) => `/api/knowledge/vaults/${encodeURIComponent(id)}/note?path=${encodeURIComponent(path)}`,
  noteAction: (id: string, action: string, path = '') => `/api/knowledge/vaults/${encodeURIComponent(id)}/note/${action}${path ? `?path=${encodeURIComponent(path)}` : ''}`,
  embed: (id: string, path: string, heading?: string | null, block?: string | null) =>
    `/api/knowledge/vaults/${encodeURIComponent(id)}/embed?path=${encodeURIComponent(path)}${heading ? `&heading=${encodeURIComponent(heading)}` : ''}${block ? `&block=${encodeURIComponent(block)}` : ''}`,
  file: (id: string, path: string) => `/api/knowledge/vaults/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
  search: (id: string, q: string, extra = '') => `/api/knowledge/vaults/${encodeURIComponent(id)}/search?q=${encodeURIComponent(q)}${extra}`,
  quick: (id: string, q: string) => `/api/knowledge/vaults/${encodeURIComponent(id)}/quick?q=${encodeURIComponent(q)}`,
  tags: (id: string) => `/api/knowledge/vaults/${encodeURIComponent(id)}/tags`,
  health: (id: string) => `/api/knowledge/vaults/${encodeURIComponent(id)}/health`,
  recent: (id: string) => `/api/knowledge/vaults/${encodeURIComponent(id)}/recent`,
  daily: (id: string, date = '') => `/api/knowledge/vaults/${encodeURIComponent(id)}/daily${date ? `?date=${encodeURIComponent(date)}` : ''}`,
  activity: (id: string) => `/api/knowledge/vaults/${encodeURIComponent(id)}/activity`,
  rescan: (id: string) => `/api/knowledge/vaults/${encodeURIComponent(id)}/rescan`,
} as const;


/* ---------- Graphs (PRD §12): one node and edge model, three lenses ---------- */

/** `docs`: notes and how they link. `context`: which sessions and tickets read or wrote which notes. `agentic`: the portal's own entities. */
export type GraphLens = 'docs' | 'context' | 'agentic';
export const GRAPH_LENSES: readonly GraphLens[] = ['docs', 'context', 'agentic'];

export type GraphNodeKind =
  | 'note'
  | 'tag'
  | 'attachment'
  | 'unresolved'
  | 'session'
  | 'ticket'
  | 'workspace'
  | 'claude'
  | 'persona'
  | 'skillset'
  | 'mcpset'
  | 'context'
  | 'worktree'
  | 'actor'
  | 'cluster';

export const GRAPH_NODE_KINDS: readonly GraphNodeKind[] = ['note', 'tag', 'attachment', 'unresolved', 'session', 'ticket', 'workspace', 'claude', 'persona', 'skillset', 'mcpset', 'context', 'worktree', 'actor', 'cluster'];

export type GraphEdgeKind =
  | 'links-to'
  | 'embeds'
  | 'tagged'
  | 'read'
  | 'created'
  | 'edited'
  | 'appended'
  | 'deleted'
  | 'runs-in'
  | 'runs-as'
  | 'spawned-by'
  | 'assigned-to'
  | 'works-in'
  | 'uses'
  | 'mentions'
  | 'belongs-to';

export interface GraphNode {
  /** `<kind>:<key>`: `note:<vault>:<path>`, `session:<id>`, `ticket:T-12`, `workspace:docker/dev`, `tag:<vault>:<tag>`. */
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** What it clusters with and is coloured by: a note's top folder, an entity's state. */
  group: string;
  /** Links in the whole graph (before any cap), for sizing. */
  degree: number;
  /** Where the portal opens it; null when it has no page. */
  href: string | null;
  /** A note's vault and path (also in `id`). */
  vault?: string;
  path?: string;
  /** A cluster: how many nodes it stands for. */
  count?: number;
  /** The last time it was touched, when known. */
  at?: string | null;
  /** State worth a colour: a session's or a ticket's. */
  state?: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  /** How many links or touches it stands for. */
  weight: number;
  at?: string | null;
}

export interface GraphQuery {
  lens: GraphLens;
  /** docs: the vault (required). context: limit to one vault. */
  vault?: string;
  /** A node id to build the graph around (a "local graph"), with `depth` steps. */
  around?: string;
  depth?: number;
  /** docs: only notes in this folder, or with this tag. */
  folder?: string;
  tag?: string;
  /** docs: also draw tags, unresolved links and attachments; leave out notes nothing links to or from. */
  tags?: boolean;
  unresolved?: boolean;
  attachments?: boolean;
  hideOrphans?: boolean;
  /** context: how far back (`24h`, `7d`, `30d`), and which kinds of touch (`read`, `write`). */
  since?: string;
  access?: 'read' | 'write';
  /** agentic: which kinds of node to draw. */
  kinds?: GraphNodeKind[];
  /** Most nodes to send; over it the most connected stay and the rest fold into one node per folder or kind. */
  cap?: number;
}

export interface GraphResponse {
  lens: GraphLens;
  center: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Nodes were folded or left out to stay within the cap. */
  truncated: boolean;
  /** What the whole graph has, before the cap. */
  totals: { nodes: number; edges: number };
  /** One short line saying what was cut ("Showing 1,500 of 10,214 notes: the most linked"). */
  message: string | null;
}

export const GRAPH_API = {
  graph: (q: GraphQuery) => {
    const p = new URLSearchParams({ lens: q.lens });
    for (const [k, v] of Object.entries(q)) {
      if (k === 'lens' || v === undefined || v === null || v === '' || v === false) continue;
      p.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return `/api/knowledge/graph?${p.toString()}`;
  },
} as const;

export * from './knowledgeLayout.js';
