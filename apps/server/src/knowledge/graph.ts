// Knowledge: the graphs (Knowledge PRD §12). One node-and-edge model for three lenses: the docs graph (notes and the
// links, tags and attachments between them), the context graph (which session, ticket, token or person read or wrote
// which note) and the agentic graph (workspaces, sessions, tickets, Claudes, worktrees and what they use, with the notes
// that mention them). A graph is built on request from the vault indexes and the portal's tables and is never stored.
// It is capped so that a 10,000-note vault still draws: the most linked nodes stay and the rest fold into one node per
// folder (or kind), so nothing silently disappears; the answer says what was folded.

import type { GraphEdge, GraphEdgeKind, GraphNode, GraphNodeKind, GraphQuery, GraphResponse } from '@portal/contracts';
import type { ClaudeInfo, PoolUse, SessionInfo, TicketInfo } from './directory.js';
import { KnowledgeError } from './errors.js';
import type { GraphNoteRow, VaultIndex } from './indexdb.js';
import type { EdgeTouch } from './journal.js';

export const GRAPH_CAP = 1_500;
export const GRAPH_CAP_MAX = 5_000;
/** Edges allowed per node of the cap (6,000 at the default). */
const EDGES_PER_NODE = 4;
const MAX_CLUSTERS = 48;
const MAX_DEPTH = 4;

export function graphLimits(q: GraphQuery): { cap: number; edgeCap: number } {
  const asked = Number(q.cap);
  const cap = Number.isFinite(asked) && asked > 0 ? Math.min(GRAPH_CAP_MAX, Math.max(50, Math.floor(asked))) : GRAPH_CAP;
  return { cap, edgeCap: cap * EDGES_PER_NODE };
}

export const graphDepth = (q: GraphQuery): number => {
  const d = Math.floor(Number(q.depth));
  return Number.isFinite(d) && d >= 1 ? Math.min(MAX_DEPTH, d) : 1;
};

/* ---------- Building ---------- */

/** What an edge says when two things are linked by more than one kind of touch: the strongest. */
const TOUCH_RANK: Partial<Record<GraphEdgeKind, number>> = { deleted: 5, created: 4, edited: 3, appended: 2, read: 1 };

/**
 * Nodes and edges as they are added. There is one edge per pair of nodes (either way round): a second one adds its
 * weight, and between touches the strongest kind wins.
 */
export class GraphBuilder {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();

  node(n: Omit<GraphNode, 'degree'>): GraphNode {
    let cur = this.nodes.get(n.id);
    if (!cur) {
      cur = { ...n, degree: 0 };
      this.nodes.set(n.id, cur);
    }
    return cur;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  link(from: string, to: string, kind: GraphEdgeKind, weight = 1, at?: string | null): void {
    if (from === to || !this.nodes.has(from) || !this.nodes.has(to)) return;
    const key = from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
    const e = this.edges.get(key);
    if (!e) {
      this.edges.set(key, at ? { from, to, kind, weight, at } : { from, to, kind, weight });
      return;
    }
    e.weight += weight;
    if ((TOUCH_RANK[kind] ?? 0) > (TOUCH_RANK[e.kind] ?? 0)) e.kind = kind;
    if (at && (!e.at || at > e.at)) e.at = at;
  }

  /** Sets each node's degree (the nodes it is linked to) and returns both lists. */
  finish(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    for (const n of this.nodes.values()) n.degree = 0;
    for (const e of this.edges.values()) {
      this.nodes.get(e.from)!.degree++;
      this.nodes.get(e.to)!.degree++;
    }
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }
}

/** The nodes within `depth` steps of `center`. A level that would overflow `budget` keeps its most linked nodes. */
export function neighbourhood(nodes: GraphNode[], edges: GraphEdge[], center: string, depth: number, budget: number): { ids: Set<string>; complete: boolean } {
  const adj = new Map<string, string[]>();
  const push = (a: string, b: string) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const e of edges) {
    push(e.from, e.to);
    push(e.to, e.from);
  }
  const degree = new Map(nodes.map((n) => [n.id, n.degree]));
  const seen = new Set<string>([center]);
  let frontier = [center];
  let complete = true;
  for (let d = 0; d < depth && frontier.length; d++) {
    const level = new Set<string>();
    for (const id of frontier) for (const nb of adj.get(id) ?? []) if (!seen.has(nb)) level.add(nb);
    let take = [...level];
    if (seen.size + take.length > budget) {
      take.sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (a < b ? -1 : 1));
      take = take.slice(0, Math.max(0, budget - seen.size));
      complete = false;
    }
    for (const id of take) seen.add(id);
    frontier = take;
    if (!complete) break;
  }
  return { ids: seen, complete };
}

