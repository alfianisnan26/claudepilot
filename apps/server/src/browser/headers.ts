import { createHash } from 'node:crypto';
import { HEADER_SECRET_KEY, SECRET_ENTRY_NAME, type BrowserHeaderRule } from '@portal/contracts';

/**
 * Request headers from named secrets (browser & desktop PRD §24). The pool holds names only; this module turns them into what is
 * delivered: the value goes to the browser container (a root-only file) and nowhere else. Nothing here logs a value, and what is
 * hashed for the container's spec or written to the audit is names, hosts and value version ids, never a value.
 */

export const MAX_HEADERS = 10;
/** The extension's folder in the container (images/browser/cpb/headers-ext.mjs `EXT_DIR`): the policy allows the id derived from it. */
export const EXT_DIR = '/dev/shm/cpb-ext';
/** Where the browser container finds its headers, root-only (Docker: a file in the container; Kubernetes: a Secret volume). */
export const HEADERS_DIR = '/etc/cpb-secrets';
export const HEADERS_FILE = 'headers.json';

/** Names the browser or the server owns: never set from a secret. Same list as the container's builder. */
export const FORBIDDEN_HEADERS = new Set(['host', 'cookie', 'set-cookie', 'content-length', 'content-type', 'connection', 'transfer-encoding', 'upgrade', 'origin', 'referer', 'user-agent', 'te', 'trailer', 'expect', 'proxy-authorization']);
export const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/;

