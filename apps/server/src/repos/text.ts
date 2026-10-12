// Workspace git: what is done to every piece of text that came out of a workspace before the portal keeps or shows it
// (docs/prd/workspace-git.md §12). Branch names, commit subjects, author names, paths and remote URLs are written by whoever
// can write in the workspace, an agent included: they are checked, cleaned and clipped here, and shown as plain text.

import { createHash } from 'node:crypto';

/** Control characters, line and paragraph separators, and the bidirectional overrides that make text read as something it isn't. */
const UNSAFE_CHARS = '\\u{0}-\\u{1f}\\u{7f}-\\u{9f}\\u{2028}\\u{2029}\\u{200e}\\u{200f}\\u{202a}-\\u{202e}\\u{2066}-\\u{2069}\\u{feff}';
const UNSAFE_ALL = new RegExp(`[${UNSAFE_CHARS}]`, 'gu');
const UNSAFE_ANY = new RegExp(`[${UNSAFE_CHARS}]`, 'u');
/** Characters no name or path may hold: controls and DEL (and, in a ref name, the space). */
const CONTROL = /[\u{0}-\u{1f}\u{7f}]/u;

/** One line of plain text no longer than `max` characters: unsafe characters out, runs of space folded, an ellipsis where it was cut. */
export function plain(text: unknown, max: number): string {
  if (typeof text !== 'string') return '';
  const t = text.replace(UNSAFE_ALL, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...t];
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : t;
}

/** The id of the repository whose working folder is `path`: stable while it stays there (PRD §5). */
export function repoId(workspaceId: string, path: string): string {
  return `r_${createHash('sha256').update(`${workspaceId}\0${path}`).digest('hex').slice(0, 12)}`;
}

export const REPO_ID = /^r_[0-9a-f]{12}$/;

/** A commit id as git prints it (SHA-1 or SHA-256). */
export const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 12) : '');

/**
 * A URL with what could be a credential taken out: `user:password@`, the query and the fragment. Anything with a control
 * character is dropped (empty). The result is for display and for matching a local remote, never for connecting.
 */
export function cleanUrl(url: unknown, max = 300): string {
  if (typeof url !== 'string' || UNSAFE_ANY.test(url)) return '';
  let u = url.trim();
  u = u.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/]*@/, '$1');
  u = u.replace(/[?#].*$/, '');
  return plain(u, max);
}

/** The name of the workspace-local remote a URL points at (`~/.claudepilot/git/<name>.git`, local-git-ci FR1), or null. */
export function localRemoteName(url: string): string | null {
  const m = /(?:^|\/)\.claudepilot\/git\/([a-z0-9][a-z0-9._-]{0,63})\.git\/?$/.exec(url.replace(/^file:\/\//, ''));
  return m ? m[1]! : null;
}

/** A branch or remote name as git allows them: no control characters, spaces or the characters refs may not have. */
export function validRefName(name: unknown, max = 200): string | null {
  if (typeof name !== 'string' || !name || name.length > max) return null;
  if (CONTROL.test(name) || /[ ~^:?*[\\]/.test(name) || name.includes('..') || name.startsWith('-')) return null;
  return name;
}

/** An absolute, normalised path without control characters or `..` parts (as the host prints real paths); null otherwise. */
export function absPath(p: unknown, max = 400): string | null {
  if (typeof p !== 'string' || !p.startsWith('/') || p.length > max) return null;
  if (CONTROL.test(p)) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '.')) return null;
  const out = `/${parts.filter(Boolean).join('/')}`;
  return out;
}

/** A path inside a repository as git records it: relative, no `..`, no control characters. */
export function relPath(p: unknown, max = 300): string | null {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.startsWith('"') || p.length > max) return null;
  if (CONTROL.test(p)) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '.' || s === '')) return null;
  return p;
}

export const dirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};

export const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || p;

/** Whether `inner` is `outer` or inside it. */
export const within = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(outer === '/' ? '/' : `${outer}/`);

export const toInt = (v: unknown, max = Number.MAX_SAFE_INTEGER): number | null => {
  if (typeof v !== 'string' || !/^\d{1,15}$/.test(v)) return null;
  const n = Number(v);
  return n > max ? max : n;
};
