import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from '@isnanme/core';
import type { McpAuthMode, McpEntryKind, McpOAuthFields, McpRiskFlag, McpSlot, McpTransport, McpVersionSpec } from '@portal/contracts';
import { claudeFeature, claudeMinimum, MCP_SERVER_KEY_MAX, MCP_SLUG_MAX } from '@portal/contracts';
import { embeddedIPv4, isPrivateAddress } from '../accounts/check.js';
import { redact } from '../chat/redact.js';

/**
 * What a catalog version may say, and what it runs (MCP set PRD FR1–FR3, FR5). Pure: the catalog and
 * the compiler both use it, so the review shows exactly the command a workspace gets.
 */

/** MCP sets need the foundation's minimum, where every ✅ claim was observed (FR14). */
export const MCP_MIN_CLAUDE = claudeMinimum('mcp-sets');
/** `claude plugin details` prints text only; its layout is known for the pinned version (FR16). */
export const VERIFY_TESTED_CLAUDE = claudeFeature('mcp-sets').observedOn;

export const BIN_DIR = '/etc/claudepilot/bin';
export const LAUNCHER = `${BIN_DIR}/mcp-launch`;
export const HEADERS_HELPER = `${BIN_DIR}/mcp-headers`;
export const SECRET_FILES = '/etc/claudepilot/secrets/files';
export const NPM_REGISTRY = 'https://registry.npmjs.org/';
/** A first-use install must finish inside it (§10.2): 60 s instead of Claude Code's 30 s. */
export const MCP_TIMEOUT_MS = '60000';

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Kebab-case: plugin names must be (ownership's `mayNamePlugin`), and server keys follow suit. */
export const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Server names Claude Code keeps for itself (FR5), in key form. */
const RESERVED_KEYS = new Set(['workspace', 'claude-in-chrome', 'computer-use', 'claude-preview', 'claude-browser']);

export function slugProblem(slug: string): string | null {
  if (!slug) return 'Give the set a short ID.';
  if (slug.length > MCP_SLUG_MAX) return `Use at most ${MCP_SLUG_MAX} characters.`;
  if (!KEY.test(slug)) return 'Use lowercase letters, digits and single dashes.';
  return null;
}

export function serverKeyProblem(key: string): string | null {
  if (!key) return 'Give the server a key.';
  if (key.length > MCP_SERVER_KEY_MAX) return `Use at most ${MCP_SERVER_KEY_MAX} characters.`;
  if (!KEY.test(key)) return 'Use lowercase letters, digits and single dashes.';
  if (RESERVED_KEYS.has(key)) return `“${key}” is a name Claude Code keeps for itself.`;
  return null;
}

/** A set's slug from its name: `Team tools` → `team-tools`, cut to 12 characters. */
export function slugFrom(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MCP_SLUG_MAX)
    .replace(/-+$/g, '');
  return s || 'set';
}

/* ---------- Versions ---------- */

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/** An exact version: no ranges, tags or `latest` (FR1). Prereleases pass; build metadata npm ignores, so no. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const BIN = /^[A-Za-z0-9@._-]{1,100}$/;
const PATH = /^\/[A-Za-z0-9._/+-]{1,500}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** Variables a slot may not set: the launcher's own, ones that change how programs load, and npm's config (§12). */
const RESERVED_ENV = /^(?:PATH|HOME|SHELL|ENV|BASH_ENV|PROMPT_COMMAND|NODE_OPTIONS|NODE_PATH|LD_.*|CLAUDEPILOT_.*|CLAUDE_.*|npm_config_.*|NPM_CONFIG_.*)$/;
/** Headers the transport owns. */
const RESERVED_HEADERS = new Set(['host', 'content-type', 'content-length', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'connection', 'transfer-encoding']);

export const npmTarget = (pkg: string, version: string) => `npm:${pkg}@${version}`;
export const commandTarget = (path: string) => `cmd:${path}`;

