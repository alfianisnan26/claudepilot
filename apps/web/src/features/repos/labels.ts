import { REPO_ATTENTION_LABEL, REPO_AUDIT_KINDS, type RepoAttention, type RepoEvent, type RepoEventKind, type RepoEventQuery, type RepoNode, type RepoOperation, type RepoSummary } from '@portal/contracts';

/** The tones the kit's Badge knows, spelled here so this file stays free of the UI kit (it is tested on its own). */
export type Tone = 'neutral' | 'success' | 'warning' | 'danger';

/**
 * How loud each reason is. Red is for what blocks work or needs a person now (unreadable, conflicts, a merge half done); amber
 * is work that is at risk or out of step (not on a remote, behind, diverged, changes, drift); quiet is what only wants a look.
 */
export const ATTENTION_TONE: Record<RepoAttention, Tone> = {
  error: 'danger',
  conflicted: 'danger',
  operation: 'danger',
  diverged: 'warning',
  behind: 'warning',
  unpushed: 'warning',
  dirty: 'warning',
  detached: 'neutral',
  drift: 'warning',
  missing: 'neutral',
};

const RANK: Record<Tone, number> = { neutral: 0, success: 0, warning: 1, danger: 2 };

export const worstTone = (reasons: readonly RepoAttention[]): Tone => reasons.reduce<Tone>((t, r) => (RANK[ATTENTION_TONE[r]] > RANK[t] ? ATTENTION_TONE[r] : t), 'neutral');

/** The tone of a workspace's chip on the list, from what its summary counts. */
export function summaryTone(s: RepoSummary): Tone {
  if (s.errors > 0 || s.conflicted > 0) return 'danger';
  if (s.diverged > 0 || s.behind > 0 || s.unpushed > 0 || s.dirty > 0 || s.drifted > 0) return 'warning';
  return 'neutral';
}

/** "2 conflicts · 1 diverged": what the attention count is made of, worst first (a tooltip). */
export function summaryParts(s: RepoSummary): string[] {
  const parts: [number, string][] = [
    [s.errors, 'unreadable'],
    [s.conflicted, 'in conflict'],
    [s.diverged, 'diverged'],
    [s.behind - s.diverged, 'behind'],
    [s.unpushed, 'unpushed'],
    [s.dirty, 'with changes'],
    [s.detached, 'detached'],
    [s.drifted, 'off the record'],
    [s.missing, 'not cloned'],
  ];
  return parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
}

export const attentionWord = (n: number) => `${n} ${n === 1 ? 'repo needs' : 'repos need'} attention`;

const OPERATION: Record<RepoOperation, { label: string; title: string }> = {
  merge: { label: 'Merging', title: 'A merge is half done.' },
  rebase: { label: 'Rebasing', title: 'A rebase is half done.' },
  'cherry-pick': { label: 'Cherry-picking', title: 'A cherry-pick is half done.' },
  revert: { label: 'Reverting', title: 'A revert is half done.' },
  bisect: { label: 'Bisecting', title: 'A bisect is running.' },
};

export const operationLabel = (o: RepoOperation) => OPERATION[o].label;

/** What the server's short error codes mean, for a tooltip or one line. */
export const ERROR_TEXT: Record<string, string> = {
  timeout: 'Reading it took too long.',
  unreadable: 'Git could not read it.',
  not_a_repository: 'It is not a repo any more.',
  unsafe: 'Another user owns it, so git refuses it.',
};

export const errorText = (code: string) => ERROR_TEXT[code] ?? 'It could not be read.';

export interface Chip {
  key: string;
  label: string;
  tone: Tone;
  /** The longer wording, for a hover and the repository sheet. */
  title: string;
}

export const shortSha = (sha: string | null | undefined) => (sha ?? '').slice(0, 7);

