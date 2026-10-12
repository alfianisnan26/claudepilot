// Normalising an event (docs/prd/triggers.md §7 step 1, §9, FR8): every source becomes `TriggerEventFacts`. A fact is either validated
// (a login, a repository name, a branch, a sha, a number, an https link on the trigger's Git host) or null; free text goes in `untrusted`,
// cleaned (control, zero-width and bidi characters removed), clipped (title 300, the rest 4,000) and redacted with the chat redactor.
// Nothing here throws on hostile input: a field that does not validate is null.

import type { TriggerEventFacts, WebhookEvent, WebhookProvider } from '@portal/contracts';
import { redact } from '../chat/redact.js';

/** What a provider's payload became: an event for the pipeline, or a delivery that is acknowledged and dropped. */
export type Normalized =
  | {
      kind: 'event';
      facts: TriggerEventFacts;
      /** The label names (cleaned), for the label filter; their text is also in `facts.untrusted.labels`. */
      labels: string[];
    }
  | { kind: 'ignore'; why: 'ping' | 'tag' | 'deleted' | 'unknown_event' | 'unsupported_action' | 'invalid_event' };

export const TITLE_MAX = 300;
export const TEXT_MAX = 4000;

// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

/** Free text made safe to quote: invisible and direction characters out, CR folded, clipped, redacted. Null for nothing. */
export function untrustedText(v: unknown, max = TEXT_MAX): string | undefined {
  if (typeof v !== 'string') return undefined;
  let s = v.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').trim();
  if (!s) return undefined;
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return redact(s);
}

/** A one-line, short form of free text (a label name): never a newline. */
export function oneLine(v: unknown, max = 60): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

export const LOGIN = /^[A-Za-z0-9._-]{1,64}$/;
/** A Git host login, or null (R12): control characters, more than 64 characters or anything outside the set is null. */
export const login = (v: unknown): string | null => (typeof v === 'string' && LOGIN.test(v) ? v : null);

/** `owner/name` (GitLab: groups and subgroups). */
export const repoName = (v: unknown): string | null =>
  typeof v === 'string' && v.length <= 200 && /^[A-Za-z0-9_.-]{1,100}(?:\/[A-Za-z0-9_.-]{1,100}){1,6}$/.test(v) && !v.split('/').some((p) => p === '.' || p === '..') ? v : null;

/** A branch name as git allows it, conservatively: no control characters, spaces, `..`, `~^:?*[\`, no leading `-` or `/`. */
export function branchName(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 200) return null;
  const b = v.startsWith('refs/heads/') ? v.slice('refs/heads/'.length) : v;
  if (!/^[A-Za-z0-9._/+@=-]{1,200}$/.test(b) || b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.lock') || b.includes('..') || b.includes('//') || b.includes('@{')) return null;
  return b;
}

export const sha = (v: unknown): string | null => (typeof v === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v) ? v : null);
export const ZERO_SHA = /^0+$/;

export const positiveInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1e9 ? v : null);

/** The host a trigger's links must be on: GitHub's when none is named. */
export function hostOf(provider: WebhookProvider, host: string | null): string | null {
  if (host) return host.toLowerCase();
  return provider === 'github' ? 'github.com' : null;
}

/** An https link on exactly that host (R13): another host, `http:`, credentials in it or a bad URL is null. */
export function linkOn(v: unknown, host: string | null): string | null {
  if (!host || typeof v !== 'string' || v.length > 500) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.username || u.password || u.host.toLowerCase() !== host) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** A header value that is an id: printable, short; anything else (CR, LF, long values) is ignored (R11). */
export const headerId = (v: string | null | undefined): string | null => (typeof v === 'string' && /^[A-Za-z0-9._:=+/-]{1,128}$/.test(v) ? v : null);

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Commit messages, newest last, as one text. */
export function commitsText(commits: unknown): string | undefined {
  const lines = arr(commits)
    .slice(0, 50)
    .map((c) => (typeof obj(c).message === 'string' ? (obj(c).message as string) : ''))
    .filter(Boolean);
  return untrustedText(lines.join('\n---\n'));
}

/** Label names, cleaned; and their text for the quoted block. */
export function labelsOf(list: unknown, key: 'name' | 'title'): { names: string[]; text: string | undefined } {
  const names = arr(list)
    .slice(0, 50)
    .map((l) => oneLine(obj(l)[key]))
    .filter((x): x is string => !!x);
  return { names, text: untrustedText(names.join(', ')) };
}

/** The facts every webhook event shares, with nothing filled. */
export function blankFacts(provider: WebhookProvider, event: WebhookEvent, at: string): TriggerEventFacts {
  return { source: 'webhook', provider, event, action: null, repo: null, branch: null, sha: null, number: null, sender: null, url: null, fork: null, at, untrusted: {} };
}

/** Drops the undefined text fields (a quoted block lists only what the event had). */
export function compactUntrusted(u: TriggerEventFacts['untrusted']): TriggerEventFacts['untrusted'] {
  const out: TriggerEventFacts['untrusted'] = {};
  for (const [k, v] of Object.entries(u) as [keyof TriggerEventFacts['untrusted'], string | undefined][]) if (v) out[k] = v;
  return out;
}

/** Shape check for facts that come back from the database or a test sample: anything unexpected becomes null. */
export function sanitizeFacts(raw: unknown, fallback: TriggerEventFacts): TriggerEventFacts {
  const r = obj(raw);
  const u = obj(r.untrusted);
  return {
    ...fallback,
    action: typeof r.action === 'string' && /^[a-z_]{1,24}$/.test(r.action) ? r.action : fallback.action,
    repo: r.repo === undefined ? fallback.repo : repoName(r.repo),
    branch: r.branch === undefined ? fallback.branch : branchName(r.branch),
    sha: r.sha === undefined ? fallback.sha : sha(r.sha),
    number: r.number === undefined ? fallback.number : positiveInt(r.number),
    sender: r.sender === undefined ? fallback.sender : login(r.sender),
    url: r.url === undefined ? fallback.url : typeof r.url === 'string' && /^https:\/\//.test(r.url) && r.url.length <= 500 ? r.url : null,
    fork: typeof r.fork === 'boolean' ? r.fork : fallback.fork,
    untrusted: compactUntrusted({
      title: untrustedText(u.title, TITLE_MAX) ?? fallback.untrusted.title,
      body: untrustedText(u.body) ?? fallback.untrusted.body,
      comment: untrustedText(u.comment) ?? fallback.untrusted.comment,
      commits: untrustedText(u.commits) ?? fallback.untrusted.commits,
      labels: untrustedText(u.labels) ?? fallback.untrusted.labels,
      logTail: untrustedText(u.logTail) ?? fallback.untrusted.logTail,
    }),
  };
}

/** A glob over one segment set: `*` matches within a segment (not `/`), `**` matches across. Case-sensitive like git. */
export function globMatch(pattern: string, value: string): boolean {
  const re = pattern
    .split('**')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${re}$`).test(value);
}

/** Repository patterns compare without case (hosts treat `Owner/Name` and `owner/name` as one). */
export const repoMatch = (pattern: string, repo: string): boolean => globMatch(pattern.toLowerCase(), repo.toLowerCase());