export function exactVersionProblem(version: string): string | null {
  if (!version) return 'Enter the exact version, like 1.4.2.';
  if (EXACT.test(version) && version.length <= 64) return null;
  if (/^(?:latest|next|beta|canary)$/i.test(version) || /[\^~<>=*| ]|\.x\b/i.test(version))
    return 'Use an exact version, like 1.4.2: ranges, tags and latest change under you.';
  return 'Use an exact version, like 1.4.2.';
}

/** A plain, non-secret text field: one line, no control characters, capped. */
function text(input: unknown, field: string, max: number, opts: { optional?: boolean } = {}): string | undefined {
  if (input === undefined || input === null || input === '') {
    if (opts.optional) return undefined;
    throw invalid(field, 'Fill this in.');
  }
  if (typeof input !== 'string') throw invalid(field, 'Use text.');
  const s = input.trim();
  if (!s && opts.optional) return undefined;
  if (!s) throw invalid(field, 'Fill this in.');
  if (s.length > max) throw invalid(field, `Use at most ${max} characters.`);
  if (CONTROL.test(s)) throw invalid(field, 'Use a single line without control characters.');
  return s;
}

/** Arguments are visible in `ps` and logs (FR2), so anything credential-shaped is refused. */
function args(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some((a) => typeof a !== 'string')) throw invalid('spec.args', 'Arguments are a list of text.');
  if (input.length > 50) throw invalid('spec.args', 'Use at most 50 arguments.');
  return (input as string[]).map((a, i) => {
    if (a.length > 1000 || CONTROL.test(a)) throw invalid('spec.args', `Argument ${i + 1} is too long or has control characters.`);
    if (redact(a) !== a || a.includes('{{secret-file:')) throw invalid('spec.args', `Argument ${i + 1} looks like a secret. Put secrets in a secret slot: arguments show in ps and logs.`);
    if (/\$\{[^}]*\}/.test(a)) throw invalid('spec.args', `Argument ${i + 1} uses \${…}, which isn't expanded here.`);
    return a;
  });
}

export interface UrlCheck {
  /** Refuse URLs at or under this one (the portal's own MCP endpoint, PRD §6). */
  portalUrl?: string | null;
}

/** Anthropic-hosted connectors "don't support local OAuth" (FR1): they belong to claude.ai. */
const ANTHROPIC_HOSTS = /(?:^|\.)(?:anthropic\.com|claude\.ai|claude\.com)$/i;
/** Cloud metadata endpoints: never an MCP server, even on a private network. */
const METADATA = new Set(['169.254.169.254', 'fd00:ec2::254', '100.100.100.200', 'metadata.google.internal']);
/**
 * Whether an address or host is a metadata endpoint in any spelling (QA-003): an IPv4-mapped or NAT64 IPv6
 * address carries the IPv4 inside (`::ffff:a9fe:a9fe` is 169.254.169.254), so the text isn't compared alone.
 */
const isMetadata = (addr: string) => METADATA.has(addr.toLowerCase()) || METADATA.has(embeddedIPv4(addr.toLowerCase()) ?? '');