/** A count as it fits a chip: 999, 1.2k, 12k, 120k+ (a huge number never decides how wide a chip is). */
export function compact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.floor(n));
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toString().replace(/\.0$/, '')}k`;
  if (n < 100_000) return `${Math.floor(n / 1000)}k`;
  return '99k+';
}

/** Text cut to `max` characters with an ellipsis (for a title or a toast, where the full name is shown elsewhere). */
export const clip = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The counts behind a "Changes" chip, in git's own words. */
export function changesTitle(c: { staged: number; unstaged: number; untracked: number; conflicted: number }): string {
  const parts = [c.conflicted && `${c.conflicted} in conflict`, c.staged && `${c.staged} staged`, c.unstaged && `${c.unstaged} modified`, c.untracked && `${c.untracked} untracked`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Clean';
}

/**
 * The chips a row shows: only what is not the ordinary state, in the order of the attention list, each with its words for a hover.
 * A repository that could not be read, or a submodule that is not cloned, has just that one.
 */
export function chipsOf(n: RepoNode): Chip[] {
  if (n.kind === 'missing') return [{ key: 'missing', label: REPO_ATTENTION_LABEL.missing, tone: 'neutral', title: 'Declared by the superproject, not cloned.' }];
  if (n.error) return [{ key: 'error', label: REPO_ATTENTION_LABEL.error, tone: 'danger', title: errorText(n.error) }];
  const s = n.state;
  if (!s) return [];
  const out: Chip[] = [];
  if (s.operation) out.push({ key: 'operation', label: OPERATION[s.operation].label, tone: 'danger', title: OPERATION[s.operation].title });
  if (s.changes.conflicted > 0) out.push({ key: 'conflicted', label: `${REPO_ATTENTION_LABEL.conflicted} ${compact(s.changes.conflicted)}`, tone: 'danger', title: `${plural(s.changes.conflicted, 'file')} in conflict.` });
  const ahead = s.upstream?.ahead ?? 0;
  const behind = s.upstream?.behind ?? 0;
  const unpushed = s.unpushed ?? 0;
  const where = s.upstream ? s.upstream.name : 'its remote';
  if (ahead > 0 && behind > 0) out.push({ key: 'diverged', label: REPO_ATTENTION_LABEL.diverged, tone: 'warning', title: `${ahead} ahead and ${behind} behind ${where}.` });
  else if (behind > 0) out.push({ key: 'behind', label: `${REPO_ATTENTION_LABEL.behind} ${compact(behind)}`, tone: 'warning', title: `${plural(behind, 'commit')} on ${where} not here.` });
  if (ahead > 0 && behind === 0) out.push({ key: 'ahead', label: `Ahead ${compact(ahead)}`, tone: unpushed > 0 ? 'warning' : 'neutral', title: `${plural(ahead, 'commit')} here not on ${where}.` });
  else if (ahead === 0 && unpushed > 0) out.push({ key: 'unpushed', label: `${REPO_ATTENTION_LABEL.unpushed} ${compact(unpushed)}`, tone: 'warning', title: `${plural(unpushed, 'commit')} on no remote branch.` });
  const changed = s.changes.staged + s.changes.unstaged + s.changes.untracked;
  if (changed > 0) out.push({ key: 'dirty', label: `${REPO_ATTENTION_LABEL.dirty} ${compact(changed)}`, tone: 'warning', title: changesTitle(s.changes) + '.' });
  if (s.detached && n.kind !== 'submodule') out.push({ key: 'detached', label: REPO_ATTENTION_LABEL.detached, tone: 'neutral', title: 'HEAD is on a commit, not a branch.' });
  if (n.submodule?.drifted) out.push({ key: 'drift', label: 'Drift', tone: 'warning', title: `Checked out at ${shortSha(s.head?.sha)}; the superproject records ${shortSha(n.submodule.recorded)}.` });
  else if (n.drifted > 0) out.push({ key: 'drift', label: `Drift ${compact(n.drifted)}`, tone: 'warning', title: `${plural(n.drifted, 'submodule')} off the commit this repo records.` });
  return out;
}

/** What the branch slot of a row says: the branch, the commit a detached HEAD is on, or that nothing is committed yet. */
export function branchLabel(n: RepoNode): string | null {
  const s = n.state;
  if (!s) return null;
  if (s.unborn) return s.branch ? `${s.branch} (no commits)` : 'no commits';
  if (s.branch) return s.branch;
  return shortSha(s.head?.sha) || 'detached';
}

export const KIND_WORD: Record<RepoNode['kind'], string> = {
  repo: 'Repo',
  submodule: 'Submodule',
  worktree: 'Worktree',
  nested: 'Nested repo',
  missing: 'Submodule, not cloned',
};

/** The path as people read it: the home folder as `~`. */
export function homePath(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~');
}

/* ---------- The tree ---------- */

export interface TreeRow {
  node: RepoNode;
  /** Shown for the sake of what is below it (the attention filter), not for its own state. */
  context: boolean;
  /** It has children in the list (so it can fold). */
  folds: boolean;
  folded: boolean;
}

/** A typed name matches a repository by its name, its folder or its branch. */
function matches(n: RepoNode, q: string): boolean {
  return n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q) || (n.state?.branch ?? '').toLowerCase().includes(q);
}

/** The parents above a node, nearest first (bounded, so a bad list can't loop). */
function* ancestors(n: RepoNode, byId: ReadonlyMap<string, RepoNode>): Generator<RepoNode> {
  let p = n.parentId ? byId.get(n.parentId) : undefined;
  for (let guard = 0; p && guard < 64; guard++) {
    yield p;
    p = p.parentId ? byId.get(p.parentId) : undefined;
  }
}

/**
 * The rows to draw from the server's flat, parents-first list: with the filter only what needs attention and the parents that lead
 * to it (those are `context`); a folded parent hides everything below it.
 */
export function treeRows(nodes: readonly RepoNode[], opts: { attentionOnly?: boolean; query?: string; folded?: ReadonlySet<string> } = {}): TreeRow[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hasKids = new Set<string>();
  for (const n of nodes) if (n.parentId && byId.has(n.parentId)) hasKids.add(n.parentId);

  // What the filters pick (attention, a name typed in): those rows are shown for their own sake, and the parents above them as context.
  const q = (opts.query ?? '').trim().toLowerCase();
  const filtered = !!opts.attentionOnly || q !== '';
  const own = new Set(nodes.filter((n) => (!opts.attentionOnly || n.attention.reasons.length > 0) && (q === '' || matches(n, q))).map((n) => n.id));
  const context = new Set<string>();
  if (filtered) for (const n of nodes) if (own.has(n.id)) for (const p of ancestors(n, byId)) if (!own.has(p.id)) context.add(p.id);

  // A typed name shows what it finds whatever is folded.
  const folded = q === '' ? (opts.folded ?? new Set<string>()) : new Set<string>();
  const rows: TreeRow[] = [];
  for (const n of nodes) {
    if (filtered && !own.has(n.id) && !context.has(n.id)) continue;
    if ([...ancestors(n, byId)].some((p) => folded.has(p.id))) continue;
    rows.push({ node: n, context: context.has(n.id), folds: hasKids.has(n.id), folded: folded.has(n.id) });
  }
  return rows;
}

/* ---------- The timeline ---------- */

export type EventFilter = 'all' | 'commits' | 'audit';

export const EVENT_FILTERS: { value: EventFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'commits', label: 'Commits' },
  { value: 'audit', label: 'Audit' },
];

/** The query a filter stands for (the repository and the page are added by the caller). */
export function filterQuery(f: EventFilter): Pick<RepoEventQuery, 'kind' | 'group'> {
  if (f === 'commits') return { kind: 'head_moved,branch_changed' };
  if (f === 'audit') return { group: 'audit' };
  return {};
}

const AUDIT = new Set<RepoEventKind>(REPO_AUDIT_KINDS);
export const isAudit = (kind: RepoEventKind) => AUDIT.has(kind);

/** The dot beside an event: how worrying what happened is. */
export function eventTone(e: Pick<RepoEvent, 'kind' | 'data'>): Tone {
  switch (e.kind) {
    case 'conflicted':
    case 'scan_failed':
      return 'danger';
    case 'diverged':
    case 'dirty':
    case 'drift':
    case 'removed':
      return 'warning';
    case 'sync':
      return e.data.outcome === 'failed' || e.data.outcome === 'refused' ? 'warning' : e.data.outcome === 'updated' ? 'success' : 'neutral';
    case 'clean':
    case 'aligned':
      return 'success';
    default:
      return 'neutral';
  }
}

/** Who did it, in a word: `ui` is a person at the portal; the rest name where the request came from. */
export function actorLabel(actor: string, label?: string | null): string {
  if (actor === 'ui') return 'Person';
  if (actor === 'workspace') return 'Workspace';
  if (actor.startsWith('session:')) return 'Agent';
  if (actor.startsWith('ticket:')) return `Ticket ${actor.slice('ticket:'.length)}`;
  if (actor.startsWith('portal-mcp:')) return label?.trim() ? `MCP client “${label.trim()}”` : 'Agent token';
  if (actor === 'portal:sync') return 'Keep synced';
  if (actor === 'portal:timer') return 'Timer';
  if (actor === 'portal:session') return 'Agent turn';
  if (actor.startsWith('portal:')) return 'Portal';
  return actor.slice(0, 24);
}

/** A ticket id an actor names, for a link; null for any other actor. */
export function ticketOf(actor: string): string | null {
  const m = /^ticket:([A-Za-z0-9_.-]{1,40})$/.exec(actor);
  return m ? m[1]! : null;
}

/** An event's one line without the repository's name in front (a repository's own timeline already says whose it is). */
export function plainSummary(e: Pick<RepoEvent, 'summary' | 'repo'>): string {
  return e.repo && e.summary.startsWith(`${e.repo}: `) ? e.summary.slice(e.repo.length + 2) : e.summary;
}

/** What an event adds to its line, as short plain lines (shown when it is opened): the commits and who wrote them, the move, the reason. */
export function detailsOf(e: Pick<RepoEvent, 'kind' | 'data'>): string[] {
  const d = e.data;
  const out: string[] = [];
  const move = d.fromSha || d.toSha ? `${shortSha(d.fromSha) || '–'} → ${shortSha(d.toSha) || '–'}` : d.from || d.to ? `${d.from ?? 'detached'} → ${d.to ?? 'detached'}` : null;
  switch (e.kind) {
    case 'head_moved':
      if (move) out.push(move);
      if (d.fastForward === false) out.push('Not a fast-forward: the history changed.');
      for (const s of d.subjects ?? []) out.push(`“${s}”`);
      if ((d.commits ?? 0) > (d.subjects?.length ?? 0)) out.push(`and ${(d.commits ?? 0) - (d.subjects?.length ?? 0)} more`);
      break;
    case 'branch_changed':
    case 'sync':
      if (move) out.push(move);
      if (d.error) out.push(d.error);
      break;
    case 'drift':
    case 'aligned':
      if (d.path) out.push(d.path);
      if (d.recorded) out.push(`Recorded ${shortSha(d.recorded)}${d.checkedOut ? `, checked out ${shortSha(d.checkedOut)}` : ''}`);
      break;
    case 'dirty':
    case 'clean':
    case 'conflicted':
      if (d.staged !== undefined) out.push(changesTitle({ staged: d.staged ?? 0, unstaged: d.unstaged ?? 0, untracked: d.untracked ?? 0, conflicted: d.conflicted ?? 0 }));
      break;
    case 'diverged':
      out.push(`${d.ahead ?? 0} ahead, ${d.behind ?? 0} behind`);
      break;
    case 'worktree_added':
    case 'worktree_removed':
    case 'worktree_created':
    case 'worktree_deleted':
      if (d.path) out.push(d.path);
      if (d.branch) out.push(`Branch ${d.branch}${d.branchDeleted ? ' (deleted)' : ''}`);
      break;
    case 'scan_failed':
      if (d.error) out.push(d.error);
      break;
    default:
      break;
  }
  if (d.sessions?.length) out.push(`Agents there: ${d.sessions.length}`);
  return out;
}

/** The scan folders as typed: one per line, blanks and repeats dropped. */
export const parseRoots = (text: string): string[] => [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))];