/** An unpacked extension's id comes from its folder's path: 32 hex digits of the SHA-256, mapped 0-f to a-p. */
export function extensionId(dir: string = EXT_DIR): string {
  return [...createHash('sha256').update(dir).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/** A header host pattern as `{ wildcard, host, port }`, or null when it isn't `host`, `host:port` or `*.domain`. */
function parseHost(pattern: string): { wildcard: boolean; host: string; port: string | null } | null {
  const m = HOST.exec(pattern.trim().toLowerCase());
  if (!m) return null;
  const port = m[6] ?? null;
  if (m[1] && port) return null;
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  return { wildcard: !!m[1], host: m[2] ?? '', port };
}

export const validHeaderHost = (pattern: string): boolean => parseHost(pattern) !== null;

/** An `allowedSites` entry as a host, ignoring a scheme and path. */
function siteOf(entry: string): { wildcard: boolean; host: string; port: string | null } | null {
  const bare = entry.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
  return parseHost(bare.startsWith('.') ? `*${bare}` : bare);
}

/**
 * Whether `allowedSites` covers a header's host: an entry for the same host (an entry without a port covers every port), or a `*.domain`
 * entry for a host or a `*.sub.domain` pattern under it. A header never goes to a host the pool doesn't already allow.
 */
export function coveredBy(hostPattern: string, allowedSites: string[]): boolean {
  const h = parseHost(hostPattern);
  if (!h) return false;
  return allowedSites.some((entry) => {
    const s = siteOf(entry);
    if (!s || (s.port && s.port !== h.port)) return false;
    if (!s.wildcard) return !h.wildcard && s.host === h.host;
    return h.host.endsWith(`.${s.host}`) || (h.wildcard && h.host === s.host);
  });
}

/** Save-time checks (the kind calls this): a message for the first problem, or null. */
export function headerProblem(rule: BrowserHeaderRule, allowedSites: string[]): string | null {
  if (!HEADER_NAME.test(rule.name)) return `“${rule.name.slice(0, 40)}” isn’t a header name (letters, digits and hyphens).`;
  if (FORBIDDEN_HEADERS.has(rule.name.toLowerCase())) return `The browser sets ${rule.name} itself: pick another header.`;
  if (!SECRET_ENTRY_NAME.test(rule.secret)) return `“${rule.secret.slice(0, 40)}” isn’t the name of a Secrets & env entry.`;
  if (rule.key !== undefined && !HEADER_SECRET_KEY.test(rule.key)) return `“${rule.key.slice(0, 40)}” isn’t a variable name (letters, digits and underscores).`;
  if (rule.hosts.length === 0) return `${rule.name}: list the hosts it goes to.`;
  if (rule.hosts.length > 20) return `${rule.name}: use at most 20 hosts.`;
  for (const host of rule.hosts) {
    if (!validHeaderHost(host)) return `“${host.slice(0, 40)}” isn’t a host: use app.example.com, app.example.com:8443 or *.example.com.`;
    if (!coveredBy(host, allowedSites)) return `${host} isn’t in the allowed sites: a header goes only to hosts the pool allows.`;
  }
  return null;
}

/** What the portal reads a secret by (Secrets & env, by name): `SecretsKind.secretByName`. */
export type SecretLookup = (name: string) => { ok: true; value: string; version: string } | { ok: false; why: string };

/** A header with its value, in memory between the lookup and the delivery. Never stored, hashed or logged. */
export interface ResolvedHeader {
  name: string;
  hosts: string[];
  secret: string;
  /** The variable inside an env-file entry, when the rule names one (T-623). */
  key?: string;
  value: string;
  /** The secret's value id: changes when the value does, and says nothing about it. */
  version: string;
}

export interface HeaderSkip {
  name: string;
  secret: string;
  key?: string;
  why: string;
}

/**
 * The value of `key` in an env-file entry (`KEY=VALUE` lines; `export ` allowed; blank lines and `#` comments skipped; one pair of matching
 * quotes stripped; a ` # note` after the value dropped; a leading BOM ignored; the last line for a key wins), or null when the key is absent or empty. In memory only: nothing here stores or logs.
 */
export function envFileValue(text: string, key: string): string | null {
  let found: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    // trim() also removes a leading byte-order mark (an editor's save), so it does not hide the first key (pinned by a test).
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m || m[1] !== key) continue;
    const rest = (m[2] ?? '').trim();
    // A quoted value ends at its closing quote (a `# note` after it is dropped); an unquoted one ends at whitespace followed by `#`.
    const q = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(rest);
    found = q ? (q[2] ?? '') : rest.replace(/(^|\s+)#.*$/, '');
  }
  return found ? found : null;
}

/**
 * The pool's header rules with their values. A rule whose secret can't be found (removed, renamed, in two sets, without a value) is left
 * out and listed in `skipped` with why, so a removed secret stops its header at the next delivery instead of leaving the old value.
 */
export function resolveHeaders(rules: BrowserHeaderRule[] | undefined, lookup: SecretLookup | undefined): { entries: ResolvedHeader[]; skipped: HeaderSkip[] } {
  const entries: ResolvedHeader[] = [];
  const skipped: HeaderSkip[] = [];
  for (const r of rules ?? []) {
    const found = lookup ? lookup(r.secret) : { ok: false as const, why: 'not found' };
    const keyed = r.key !== undefined ? { key: r.key } : {};
    if (!found.ok) {
      skipped.push({ name: r.name, secret: r.secret, ...keyed, why: found.why });
      continue;
    }
    let value = found.value;
    if (r.key !== undefined) {
      const v = envFileValue(found.value, r.key);
      // The reason names the key and the entry, never a value (and never what the entry held in place of the key).
      if (v === null) { skipped.push({ name: r.name, secret: r.secret, ...keyed, why: `the entry has no ${r.key}` }); continue; }
      value = v;
    }
    entries.push({ name: r.name, hosts: [...r.hosts], secret: r.secret, ...keyed, value, version: found.version });
  }
  return { entries, skipped };
}

/** `headers.json` as the container reads it. This is the only place a value is written out. */
export function headersFile(entries: ResolvedHeader[]): string {
  return `${JSON.stringify(entries.map((e) => ({ hosts: e.hosts, name: e.name, value: e.value })))}\n`;
}

/** What goes into a container's spec hash and the audit: names, hosts, secret names and value versions. Never a value. */
export function headersSpec(entries: ResolvedHeader[]): { name: string; hosts: string[]; secret: string; key?: string; version: string }[] {
  return entries.map(({ name, hosts, secret, key, version }) => ({ name, hosts, secret, ...(key !== undefined ? { key } : {}), version })).sort((a, b) => a.name.localeCompare(b.name) || a.secret.localeCompare(b.secret));
}

/** A one-line summary for the audit and the browser's row: names only. */
export function headersSummary(entries: ResolvedHeader[], skipped: HeaderSkip[]): { headers: { name: string; secret: string; key?: string; hosts: string[] }[]; skipped: HeaderSkip[] } {
  return { headers: entries.map(({ name, secret, key, hosts }) => ({ name, secret, ...(key !== undefined ? { key } : {}), hosts })), skipped };
}
