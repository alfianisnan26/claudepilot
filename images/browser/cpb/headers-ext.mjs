#!/usr/bin/env node
// Request headers from named secrets (browser & desktop PRD §24). Dependency-free Node, used by the root init and, as a CLI, run as
// uid 1000 to write the extension Chromium loads. The values come from `/etc/cpb-secrets/headers.json` (root-only, written by the
// portal), reach this file by stdin, and end up only in the extension's static ruleset: a declarativeNetRequest `modifyHeaders` rule per
// host pattern, so the header is added in Chromium's network stack for requests over https to those hosts and no others. Nothing here
// logs or prints a value.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Memory-backed in both runtimes (Docker's `ShmSize`, the pod's `/dev/shm` emptyDir); gone with the container. */
export const EXT_DIR = '/dev/shm/cpb-ext';

/** An unpacked extension's id is derived from its folder's path: 32 hex digits of the SHA-256, mapped 0-f to a-p. */
export function extensionId(dir = EXT_DIR) {
  return [...createHash('sha256').update(dir).digest('hex').slice(0, 32)].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

/** Header names Chromium and servers treat as the browser's own: never set from a secret. */
export const FORBIDDEN = new Set(['host', 'cookie', 'set-cookie', 'content-length', 'content-type', 'connection', 'transfer-encoding', 'upgrade', 'origin', 'referer', 'user-agent', 'te', 'trailer', 'expect', 'proxy-authorization']);
export const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * A host pattern as a regular expression over the whole URL (RE2, anchored to https): `host` and `host:port` match that host exactly,
 * `*.domain` matches its subdomains, not the domain itself. A subdomain never matches an exact host, and `https://host@other/` can't
 * pass (the host must be followed by a port or the path). Null when the pattern isn't one of these shapes.
 */
export function hostRegex(pattern) {
  const m = /^(\*\.)?([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(String(pattern).trim().toLowerCase());
  if (!m || !DOMAIN.test(m[2]) || (m[1] && m[3])) return null;
  if (m[3] && (Number(m[3]) < 1 || Number(m[3]) > 65535)) return null;
  const host = m[2].replace(/\./g, '\\.');
  const port = m[3] ? `:${m[3]}` : '(:[0-9]+)?';
  return m[1] ? `^https://[a-z0-9-]+(\\.[a-z0-9-]+)*\\.${host}${port}/` : `^https://${host}${port}/`;
}

const TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'];

/**
 * The extension's two files from `[{ hosts, name, value }]`. An entry that isn't valid (a name that isn't a header token or is one the
 * browser owns, a value with a line break or control character, a host that isn't a host pattern) is dropped, and its name returned in
 * `dropped` (never its value), so a bad file can't turn into a header injection.
 */
export function buildExtension(entries) {
  const byHost = new Map();
  const dropped = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const name = typeof e?.name === 'string' ? e.name : '';
    const value = typeof e?.value === 'string' ? e.value : '';
    const hosts = Array.isArray(e?.hosts) ? e.hosts.filter((h) => typeof h === 'string') : [];
    // eslint-disable-next-line no-control-regex
    const bad = !HEADER_NAME.test(name) || FORBIDDEN.has(name.toLowerCase()) || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) || !hosts.length || hosts.some((h) => !hostRegex(h));
    if (bad) {
      dropped.push(name.slice(0, 64));
      continue;
    }
    for (const h of hosts) {
      const key = hostRegex(h);
      const list = byHost.get(key) ?? new Map();
      list.set(name.toLowerCase(), { header: name, operation: 'set', value });
      byHost.set(key, list);
    }
  }
  const rules = [...byHost].map(([regexFilter, headers], i) => ({
    id: i + 1,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [...headers.values()] },
    condition: { regexFilter, isUrlFilterCaseSensitive: false, resourceTypes: TYPES },
  }));
  const manifest = {
    manifest_version: 3,
    name: 'cpb headers',
    version: '1.0',
    description: 'Adds request headers from named secrets for some hosts (ClaudePilot browser pool).',
    permissions: ['declarativeNetRequest'],
    host_permissions: ['<all_urls>'],
    declarative_net_request: { rule_resources: [{ id: 'headers', enabled: true, path: 'rules.json' }] },
  };
  return { manifest, rules, dropped, count: rules.length };
}

/** Writes the extension into `dir` (made fresh, 0700, files 0400): run as the user Chromium runs as. */
export function writeExtension(entries, dir = EXT_DIR) {
  const built = buildExtension(entries);
  rmSync(dir, { recursive: true, force: true });
  if (!built.count) return built;
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(built.manifest, null, 2)}\n`, { mode: 0o400 });
  writeFileSync(join(dir, 'rules.json'), `${JSON.stringify(built.rules)}\n`, { mode: 0o400 });
  return built;
}

// `node headers-ext.mjs write [dir]`: the entries as JSON on stdin; prints `{ count, dropped }` (names only) on stdout.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'write') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    try {
      const { count, dropped } = writeExtension(JSON.parse(input || '[]'), process.argv[3] || EXT_DIR);
      process.stdout.write(`${JSON.stringify({ count, dropped })}\n`);
    } catch (e) {
      process.stderr.write(`headers: ${e instanceof SyntaxError ? 'the headers file is not JSON' : e.message}\n`);
      process.exit(1);
    }
  });
}