export interface ClusterKey {
  key: string;
  label: string;
  group: string;
}

export interface CapOptions {
  cap: number;
  edgeCap: number;
  /** Kept whatever their degree (the node a local graph is around). */
  pinned?: ReadonlySet<string>;
  /** The cluster a node folds into when it isn't kept; null: one per kind. */
  clusterOf?: (n: GraphNode) => ClusterKey | null;
}

export interface Capped {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** How many nodes were folded into clusters, and how many edges left out. */
  folded: number;
  edgesCut: number;
}

const KIND_LABEL: Record<GraphNodeKind, string> = {
  note: 'Notes',
  tag: 'Tags',
  attachment: 'Files',
  unresolved: 'Unresolved',
  session: 'Sessions',
  ticket: 'Tickets',
  workspace: 'Workspaces',
  claude: 'Claudes',
  persona: 'Personas',
  skillset: 'Skills',
  mcpset: 'MCP',
  context: 'Contexts',
  worktree: 'Worktrees',
  actor: 'Actors',
  cluster: 'Other',
};

const byDegree = (a: GraphNode, b: GraphNode) => b.degree - a.degree || (a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : 1);

/**
 * Keeps the graph within `cap` nodes and `edgeCap` edges. The most linked nodes stay; every other node folds into a
 * cluster node (one per folder or kind, at most 48), and edges to folded nodes become edges to their cluster. Over
 * the edge cap the strongest edges stay, after one per node so that nothing is left alone for want of a link.
 */
