// What a delivery changed, by area (T-102): the "Tools changed" hint of a chat session names what its running Claude Code process has not
// read. Worked out from the manifest the workspace had and the one being written: the pools (added, removed, a new revision), the files (a
// path whose content changed, came or went, attributed to the owner that may write it) and the plugin version folders. Nothing secret: owner
// names only, never a path, a value or a pool's name.

import { mayWrite, OWNERSHIP } from './ownership.js';
import { MANIFEST_PATH, type Manifest, type ManifestPlugin, type Owner } from './types.js';

const OWNERS = Object.keys(OWNERSHIP) as Owner[];

/** The owner that may write `path`: a pool type before the foundation (which owns the shared files), or null. */
function ownerOf(path: string): Owner | null {
  return OWNERS.find((o) => o !== 'foundation' && mayWrite(o, path)) ?? (mayWrite('foundation', path) ? 'foundation' : null);
}

const pluginKey = (p: ManifestPlugin) => `${p.owner}\u0000${p.name}\u0000${p.treeHash}`;

/**
 * The areas whose delivered content differs between `before` (what the workspace had; null for a first delivery) and `after`, in the
 * order of the ownership table, each once. The foundation is named only when nothing else explains the change (its catalog follows
 * every plugin change). A change nobody can be named for reads `other`.
 */
export function changedAreas(before: Manifest | null | undefined, after: Manifest): (Owner | 'other')[] {
  const found = new Set<Owner | 'other'>();
  const pools = (m: Manifest | null | undefined) => new Map((m?.pools ?? []).map((p) => [`${p.type}\u0000${p.id}`, p.revision]));
  const was = pools(before);
  const now = pools(after);
  for (const [key, rev] of now) if (was.get(key) !== rev) found.add(key.split('\u0000')[0] as Owner);
  for (const key of was.keys()) if (!now.has(key)) found.add(key.split('\u0000')[0] as Owner);

  const oldFiles = before?.files ?? {};
  const newFiles = after.files;
  let unexplained = false;
  for (const path of new Set([...Object.keys(oldFiles), ...Object.keys(newFiles)])) {
    if (path === MANIFEST_PATH || oldFiles[path] === newFiles[path]) continue;
    const owner = ownerOf(path);
    if (owner) found.add(owner);
    else unexplained = true;
  }

  const oldPlugins = new Set((before?.plugins ?? []).map(pluginKey));
  const newPlugins = new Set((after.plugins ?? []).map(pluginKey));
  for (const p of after.plugins ?? []) if (!oldPlugins.has(pluginKey(p))) found.add(p.owner);
  for (const p of before?.plugins ?? []) if (!newPlugins.has(pluginKey(p))) found.add(p.owner);

  if (found.size > 1) found.delete('foundation');
  if (unexplained && found.size === 0) found.add('other');
  const order = [...OWNERS, 'other'] as const;
  return order.filter((o) => found.has(o));
}