/** A remote server's URL, normalized: https (or http, flagged), no credentials or fragment, nothing credential-shaped. */
export function normalizeRemoteUrl(input: unknown, check: UrlCheck = {}): string {
  const raw = text(input, 'spec.url', 2000)!;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('spec.url', 'Enter a full URL, like https://mcp.example.com/mcp.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid('spec.url', 'Use an https URL.');
  if (url.username || url.password) throw invalid('spec.url', 'Don’t put credentials in the URL: use a header slot.');
  if (url.hash) throw invalid('spec.url', 'Leave out the fragment.');
  if (redact(url.href) !== url.href || /\$\{|\{\{/.test(decodeURIComponent(url.href))) throw invalid('spec.url', 'The URL looks like it holds a secret: URLs show in logs. Use a header slot.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (ANTHROPIC_HOSTS.test(host)) throw invalid('spec.url', 'Anthropic-hosted connectors don’t support local OAuth. Use them from claude.ai.');
  if (isMetadata(host)) throw invalid('spec.url', 'That is a cloud metadata address, not an MCP server.');
  if (check.portalUrl) {
    const portal = new URL(check.portalUrl);
    if (portal.host === url.host && url.pathname.startsWith(portal.pathname.replace(/\/+$/, '') || '/'))
      throw invalid('spec.url', 'That is this portal’s own address. Its admin MCP endpoint can’t go in a set.');
  }
  return url.href;
}

/**
 * The SSRF guard (Account Pool's custom hosts, §13.1): a remote server must be on a public address
 * unless its entry allows private networks. Resolves the name once; a host that changes its answer
 * later isn't caught, which is acceptable for an admin-only portal.
 */
export async function assertPublicUrl(url: string, allowPrivate: boolean): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (isMetadata(host)) throw invalid('spec.url', 'That is a cloud metadata address, not an MCP server.');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.some(isMetadata)) throw invalid('spec.url', 'That name points at a cloud metadata address.');
  if (allowPrivate) return;
  if (addresses.some(isPrivateAddress))
    throw invalid('spec.url', `${host} is a private address. Turn on “Allow private network” for this server to use it.`);
}

function oauth(input: unknown): McpOAuthFields | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isObject(input)) throw invalid('spec.oauth', 'OAuth settings are an object.');
  if ('clientSecret' in input || 'client_secret' in input)
    throw invalid('spec.oauth', 'Servers that need an OAuth client secret can’t be delivered: each workspace would hold it.');
  const out: McpOAuthFields = {};
  const clientId = text(input.clientId, 'spec.oauth.clientId', 200, { optional: true });
  if (clientId) out.clientId = clientId;
  if (input.callbackPort !== undefined && input.callbackPort !== null && input.callbackPort !== '') {
    const port = Number(input.callbackPort);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw invalid('spec.oauth.callbackPort', 'Use a port between 1024 and 65535.');
    out.callbackPort = port;
  }
  if (input.scopes !== undefined && input.scopes !== null) {
    if (!Array.isArray(input.scopes) || input.scopes.some((s) => typeof s !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(s)))
      throw invalid('spec.oauth.scopes', 'Scopes are a list of words without spaces.');
    if (input.scopes.length) out.scopes = input.scopes as string[];
  }
  const meta = text(input.authServerMetadataUrl, 'spec.oauth.authServerMetadataUrl', 2000, { optional: true });
  if (meta) {
    let url: URL | null = null;
    try {
      url = new URL(meta);
    } catch {
      // refused below
    }
    if (!url || url.protocol !== 'https:' || url.username || url.password) throw invalid('spec.oauth.authServerMetadataUrl', 'Use an https URL without credentials.');
    out.authServerMetadataUrl = url.href;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * A version's spec for its entry's kind (FR1), with only the fields that kind uses. PyPI waits for `uv`
 * in the image (M4). URL checks that need DNS are separate (`assertPublicUrl`).
 */
export function parseSpec(kind: McpEntryKind, input: unknown, check: UrlCheck = {}): McpVersionSpec {
  if (!isObject(input)) throw invalid('spec', 'Describe what the server runs.');
  switch (kind) {
    case 'npm': {
      const pkg = text(input.package, 'spec.package', 214)!;
      if (!NPM_NAME.test(pkg)) throw invalid('spec.package', 'Use an npm package name, like @scope/server.');
      const bin = text(input.bin, 'spec.bin', 100, { optional: true });
      if (bin && !BIN.test(bin)) throw invalid('spec.bin', 'Use the command’s name only.');
      const out: McpVersionSpec = { package: pkg, args: args(input.args) };
      if (bin) out.bin = bin;
      if (input.allowScripts === true) out.allowScripts = true;
      return out;
    }
    case 'command': {
      const path = text(input.path, 'spec.path', 500)!;
      if (!PATH.test(path) || path.split('/').includes('..')) throw invalid('spec.path', 'Use an absolute path to a program in the image, like /usr/local/bin/server.');
      return { path, args: args(input.args) };
    }
    case 'remote': {
      const url = normalizeRemoteUrl(input.url, check);
      const transport: McpTransport = input.transport === 'sse' ? 'sse' : 'http';
      const auth: McpAuthMode = input.auth === 'headers' || input.auth === 'oauth' ? input.auth : 'none';
      const out: McpVersionSpec = { url, transport, auth };
      if (auth === 'oauth') {
        const o = oauth(input.oauth);
        if (o) out.oauth = o;
      }
      if (input.allowPrivateNetwork === true) out.allowPrivateNetwork = true;
      return out;
    }
    case 'pypi':
      throw invalid('kind', 'PyPI servers need uv in the workspace image, which comes in a later release.');
  }
}

/** Slots (FR2): stdio servers take variables and secret file paths, remote servers take headers. */
export function parseSlots(kind: McpEntryKind, input: unknown, spec: McpVersionSpec): McpSlot[] {
  if (input === undefined || input === null) input = [];
  if (!Array.isArray(input)) throw invalid('slots', 'Slots are a list.');
  if (input.length > 40) throw invalid('slots', 'Use at most 40 slots.');
  const remote = kind === 'remote';
  const seen = new Set<string>();
  const slots = (input as unknown[]).map((raw, i): McpSlot => {
    const field = `slots.${i}`;
    if (!isObject(raw)) throw invalid(field, 'Each slot is an object.');
    const target = raw.target === 'header' || raw.target === 'path' ? raw.target : 'env';
    if (remote && target !== 'header') throw invalid(`${field}.target`, 'Remote servers take headers.');
    if (!remote && target === 'header') throw invalid(`${field}.target`, 'Only remote servers take headers.');
    const name = text(raw.name, `${field}.name`, 128)!;
    if (target === 'header') {
      if (!HEADER_NAME.test(name)) throw invalid(`${field}.name`, 'Use a header name, like Authorization.');
      if (RESERVED_HEADERS.has(name.toLowerCase())) throw invalid(`${field}.name`, `The transport sets ${name} itself.`);
    } else {
      if (!ENV_NAME.test(name)) throw invalid(`${field}.name`, 'Use a variable name: letters, digits and underscores.');
      if (RESERVED_ENV.test(name)) throw invalid(`${field}.name`, `${name} is reserved: the launcher sets it, or it changes how programs load.`);
    }
    const key = target === 'header' ? name.toLowerCase() : name;
    if (seen.has(key)) throw invalid(`${field}.name`, `${name} is listed twice.`);
    seen.add(key);
    // A path slot hands over a secret file's path: always a Secrets & env file.
    const secret = target === 'path' ? true : raw.secret === true;
    const slot: McpSlot = { name, target, secret, required: raw.required === true };
    const description = text(raw.description, `${field}.description`, 300, { optional: true });
    if (description) slot.description = description;
    const docUrl = text(raw.docUrl, `${field}.docUrl`, 500, { optional: true });
    if (docUrl) {
      if (!/^https?:\/\//.test(docUrl)) throw invalid(`${field}.docUrl`, 'Use a web address.');
      slot.docUrl = docUrl;
    }
    if (raw.default !== undefined && raw.default !== null && raw.default !== '') {
      if (secret) throw invalid(`${field}.default`, 'Secret slots have no default: each set picks a secret.');
      slot.default = configValue(raw.default, `${field}.default`);
    }
    if (target === 'header') {
      const template = text(raw.template, `${field}.template`, 200, { optional: true }) ?? '{value}';
      if (template.split('{value}').length !== 2) throw invalid(`${field}.template`, 'Put {value} exactly once, like Bearer {value}.');
      if (template !== '{value}') slot.template = template;
    }
    return slot;
  });
  if (remote && spec.auth === 'headers' && !slots.some((s) => s.target === 'header')) throw invalid('slots', 'Header auth needs at least one header slot.');
  if (remote && spec.auth !== 'headers' && slots.some((s) => s.secret)) throw invalid('slots', 'Secret headers need auth “headers”.');
  return slots;
}

/** A non-secret value, written literally (§10.1): one line, nothing credential-shaped, no `${…}` (nothing expands it here). */
export function configValue(input: unknown, field: string): string {
  if (typeof input !== 'string') throw invalid(field, 'Use text.');
  if (input.length > 2000 || CONTROL.test(input)) throw invalid(field, 'Use one line of at most 2,000 characters.');
  if (/\$\{[^}]*\}/.test(input)) throw invalid(field, 'Variables aren’t expanded here. Reference a secret as {{secret-file:NAME}}, or type the value.');
  if (input.includes('{{secret-file:')) throw invalid(field, 'This slot isn’t secret: type the value, or make the slot secret.');
  if (redact(input) !== input) throw invalid(field, 'This looks like a secret. Make the slot secret and reference a Secrets & env entry.');
  return input;
}

/* ---------- What a version runs ---------- */

const shq = (s: string) => (/^[A-Za-z0-9@%+=:,./_-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The launcher's target for a stdio version; null for remote servers. */
export function targetOf(kind: McpEntryKind, version: string, spec: McpVersionSpec): string | null {
  if (kind === 'npm' && spec.package) return npmTarget(spec.package, version);
  if (kind === 'command' && spec.path) return commandTarget(spec.path);
  return null;
}

/**
 * The exact command (or URL) a workspace runs, untruncated, for the review (FR3): for npm, what the
 * launcher runs on first use (a pre-installed copy is the same package at the same version).
 */
export function commandOf(kind: McpEntryKind, version: string, spec: McpVersionSpec): string {
  if (kind === 'remote') return `${spec.url ?? ''} (${spec.transport === 'sse' ? 'SSE' : 'streamable HTTP'}${spec.auth && spec.auth !== 'none' ? `, auth ${spec.auth}` : ''})`;
  if (kind === 'command') return [spec.path ?? '', ...(spec.args ?? [])].map(shq).join(' ');
  if (kind === 'npm') {
    const pkgSpec = `${spec.package}@${version}`;
    const run = spec.bin ? ['--package', pkgSpec, spec.bin] : [pkgSpec];
    return [
      ...(spec.allowScripts ? [] : ['npm_config_ignore_scripts=true']),
      'npx',
      '--yes',
      '--registry',
      NPM_REGISTRY,
      '--userconfig',
      '/dev/null',
      ...run,
      ...(spec.args ?? []),
    ]
      .map(shq)
      .join(' ');
  }
  return '';
}

/** The browser pool's local ports (Browser & desktop §13): a server aimed at them would drive its browser. */
const BROWSER_PORTS = /(?:127\.0\.0\.1|localhost|\[::1\]):(9220|9222|8930)\b/;

/** Risky patterns the review flags (FR3). */
export function riskFlags(kind: McpEntryKind, spec: McpVersionSpec): McpRiskFlag[] {
  const flags: McpRiskFlag[] = [];
  const add = (code: string, label: string) => flags.some((f) => f.code === code) || flags.push({ code, label });
  const words = [spec.path ?? '', ...(spec.args ?? [])];
  const all = words.join(' ');
  if (words.some((w) => /(?:^|\/)sudo$/.test(w)) || /\bsudo\b/.test(all)) add('sudo', 'Runs sudo');
  if (/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i.test(all) || (words.includes('rm') && words.some((w) => /^-[a-z]*r/i.test(w)))) add('rm_rf', 'Deletes files (rm -rf)');
  if (/\|\s*(?:sh|bash|zsh|dash)\b/.test(all) || (words.some((w) => /^(?:\/bin\/|\/usr\/bin\/)?(?:sh|bash)$/.test(w)) && words.includes('-c'))) add('shell_pipe', 'Runs a shell command');
  if (words.some((w) => /(?:^|\/)(?:curl|wget)$/.test(w)) || /\b(?:curl|wget)\b/.test(all)) add('download', 'Downloads with curl or wget');
  if ((spec.url ?? '').startsWith('http://') || /\bhttp:\/\//.test(all)) add('plain_http', 'Plain http:// (not encrypted)');
  if (kind === 'npm' && spec.allowScripts) add('install_scripts', 'Runs npm install scripts');
  const port = BROWSER_PORTS.exec(`${spec.url ?? ''} ${all}`);
  if (port) add('browser_port', `Targets the browser pool’s port ${port[1]}`);
  if (kind === 'command') add('not_pinned', 'Not version-pinned: runs whatever the image has');
  if (spec.url && new URL(spec.url).search) add('query', 'The URL has a query: check it holds no secret');
  if (spec.allowPrivateNetwork) add('private_network', 'Private network allowed');
  return flags;
}
