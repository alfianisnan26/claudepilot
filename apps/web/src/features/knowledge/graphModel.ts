// Knowledge: what the graph views share (Knowledge PRD §12, §16): colours and shapes for nodes, the filters a person
// sets and the query they make, and the list the graph is also shown as. Nothing here touches the DOM.

import type { GraphLens, GraphNode, GraphNodeKind, GraphQuery } from '@portal/contracts';

export const LENS_LABEL: Record<GraphLens, string> = { docs: 'Docs', context: 'Context', agentic: 'Agents' };

/** One line for the ⓘ beside the lens switch. */
export const LENS_HELP: Record<GraphLens, string> = {
  docs: 'How notes link to each other, with tags and files when you ask for them.',
  context: 'Which sessions, tickets and tokens read or wrote which notes lately.',
  agentic: 'Workspaces, sessions, tickets and Claudes, and the notes that mention them.',
};

export const KIND_LABEL: Record<GraphNodeKind, string> = {
  note: 'Note',
  tag: 'Tag',
  attachment: 'File',
  unresolved: 'Missing note',
  session: 'Session',
  ticket: 'Ticket',
  workspace: 'Workspace',
  claude: 'Claude',
  persona: 'Persona',
  skillset: 'Skills',
  mcpset: 'MCP',
  context: 'Context',
  worktree: 'Worktree',
  actor: 'Token',
  cluster: 'Group',
};

/** The kinds the agents lens can be narrowed to, in the order the filter lists them. */
export const AGENT_KINDS: { value: GraphNodeKind; label: string }[] = [
  { value: 'session', label: 'Sessions' },
  { value: 'ticket', label: 'Tickets' },
  { value: 'workspace', label: 'Workspaces' },
  { value: 'claude', label: 'Claudes' },
  { value: 'worktree', label: 'Worktrees' },
  { value: 'persona', label: 'Personas' },
  { value: 'skillset', label: 'Skills' },
  { value: 'mcpset', label: 'MCP' },
  { value: 'context', label: 'Contexts' },
  { value: 'note', label: 'Notes' },
];

export type Shape = 'circle' | 'diamond' | 'square' | 'ring';

export const shapeOf = (kind: GraphNodeKind): Shape => {
  switch (kind) {
    case 'tag':
      return 'diamond';
    case 'unresolved':
    case 'cluster':
      return 'ring';
    case 'note':
    case 'attachment':
      return 'circle';
    default:
      return 'square';
  }
};

// One colour per folder (and per kind of thing that isn't a note), light and dark.
const FOLDER_LIGHT = ['#d9583f', '#d98a1f', '#b99f12', '#4f9e3e', '#239a82', '#2a7fbf', '#5463cf', '#8a52c9', '#bf4aa3', '#80705f'];
const FOLDER_DARK = ['#f08a76', '#f0b35a', '#e0cb4f', '#82cc72', '#5cc9b3', '#63a9e6', '#8793f0', '#b48df0', '#e382c8', '#b3a393'];
const KIND_LIGHT: Partial<Record<GraphNodeKind, string>> = {
  tag: '#8a52c9',
  attachment: '#80705f',
  unresolved: '#8b8b8b',
  session: '#2a7fbf',
  ticket: '#d98a1f',
  workspace: '#239a82',
  claude: '#d9583f',
  persona: '#bf4aa3',
  skillset: '#4f9e3e',
  mcpset: '#5463cf',
  context: '#b99f12',
  worktree: '#80705f',
  actor: '#6a7a8a',
};
const KIND_DARK: Partial<Record<GraphNodeKind, string>> = {
  tag: '#b48df0',
  attachment: '#b3a393',
  unresolved: '#9a9a9a',
  session: '#63a9e6',
  ticket: '#f0b35a',
  workspace: '#5cc9b3',
  claude: '#f08a76',
  persona: '#e382c8',
  skillset: '#82cc72',
  mcpset: '#8793f0',
  context: '#e0cb4f',
  worktree: '#b3a393',
  actor: '#9aaabb',
};

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A node's colour: its folder's for a note, its kind's for anything else. A group takes the colour of what it folds. */
export function colorOf(n: Pick<GraphNode, 'kind' | 'group'>, dark: boolean): string {
  const kinds = dark ? KIND_DARK : KIND_LIGHT;
  const neutral = dark ? '#9aa3ad' : '#6b7580';
  const kind: GraphNodeKind = n.kind === 'cluster' ? (n.group in kinds ? (n.group as GraphNodeKind) : 'note') : n.kind;
  if (kind === 'note') {
    const palette = dark ? FOLDER_DARK : FOLDER_LIGHT;
    return n.group ? palette[hashString(n.group) % palette.length]! : neutral;
  }
  return kinds[kind] ?? neutral;
}