export function capGraph(nodes: GraphNode[], edges: GraphEdge[], o: CapOptions): Capped {
  const pinned = o.pinned ?? new Set<string>();
  let outNodes = nodes;
  let outEdges = edges;
  let folded = 0;

  if (nodes.length > o.cap) {
    const slots = Math.min(MAX_CLUSTERS, Math.max(2, Math.floor(o.cap / 10)));
    const keepCount = Math.max(pinned.size, o.cap - slots);
    const keep = new Set<string>(pinned);
    for (const n of [...nodes].sort(byDegree)) {
      if (keep.size >= keepCount) break;
      keep.add(n.id);
    }
    const groups = new Map<string, { info: ClusterKey; ids: string[]; degree: number }>();
    for (const n of nodes) {
      if (keep.has(n.id)) continue;
      const info = o.clusterOf?.(n) ?? { key: n.kind, label: KIND_LABEL[n.kind], group: n.kind };
      const g = groups.get(info.key);
      if (g) {
        g.ids.push(n.id);
        g.degree += n.degree;
      } else groups.set(info.key, { info, ids: [n.id], degree: n.degree });
    }
    // Too many folders for the room set aside: the smallest share one cluster.
    let list = [...groups.values()].sort((a, b) => b.ids.length - a.ids.length || (a.info.key < b.info.key ? -1 : 1));
    if (list.length > slots) {
      const rest = list.slice(slots - 1);
      const merged = { info: { key: 'other', label: 'Other', group: 'other' }, ids: rest.flatMap((g) => g.ids), degree: rest.reduce((s, g) => s + g.degree, 0) };
      list = [...list.slice(0, slots - 1), merged];
    }
    const into = new Map<string, string>();
    const clusters: GraphNode[] = [];
    for (const g of list) {
      const id = `cluster:${g.info.key}`;
      for (const nid of g.ids) into.set(nid, id);
      folded += g.ids.length;
      clusters.push({ id, kind: 'cluster', label: g.info.label, group: g.info.group, degree: 0, href: null, count: g.ids.length });
    }
    const merged = new Map<string, GraphEdge>();
    for (const e of edges) {
      const a = into.get(e.from) ?? e.from;
      const b = into.get(e.to) ?? e.to;
      if (a === b) continue;
      const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
      const cur = merged.get(key);
      if (!cur) merged.set(key, { from: a, to: b, kind: e.kind, weight: e.weight, ...(e.at ? { at: e.at } : {}) });
      else {
        cur.weight += e.weight;
        if (cur.kind !== e.kind) cur.kind = TOUCH_RANK[cur.kind] && TOUCH_RANK[e.kind] ? ((TOUCH_RANK[e.kind] ?? 0) > (TOUCH_RANK[cur.kind] ?? 0) ? e.kind : cur.kind) : 'links-to';
        if (e.at && (!cur.at || e.at > cur.at)) cur.at = e.at;
      }
    }
    outNodes = [...nodes.filter((n) => keep.has(n.id)), ...clusters];
    outEdges = [...merged.values()];
    const deg = new Map<string, number>();
    for (const e of outEdges) {
      deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
      deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
    }
    for (const c of clusters) c.degree = deg.get(c.id) ?? 0;
  }

  let edgesCut = 0;
  if (outEdges.length > o.edgeCap) {
    const order = outEdges.map((e, i) => ({ e, i })).sort((a, b) => b.e.weight - a.e.weight || a.i - b.i);
    const chosen = new Set<number>();
    const touched = new Set<string>();
    for (const { e, i } of order) {
      if (chosen.size >= o.edgeCap) break;
      if (!touched.has(e.from) || !touched.has(e.to)) {
        chosen.add(i);
        touched.add(e.from);
        touched.add(e.to);
      }
    }
    for (const { i } of order) {
      if (chosen.size >= o.edgeCap) break;
      chosen.add(i);
    }
    edgesCut = outEdges.length - chosen.size;
    outEdges = outEdges.filter((_, i) => chosen.has(i));
  }
  return { nodes: outNodes, edges: outEdges, folded, edgesCut };
}

interface Finish {
  lens: GraphQuery['lens'];
  center: string | null;
  built: { nodes: GraphNode[]; edges: GraphEdge[] };
  q: GraphQuery;
  clusterOf?: (n: GraphNode) => ClusterKey | null;
  /** The kind of thing the nodes are, for the message ("notes"). */
  unit: string;
  /** A `center` nothing is drawn for is an empty graph, not an error (a note no session has used). */
  emptyOk?: boolean;
  /** `built` is already the neighbourhood of `center` (read from the index around it), `partial` when the budget cut it short. */
  extracted?: { partial: boolean };
}

/** The local graph around `center` when asked for, then the cap, as the answer. */
function respond(f: Finish): GraphResponse {
  const { cap, edgeCap } = graphLimits(f.q);
  let { nodes, edges } = f.built;
  let local = false;
  let partial = false;
  if (f.center) {
    if (!nodes.some((n) => n.id === f.center)) {
      if (f.emptyOk) return { lens: f.lens, center: null, nodes: [], edges: [], truncated: false, totals: { nodes: 0, edges: 0 }, message: null };
      throw new KnowledgeError('NOT_FOUND', 'That isn’t in the graph.');
    }
    if (f.extracted) partial = f.extracted.partial;
    else {
      const around = neighbourhood(nodes, edges, f.center, graphDepth(f.q), cap);
      nodes = nodes.filter((n) => around.ids.has(n.id));
      edges = edges.filter((e) => around.ids.has(e.from) && around.ids.has(e.to));
      partial = !around.complete;
    }
    local = true;
  }
  const totals = { nodes: nodes.length, edges: edges.length };
  const capped = capGraph(nodes, edges, { cap, edgeCap, pinned: f.center ? new Set([f.center]) : undefined, clusterOf: f.clusterOf });
  const kept = capped.nodes.length - capped.nodes.filter((n) => n.kind === 'cluster').length;
  let message: string | null = null;
  // One short line: the client shows it as it is.
  if (capped.folded) message = `${kept.toLocaleString('en-US')} of ${totals.nodes.toLocaleString('en-US')}, most linked. Rest grouped.`;
  else if (partial) message = `Nearest ${capped.nodes.length.toLocaleString('en-US')} nodes.`;
  else if (capped.edgesCut) message = `Strongest ${capped.edges.length.toLocaleString('en-US')} of ${totals.edges.toLocaleString('en-US')} links.`;
  return {
    lens: f.lens,
    center: local ? f.center : null,
    nodes: capped.nodes,
    edges: capped.edges,
    truncated: capped.folded > 0 || capped.edgesCut > 0 || partial,
    totals,
    message,
  };
}

