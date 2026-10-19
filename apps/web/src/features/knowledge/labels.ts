import type { AgentPolicy, NoteHistoryEntry } from '@portal/contracts';

export const POLICY_LABEL: Record<AgentPolicy, string> = { off: 'Off', read: 'Read', 'write-own': 'Write own', write: 'Write' };

export const POLICY_HELP: Record<AgentPolicy, string> = {
  off: 'Agents can’t use this vault.',
  read: 'Agents can search and read it.',
  'write-own': 'Agents can also add notes, edit notes they wrote and append to daily notes. Notes you wrote stay yours.',
  write: 'Agents can also edit any note, with a version check.',
};

/** Who made a change, in a word or two. */
export function actorLabel(actor: string): string {
  if (actor === 'ui') return 'You';
  if (actor === 'external') return 'Outside';
  if (actor === 'import' || actor === 'system') return 'Import';
  if (actor === 'sync') return 'Sync';
  const colon = actor.indexOf(':');
  const type = colon > 0 ? actor.slice(0, colon) : actor;
  const key = colon > 0 ? actor.slice(colon + 1) : '';
  if (type === 'session') return `Agent ${key.slice(0, 8)}`;
  if (type === 'ticket') return `Ticket ${key}`;
  if (type === 'portal-mcp') return 'Claude';
  if (type === 'workspace') return 'Workspace';
  return actor;
}

export const OP_LABEL: Record<NoteHistoryEntry['op'], string> = {
  create: 'Created',
  edit: 'Edited',
  append: 'Added to',
  rename: 'Renamed',
  delete: 'Deleted',
  restore: 'Restored',
  import: 'Imported',
  sync: 'Synced',
  external: 'Changed outside',
};

/** `obsidian://open` for people who have this vault open in the Obsidian app. */
export const obsidianUrl = (vault: string, path: string) => `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path.replace(/\.md$/i, ''))}`;

/** A note's name as people see it: its file name, or its first heading in vaults that label by heading. */
export function displayName(name: string, title: string | null | undefined, labels: 'filename' | 'heading'): string {
  return labels === 'heading' && title ? title : name;
}

/** The URL a vault page lives at, with a note open. */
export const vaultHref = (vaultId: string, params: Record<string, string | undefined> = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return `/admin/knowledge/${vaultId}${s ? `?${s}` : ''}`;
};

/** A size in bytes, kilobytes or megabytes. */
export function sizeLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** What an activity row says it was: a history operation, or one of the service's own (`note.write`, `vault.import`). */
const ACTIVITY_OP: Record<string, string> = {
  'note.write': 'Wrote',
  'note.edit': 'Edited',
  'note.append': 'Added to',
  'daily.append': 'Added to daily note',
  'note.rename': 'Renamed',
  'note.delete': 'Deleted',
  'note.restore': 'Restored',
  'file.upload': 'Uploaded',
  'folder.create': 'Made folder',
  'vault.create': 'Created vault',
  'vault.update': 'Changed settings',
  'vault.delete': 'Deleted vault',
  'vault.import': 'Imported',
  'vault.export': 'Exported',
};
export function activityOp(op: string): string {
  return ACTIVITY_OP[op] ?? (OP_LABEL as Record<string, string>)[op] ?? op;
}