/** Radius in world units: busier notes are bigger; a group's size follows how many it stands for. */
export function radiusOf(n: Pick<GraphNode, 'kind' | 'degree' | 'count'>): number {
  if (n.kind === 'cluster') return Math.min(34, 11 + 2.6 * Math.sqrt(n.count ?? 1));
  const base = n.kind === 'note' ? 3.4 : 4.2;
  return Math.min(20, base + 1.7 * Math.sqrt(n.degree));
}

/* ---------- Filters ---------- */

export interface GraphFilters {
  folder: string;
  tag: string;
  tags: boolean;
  attachments: boolean;
  unresolved: boolean;
  hideOrphans: boolean;
  since: '24h' | '7d' | '30d' | '90d';
  access: '' | 'read' | 'write';
  /** Context and agents: notes from every vault, not only this one. */
  allVaults: boolean;
  /** Agents: only these kinds (empty: all). */
  kinds: GraphNodeKind[];
}

export const DEFAULT_FILTERS: GraphFilters = { folder: '', tag: '', tags: false, attachments: false, unresolved: false, hideOrphans: false, since: '7d', access: '', allVaults: false, kinds: [] };

const STORE = 'claudepilot.kg-graph';

export function loadFilters(vaultId: string): GraphFilters {
  try {
    const raw = sessionStorage.getItem(`${STORE}.${vaultId}`);
    if (!raw) return DEFAULT_FILTERS;
    const v = JSON.parse(raw) as Partial<GraphFilters>;
    return {
      ...DEFAULT_FILTERS,
      ...(typeof v.folder === 'string' ? { folder: v.folder } : {}),
      ...(typeof v.tag === 'string' ? { tag: v.tag } : {}),
      ...(typeof v.tags === 'boolean' ? { tags: v.tags } : {}),
      ...(typeof v.attachments === 'boolean' ? { attachments: v.attachments } : {}),
      ...(typeof v.unresolved === 'boolean' ? { unresolved: v.unresolved } : {}),
      ...(typeof v.hideOrphans === 'boolean' ? { hideOrphans: v.hideOrphans } : {}),
      ...(v.since === '24h' || v.since === '7d' || v.since === '30d' || v.since === '90d' ? { since: v.since } : {}),
      ...(v.access === 'read' || v.access === 'write' ? { access: v.access } : {}),
      ...(typeof v.allVaults === 'boolean' ? { allVaults: v.allVaults } : {}),
      ...(Array.isArray(v.kinds) ? { kinds: v.kinds.filter((k): k is GraphNodeKind => typeof k === 'string') } : {}),
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function saveFilters(vaultId: string, f: GraphFilters): void {
  try {
    sessionStorage.setItem(`${STORE}.${vaultId}`, JSON.stringify(f));
  } catch {
    // not remembered
  }
}

/** How many of the filters differ from their defaults for this lens (the dot on the filter button). */
export function activeFilters(lens: GraphLens, f: GraphFilters): number {
  const d = DEFAULT_FILTERS;
  if (lens === 'docs') return [f.folder !== d.folder, f.tag !== d.tag, f.tags, f.attachments, f.unresolved, f.hideOrphans].filter(Boolean).length;
  if (lens === 'context') return [f.since !== d.since, f.access !== d.access, f.allVaults].filter(Boolean).length;
  return [f.since !== d.since, f.allVaults, f.kinds.length > 0].filter(Boolean).length;
}

/** The query a lens, a vault and the filters make; `cap` is smaller on a phone. */
export function graphQueryOf(lens: GraphLens, vaultId: string | null, f: GraphFilters, o: { around?: string; depth?: number; cap?: number } = {}): GraphQuery {
  const base: GraphQuery = { lens, around: o.around, depth: o.around ? o.depth : undefined, cap: o.cap };
  if (lens === 'docs') {
    return { ...base, vault: vaultId ?? undefined, folder: f.folder || undefined, tag: f.tag || undefined, tags: f.tags || undefined, attachments: f.attachments || undefined, unresolved: f.unresolved || undefined, hideOrphans: f.hideOrphans || undefined };
  }
  const vault = f.allVaults ? undefined : (vaultId ?? undefined);
  if (lens === 'context') return { ...base, vault, since: f.since, access: f.access || undefined };
  return { ...base, vault, since: f.since === '7d' ? '30d' : f.since, kinds: f.kinds.length ? f.kinds : undefined };
}

/** The key a query's answer is remembered under (and the layout cache's). */
export const queryKey = (q: GraphQuery): string => JSON.stringify(Object.entries(q).filter(([, v]) => v !== undefined && v !== false && v !== '').sort(([a], [b]) => (a < b ? -1 : 1)));

/* ---------- The list ---------- */

/** The nodes as a list, most linked first; the text narrows it. */
export function listNodes(nodes: GraphNode[], text: string): GraphNode[] {
  const t = text.trim().toLowerCase();
  return nodes
    .filter((n) => !t || n.label.toLowerCase().includes(t) || (n.path ?? '').toLowerCase().includes(t))
    .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }));
}