/* ---------- Docs ---------- */

const topFolder = (folder: string): string => {
  const i = folder.indexOf('/');
  return i < 0 ? folder : folder.slice(0, i);
};
const clip = (s: string, n = 44): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const noteLabel = (path: string): string => baseOf(path).replace(/\.md$/i, '');
const iso = (ms: number): string => new Date(ms).toISOString();

export interface DocsInput {
  vaultId: string;
  index: VaultIndex;
  labels: 'filename' | 'heading';
  q: GraphQuery;
}

/** One folder's cluster: `Projects` (the top folder of the notes it folds), or the vault's loose notes. */
const folderCluster = (n: GraphNode): ClusterKey | null => {
  if (n.kind !== 'note') return null;
  const vault = n.vault ?? '';
  return { key: `${vault}:${n.group}`, label: n.group || 'Notes', group: n.group };
};

export function docsGraph(i: DocsInput): GraphResponse {
  const { q, index } = i;
  const vault = i.vaultId;
  const noteId = (path: string) => `note:${vault}:${path}`;
  const labelOf = (n: GraphNoteRow) => (i.labels === 'heading' && n.title ? n.title : n.name);

  let center: string | null = null;
  let want = { tags: !!q.tags, unresolved: !!q.unresolved, attachments: !!q.attachments };
  // A local graph around a note is read from the index around it; the rest of the vault is never loaded.
  let scope: number[] | undefined;
  let partial = false;
  if (q.around) {
    const m = /^(note|tag|attachment|unresolved):([^:]+):(.+)$/s.exec(q.around);
    if (!m || m[2] !== vault) throw new KnowledgeError('NOT_FOUND', 'That isn’t in this vault.');
    center = q.around;
    if (m[1] === 'note') {
      const file = index.get(m[3]!);
      if (!file || file.kind !== 'note') throw new KnowledgeError('NOT_FOUND', 'That note isn’t in this vault.');
      const near = index.nearNotes(file.id, graphDepth(q), graphLimits(q).cap);
      scope = near.ids;
      partial = !near.complete;
    }
    // Around a tag, a file or a name nothing resolves to: draw that kind.
    if (m[1] === 'tag') want = { ...want, tags: true };
    if (m[1] === 'attachment') want = { ...want, attachments: true };
    if (m[1] === 'unresolved') want = { ...want, unresolved: true };
  }

  const notes = index.graphNotes(scope);
  const byId = new Map<number, GraphNoteRow>();
  const nid = new Map<number, string>();
  for (const n of notes) {
    byId.set(n.id, n);
    nid.set(n.id, noteId(n.path));
  }

  // Which notes are drawn: the folder and the tag asked for (the one a local graph is around is always there).
  const folder = (q.folder ?? '').replace(/^\/+|\/+$/g, '').toLowerCase();
  const tag = (q.tag ?? '').replace(/^#/, '').toLowerCase();
  const tagsOf = new Map<number, string[]>();
  if (tag || want.tags) for (const t of index.graphTags(scope)) (tagsOf.get(t.file) ?? tagsOf.set(t.file, []).get(t.file)!).push(t.tag);
  const drawn = new Set<number>();
  for (const n of notes) {
    const id = nid.get(n.id)!;
    if (folder && id !== center) {
      const f = n.folder.toLowerCase();
      if (f !== folder && !f.startsWith(`${folder}/`)) continue;
    }
    if (tag && id !== center && !(tagsOf.get(n.id) ?? []).some((t) => t === tag || t.startsWith(`${tag}/`))) continue;
    drawn.add(n.id);
  }

  const b = new GraphBuilder();
  for (const n of notes) {
    if (!drawn.has(n.id)) continue;
    b.node({ id: nid.get(n.id)!, kind: 'note', label: clip(labelOf(n)), group: topFolder(n.folder), href: null, vault, path: n.path, at: iso(n.mtimeMs) });
  }
  const files = want.attachments ? new Map(index.graphFiles(scope).map((f) => [f.id, f])) : null;
  for (const l of index.graphLinks(scope)) {
    const from = nid.get(l.src);
    if (!from || !drawn.has(l.src)) continue;
    const kind: GraphEdgeKind = l.embed ? 'embeds' : 'links-to';
    const to = nid.get(l.dst);
    if (to) {
      if (drawn.has(l.dst)) b.link(from, to, kind);
      continue;
    }
    const f = files?.get(l.dst);
    if (!f) continue;
    const id = `attachment:${vault}:${f.path}`;
    b.node({ id, kind: 'attachment', label: clip(f.name), group: 'attachment', href: null, vault, path: f.path, at: iso(f.mtimeMs) });
    b.link(from, id, kind);
  }
  if (want.unresolved) {
    for (const u of index.graphUnresolved(scope)) {
      const from = nid.get(u.src);
      if (!from || !drawn.has(u.src)) continue;
      const id = `unresolved:${vault}:${u.key}`;
      b.node({ id, kind: 'unresolved', label: clip(noteLabel(u.target) || u.key), group: 'unresolved', href: null });
      b.link(from, id, 'links-to', u.n);
    }
  }
  if (want.tags) {
    for (const [file, list] of tagsOf) {
      const from = nid.get(file);
      if (!from || !drawn.has(file)) continue;
      for (const t of list) {
        const id = `tag:${vault}:${t}`;
        b.node({ id, kind: 'tag', label: `#${clip(t, 30)}`, group: 'tag', href: null });
        b.link(from, id, 'tagged');
      }
    }
  }

  const built = b.finish();
  if (scope) {
    // Around a note a node is sized by its links in the whole vault, not only those within sight.
    const whole = index.degrees(scope);
    for (const [file, id] of nid) {
      const node = b.nodes.get(id);
      if (node) node.degree = Math.max(node.degree, whole.get(file) ?? 0);
    }
  }
  if (q.hideOrphans) built.nodes = built.nodes.filter((n) => n.kind !== 'note' || n.degree > 0 || n.id === center);
  return respond({ lens: 'docs', center, built, q, clusterOf: folderCluster, unit: 'nodes', extracted: scope ? { partial } : undefined });
}

/* ---------- Context ---------- */

/** `24h`, `7d`, `30d`: how far back, in milliseconds (a day by default, at most a year). */
export function parseSince(value: string | undefined, fallbackDays = 7): number {
  if (!value) return fallbackDays * 86_400_000;
  const m = /^(\d{1,3})([hd])$/i.exec(value.trim());
  if (!m) throw new KnowledgeError('INVALID_INPUT', 'Use a number of hours or days, like 24h or 7d.');
  const ms = Number(m[1]) * (m[2]!.toLowerCase() === 'h' ? 3_600_000 : 86_400_000);
  if (ms <= 0) throw new KnowledgeError('INVALID_INPUT', 'Use a number of hours or days, like 24h or 7d.');
  return Math.min(ms, 365 * 86_400_000);
}

const shortId = (id: string): string => id.slice(0, 8);
export const ticketKey = (id: string): string => `T-${Number(/(\d+)/.exec(id)?.[1] ?? 0)}`;

const sessionHref = (id: string) => `/admin/sessions/${encodeURIComponent(id)}`;
const ticketHref = (id: string) => `/admin/tickets/${encodeURIComponent(id)}`;

function sessionNode(b: GraphBuilder, id: string, info: SessionInfo | undefined): string {
  const canonical = info?.id ?? id;
  const nodeId = `session:${canonical}`;
  b.node({ id: nodeId, kind: 'session', label: clip(info?.title.trim() || `Session ${shortId(canonical)}`), group: info?.state || 'gone', href: info ? sessionHref(canonical) : null, state: info ? info.state : 'gone', at: info?.at || null });
  return nodeId;
}

function ticketNode(b: GraphBuilder, key: string, info: TicketInfo | undefined): string {
  const id = ticketKey(key);
  const nodeId = `ticket:${id}`;
  b.node({ id: nodeId, kind: 'ticket', label: clip(info ? `${id} ${info.summary}` : id), group: info?.status ?? 'gone', href: info ? ticketHref(id) : null, state: info ? info.status : 'gone', at: info?.at || null });
  return nodeId;
}

const sourceCluster = (n: GraphNode): ClusterKey | null => (n.kind === 'note' ? folderCluster(n) : null);

export interface ContextInput {
  touches: EdgeTouch[];
  sessions: Map<string, SessionInfo>;
  tickets: Map<string, TicketInfo>;
  tokens: Map<string, string>;
  /** Whether the note is still there (a touched note may since have been deleted). */
  exists: (vaultId: string, path: string) => boolean;
  q: GraphQuery;
}

export function contextGraph(i: ContextInput): GraphResponse {
  const b = new GraphBuilder();
  const noteIds = new Map<string, string>();
  for (const t of i.touches) {
    const key = `${t.vaultId}\u0000${t.path}`;
    let nid = noteIds.get(key);
    if (!nid) {
      nid = `note:${t.vaultId}:${t.path}`;
      noteIds.set(key, nid);
      b.node({ id: nid, kind: 'note', label: clip(noteLabel(t.path)), group: topFolder(t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')) : ''), href: null, vault: t.vaultId, path: t.path, state: i.exists(t.vaultId, t.path) ? null : 'gone', at: t.lastAt });
    } else {
      const n = b.nodes.get(nid)!;
      if (t.lastAt > (n.at ?? '')) n.at = t.lastAt;
    }
    let source: string;
    switch (t.sourceKind) {
      case 'session':
        source = sessionNode(b, t.sourceId, i.sessions.get(t.sourceId));
        break;
      case 'ticket':
        source = ticketNode(b, t.sourceId, i.tickets.get(ticketKey(t.sourceId)));
        break;
      case 'workspace':
        source = `workspace:${t.sourceId}`;
        b.node({ id: source, kind: 'workspace', label: clip(t.sourceId.slice(t.sourceId.lastIndexOf('/') + 1)), group: 'workspace', href: '/admin/workspaces' });
        break;
      case 'token':
        source = `actor:token:${t.sourceId}`;
        b.node({ id: source, kind: 'actor', label: clip(i.tokens.get(t.sourceId) || 'Token'), group: 'actor', href: '/admin/access' });
        break;
      default:
        source = 'actor:user:ui';
        b.node({ id: source, kind: 'actor', label: 'You', group: 'user', href: null });
    }
    const s = b.nodes.get(source)!;
    if (t.lastAt > (s.at ?? '')) s.at = t.lastAt;
    b.link(source, nid, t.kind, t.count, t.lastAt);
  }
  // The ticket a session works for: what ties the notes an agent used to the work it was asked to do.
  const canonical = new Map([...i.sessions.values()].map((s) => [s.id, s]));
  for (const n of [...b.nodes.values()]) {
    if (n.kind !== 'session') continue;
    const info = canonical.get(n.id.slice('session:'.length));
    if (!info?.ticketId) continue;
    const key = ticketKey(info.ticketId);
    const t = ticketNode(b, key, i.tickets.get(key));
    b.link(n.id, t, 'works-in');
  }
  return respond({ lens: 'context', center: i.q.around ?? null, built: b.finish(), q: i.q, clusterOf: sourceCluster, unit: 'nodes', emptyOk: true });
}

/* ---------- Agentic ---------- */

const POOL_TAB: Record<string, string> = { persona: 'personas', skillset: 'skills', mcpset: 'mcp', context: 'contexts' };
const POOL_KIND: Record<string, GraphNodeKind> = { persona: 'persona', skillset: 'skillset', mcpset: 'mcpset', context: 'context' };

export interface Mention {
  vaultId: string;
  note: GraphNoteRow;
  type: string;
  key: string;
  count: number;
}

export interface AgenticInput {
  sessions: SessionInfo[];
  /** Sessions only known by id (a ticket's or a note's), with those folded into another under their old id. */
  known: Map<string, SessionInfo>;
  tickets: TicketInfo[];
  claudes: ClaudeInfo[];
  pools: PoolUse[];
  mentions: Mention[];
  q: GraphQuery;
}

const workspaceName = (id: string): string => id.slice(id.lastIndexOf('/') + 1) || id;

export function agenticGraph(i: AgenticInput): GraphResponse {
  const b = new GraphBuilder();
  const workspaces = new Set<string>();
  const workspace = (id: string): string => {
    const nid = `workspace:${id}`;
    if (!workspaces.has(id)) {
      workspaces.add(id);
      b.node({ id: nid, kind: 'workspace', label: clip(workspaceName(id)), group: 'workspace', href: '/admin/workspaces' });
    }
    return nid;
  };
  const worktree = (workspaceId: string, branch: string): string => {
    const nid = `worktree:${workspaceId}:${branch}`;
    if (!b.has(nid)) {
      b.node({ id: nid, kind: 'worktree', label: clip(branch), group: 'worktree', href: null });
      b.link(nid, workspace(workspaceId), 'belongs-to');
    }
    return nid;
  };

  // Sessions drawn, by the id they are asked for under (canonical, or an old one folded into it). A session
  // pulled in by something that points at it joins the queue and is wired like the rest.
  const sessionIds = new Map<string, string>();
  const queue: SessionInfo[] = [];
  const addSession = (s: SessionInfo): string => {
    let nid = sessionIds.get(s.id);
    if (!nid) {
      nid = sessionNode(b, s.id, s);
      sessionIds.set(s.id, nid);
      queue.push(s);
    }
    return nid;
  };
  const resolveSession = (id: string): string | null => {
    const hit = sessionIds.get(id);
    if (hit) return hit;
    const info = i.known.get(id);
    if (!info) return null;
    const nid = addSession(info);
    sessionIds.set(id, nid);
    return nid;
  };

  const ticketIds = new Map<string, string>();
  for (const t of i.tickets) ticketIds.set(t.id, ticketNode(b, t.id, t));
  // A Claude is drawn when a session runs as it or a note mentions it: the idle default one of every workspace is noise.
  const claudeInfo = new Map(i.claudes.map((c) => [c.id, c]));
  const claudeNode = (c: ClaudeInfo): string => {
    const nid = `claude:${c.id}`;
    if (!b.has(nid)) {
      b.node({ id: nid, kind: 'claude', label: clip(c.name), group: 'claude', href: null });
      b.link(nid, workspace(c.workspaceId), 'belongs-to');
    }
    return nid;
  };
  for (const s of i.sessions) addSession(s);

  for (const t of i.tickets) {
    const nid = ticketIds.get(t.id)!;
    if (t.assigneeKind === 'session' && t.assigneeRef) {
      const s = resolveSession(t.assigneeRef);
      if (s) b.link(nid, s, 'assigned-to');
    }
    if (t.workspaceId) {
      b.link(nid, workspace(t.workspaceId), 'assigned-to');
      if (t.worktreeBranch) b.link(nid, worktree(t.workspaceId, t.worktreeBranch), 'works-in');
    }
  }
  // Sessions notes mention by id join before the wiring below.
  for (const m of i.mentions) if (m.type === 'session') resolveSession(m.key.trim());

  for (let k = 0; k < queue.length; k++) {
    const s = queue[k]!;
    const nid = sessionIds.get(s.id)!;
    if (s.workspaceId) b.link(nid, workspace(s.workspaceId), 'runs-in');
    const claude = s.claudeId ? claudeInfo.get(s.claudeId) : undefined;
    if (claude) b.link(nid, claudeNode(claude), 'runs-as');
    const parent = s.parentId ? resolveSession(s.parentId) : null;
    if (parent) b.link(nid, parent, 'spawned-by');
    const ticket = s.ticketId ? ticketIds.get(ticketKey(s.ticketId)) : undefined;
    if (ticket) b.link(nid, ticket, 'works-in');
    if (s.workspaceId && s.worktreeBranch) b.link(nid, worktree(s.workspaceId, s.worktreeBranch), 'works-in');
  }

  const poolIds = new Map<string, string>();
  for (const u of i.pools) {
    if (!workspaces.has(u.workspaceId)) continue;
    const kind = POOL_KIND[u.type];
    if (!kind) continue;
    const nid = `${kind}:${u.poolId}`;
    poolIds.set(`${u.type}\u0000${u.poolId}`, nid);
    poolIds.set(`${u.type}\u0000${u.name.toLowerCase()}`, nid);
    b.node({ id: nid, kind, label: clip(u.name), group: kind, href: `/admin/pools?tab=${POOL_TAB[u.type]}` });
    b.link(workspace(u.workspaceId), nid, 'uses');
  }

  // Notes that mention one of these (`[[ticket:T-12]]`): a note appears only when what it mentions is drawn.
  const target = (type: string, key: string): string | null => {
    const k = key.trim();
    switch (type) {
      case 'ticket':
        return ticketIds.get(ticketKey(k)) ?? null;
      case 'session':
        return sessionIds.get(k) ?? null;
      case 'workspace': {
        const hit = [...workspaces].find((w) => w.toLowerCase() === k.toLowerCase());
        return hit ? `workspace:${hit}` : null;
      }
      case 'claude': {
        const exact = claudeInfo.get(k);
        if (exact) return claudeNode(exact);
        const named = i.claudes.filter((c) => c.name.toLowerCase() === k.toLowerCase());
        return named.length === 1 ? claudeNode(named[0]!) : null;
      }
      case 'persona':
      case 'skillset':
        return poolIds.get(`${type}\u0000${k}`) ?? poolIds.get(`${type}\u0000${k.toLowerCase()}`) ?? null;
      case 'mcp':
        return poolIds.get(`mcpset\u0000${k}`) ?? poolIds.get(`mcpset\u0000${k.toLowerCase()}`) ?? null;
      default:
        return null;
    }
  };
  for (const m of i.mentions) {
    const t = target(m.type, m.key);
    if (!t) continue;
    const nid = `note:${m.vaultId}:${m.note.path}`;
    b.node({ id: nid, kind: 'note', label: clip(m.note.name), group: topFolder(m.note.folder), href: null, vault: m.vaultId, path: m.note.path, at: iso(m.note.mtimeMs) });
    b.link(nid, t, 'mentions', m.count);
  }

  const built = b.finish();
  const kinds = i.q.kinds?.length ? new Set<GraphNodeKind>(i.q.kinds) : null;
  if (kinds) {
    const keep = new Set(built.nodes.filter((n) => kinds.has(n.kind)).map((n) => n.id));
    built.nodes = built.nodes.filter((n) => keep.has(n.id));
    built.edges = built.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }
  return respond({ lens: 'agentic', center: i.q.around ?? null, built, q: i.q, clusterOf: sourceCluster, unit: 'nodes', emptyOk: true });
}
