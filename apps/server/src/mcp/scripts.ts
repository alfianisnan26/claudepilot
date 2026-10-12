import { NPM_REGISTRY, SECRET_FILES } from './spec.js';
import { MARKETPLACE_DIR } from '../delivery/types.js';

/**
 * The launcher and the headers helper (MCP set PRD §10.2, A6): items of the script bundle, owned by
 * the MCP set type (`/etc/claudepilot/bin/mcp-*`). Node is in every workspace image, and Node 22.15+
 * has `process.execve`, so the launcher replaces itself with the server: the server's own
 * `/proc/<pid>/environ` then carries the markers revocation looks for (§10.4), and values never pass
 * through a command line. Both read the server's map from the version folder the catalog names now,
 * never from the folder a session loaded, so a stale session can't start an old or revoked version.
 * They print no value anywhere but the helper's JSON object, and log only `{id, at, server, phase,
 * source, reason_class}` to the outbox.
 */

export interface ScriptPaths {
  market: string;
  secrets: string;
  /** Tests only: a fixed home folder instead of the workspace user's. */
  home?: string;
}

const DEFAULT_PATHS: ScriptPaths = { market: MARKETPLACE_DIR, secrets: SECRET_FILES };

/** The workspace image's PATH, with the portal's bin folder first (`uvx` from there first, §10.2). */
const LAUNCH_PATH = '/etc/claudepilot/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const common = (p: ScriptPaths) => `'use strict';
const fs = require('fs');
const MARKET = ${JSON.stringify(p.market)};
const SECRETS = ${JSON.stringify(p.secrets)};
const HOME_DIR = ${p.home ? JSON.stringify(p.home) : "require('os').userInfo().homedir"};
const OUTBOX = HOME_DIR + '/.claudepilot/outbox';
const OUTBOX_CAP = 1048576;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VALUE_MAX = 65536;
const self = { server: '', source: '' };

// One outbox line (foundation §8): a single append under 4 KB, dropped and counted past the cap.
function event(phase, reason) {
  try {
    if (!fs.statSync(OUTBOX).isDirectory()) return;
    const file = OUTBOX + '/mcp.jsonl';
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    if (size >= OUTBOX_CAP) {
      let n = 0;
      try { n = Number(fs.readFileSync(OUTBOX + '/mcp.dropped', 'utf8')) || 0; } catch {}
      fs.writeFileSync(OUTBOX + '/mcp.dropped', String(n + 1) + '\\n');
      return;
    }
    const id = Date.now() + '-' + process.pid + '-' + Math.floor(Math.random() * 1e6);
    fs.appendFileSync(file, JSON.stringify({ id, at: new Date().toISOString(), server: self.server, phase, source: self.source, reason_class: reason || null }) + '\\n');
  } catch {}
}

// Stops with a message that names what's wrong, never a value.
function fail(reason, message) {
  process.stderr.write('claudepilot: ' + message + '\\n');
  event('fail', reason);
  process.exit(1);
}

// The server's map in the version folder the catalog points at now.
function currentMap(id) {
  const m = /^(cpm-[a-z0-9]+(?:-[a-z0-9]+)*)\\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(id || '');
  if (!m) fail('usage', 'expected cpm-<set>/<server>');
  let catalog;
  try { catalog = JSON.parse(fs.readFileSync(MARKET + '/.claude-plugin/marketplace.json', 'utf8')); } catch { return null; }
  const entry = Array.isArray(catalog && catalog.plugins) ? catalog.plugins.find((x) => x && x.name === m[1]) : null;
  const src = entry && typeof entry.source === 'string' ? /^\\.\\/plugins\\/([a-z0-9-]+)\\/([0-9a-f]{12})$/.exec(entry.source) : null;
  if (!src || src[1] !== m[1]) return null;
  try {
    const map = JSON.parse(fs.readFileSync(MARKET + '/plugins/' + m[1] + '/' + src[2] + '/servers/' + m[2] + '.json', 'utf8'));
    return map && typeof map === 'object' && !Array.isArray(map) ? map : null;
  } catch { return null; }
}

// A secret file's content, one trailing newline trimmed, at most 64 KB.
function secret(name) {
  let buf;
  try {
    const fd = fs.openSync(SECRETS + '/' + name, 'r');
    try {
      if (fs.fstatSync(fd).size > VALUE_MAX) fail('secret_too_large', 'secret ' + name + ' is larger than 64 KB');
      buf = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    fail('secret_missing', 'secret ' + name + ' missing');
  }
  let s = buf.toString('utf8');
  if (s.endsWith('\\r\\n')) s = s.slice(0, -2);
  else if (s.endsWith('\\n')) s = s.slice(0, -1);
  if (s.includes('\\0')) fail('secret_invalid', 'secret ' + name + ' is not text');
  return s;
}

// One value from its parts: literal text, a secret file's content, or a secret file's path.
function value(parts) {
  if (!Array.isArray(parts)) fail('bad_map', 'the server map is malformed');
  let out = '';
  for (const p of parts) {
    if (p && typeof p.text === 'string') out += p.text;
    else if (p && typeof p.file === 'string' && FILE_NAME.test(p.file)) out += secret(p.file);
    else if (p && typeof p.path === 'string' && FILE_NAME.test(p.path)) {
      try { fs.accessSync(SECRETS + '/' + p.path, fs.constants.R_OK); } catch { fail('secret_missing', 'secret ' + p.path + ' missing'); }
      out += SECRETS + '/' + p.path;
    } else fail('bad_map', 'the server map is malformed');
  }
  return out;
}
`;

/** `mcp-launch cpm-<set>/<server> -- <target> [args]`: starts one stdio server (§10.2, §12). */
export function launcherScript(p: ScriptPaths = DEFAULT_PATHS): string {
  return `#!/usr/bin/env node
// claudepilot: starts one MCP set server. Usage: mcp-launch cpm-<set>/<server> -- <target> [args]
// Targets: npm:<pkg>@<version>, cmd:<path>. Never prints a secret value.
${common(p)}
const REGISTRY = ${JSON.stringify(NPM_REGISTRY)};
const [id, sep, target, ...args] = process.argv.slice(2);
self.server = id || '';
self.source = /^cmd:/.test(target || '') ? 'command' : 'first_use';
if (sep !== '--' || !target) fail('usage', 'usage: mcp-launch cpm-<set>/<server> -- <target> [args]');
const map = currentMap(id);
if (!map || map.target !== target || JSON.stringify(map.args || []) !== JSON.stringify(args)) fail('server_changed', 'server changed or removed; run /reload-plugins');

// The session's environment, minus npm settings that could redirect an install, plus the server's
// variables and two markers (non-secret) set last, so nothing in the map can override them.
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^npm_config_/i.test(k)) env[k] = v;
for (const [name, parts] of Object.entries(map.env || {})) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || /^(?:PATH|HOME|CLAUDEPILOT_.*)$/.test(name)) fail('bad_map', 'the server map is malformed');
  env[name] = value(parts);
}
env.PATH = ${JSON.stringify(LAUNCH_PATH)};
env.HOME = HOME_DIR;
env.CLAUDEPILOT_MCP_SERVER = id;
env.CLAUDEPILOT_MCP_TARGET = target;
// \`docker exec\` (so Claude Code, and the server after it) may run with umask 0000: no group or world
// write on npx's cache, the code it runs, or what the server writes. A stricter umask stays.
process.umask(process.umask(0o022) | 0o022);

// Its own folder with a package.json stub, so npm looks no further up: a repository's .npmrc or
// node_modules can't redirect what runs. Otherwise the server would run in the user's repository.
const WORK = HOME_DIR + '/.cache/claudepilot/mcp';
try {
  // The workspace user's only (\`docker exec\` may run with umask 0000): what runs from here can't be swapped by another user.
  fs.mkdirSync(WORK, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(WORK + '/package.json')) fs.writeFileSync(WORK + '/package.json', '{"name":"claudepilot-mcp","private":true}\\n', { mode: 0o600 });
  process.chdir(WORK);
} catch {
  fail('start_failed', 'could not prepare ' + WORK);
}

function start(file, argv) {
  event('start', null);
  if (typeof process.execve !== 'function') {
    // Older Node: run it as a child and pass signals on.
    const child = require('child_process').spawn(file, argv.slice(1), { argv0: argv[0], env, stdio: 'inherit' });
    for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => child.kill(s));
    child.on('error', (e) => fail('start_failed', 'could not start ' + target + ' (' + (e.code || 'error') + ')'));
    child.on('exit', (code) => process.exit(code === null ? 1 : code));
    return;
  }
  try {
    process.execve(file, argv, env);
  } catch (e) {
    fail('start_failed', 'could not start ' + target + ' (' + ((e && e.code) || 'error') + ')');
  }
}

// A pre-installed package's command (§12): the bin the map names, the package's only one, or the one
// named like the package.
function preinstalled(prefix, pkg, wanted) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(prefix + '/node_modules/' + pkg + '/package.json', 'utf8')); } catch { return null; }
  const unscoped = pkg.replace(/^@[^/]+\\//, '');
  let name = wanted || null;
  let rel = null;
  if (typeof manifest.bin === 'string') {
    name = name || unscoped;
    rel = name === unscoped ? manifest.bin : null;
  } else if (manifest.bin && typeof manifest.bin === 'object') {
    const names = Object.keys(manifest.bin);
    name = name || (names.length === 1 ? names[0] : names.includes(unscoped) ? unscoped : null);
    rel = name ? manifest.bin[name] : null;
  }
  if (!name || typeof rel !== 'string' || !/^[A-Za-z0-9@._-]+$/.test(name)) return null;
  const link = prefix + '/node_modules/.bin/' + name;
  try {
    fs.accessSync(link, fs.constants.X_OK);
    return [link];
  } catch {}
  const file = require('path').resolve(prefix + '/node_modules/' + pkg, rel);
  if (!file.startsWith(prefix + '/node_modules/') || !fs.existsSync(file)) return null;
  return [process.execPath, file];
}

let m;
if ((m = /^npm:((?:@[a-z0-9-~][a-z0-9-._~]*\\/)?[a-z0-9-~][a-z0-9-._~]*)@(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(target))) {
  const pkg = m[1];
  const spec = pkg + '@' + m[2];
  const bin = preinstalled(WORK + '/npm/' + spec, pkg, typeof map.bin === 'string' ? map.bin : null);
  if (bin) {
    self.source = 'preinstalled';
    start(bin[0], [...bin, ...args]);
  } else {
    // First use: the pinned version from the public registry, no user config, no install scripts
    // unless the approved version allows them (§12, Q10).
    self.source = 'first_use';
    if (map.allowScripts !== true) env.npm_config_ignore_scripts = 'true';
    env.npm_config_update_notifier = 'false';
    const npx = ['/usr/local/bin/npx', '/usr/bin/npx'].find((x) => fs.existsSync(x));
    if (!npx) fail('install_failed', 'npx is missing in this workspace');
    const run = typeof map.bin === 'string' ? ['--package', spec, map.bin] : [spec];
    start(npx, ['npx', '--yes', '--registry', REGISTRY, '--userconfig', '/dev/null', ...run, ...args]);
  }
} else if ((m = /^cmd:(\\/[A-Za-z0-9._\\/+-]+)$/.exec(target)) && !m[1].split('/').includes('..')) {
  start(m[1], [m[1], ...args]);
} else if (/^pypi:/.test(target)) {
  fail('uv_missing', 'PyPI servers need uv, which this workspace lacks');
} else {
  fail('usage', 'unknown target');
}
`;
}

/** `mcp-headers cpm-<set>/<server>`: prints a remote server's headers as one JSON object (§10.2). */
export function headersScript(p: ScriptPaths = DEFAULT_PATHS): string {
  return `#!/usr/bin/env node
// claudepilot: prints one MCP set server's headers as a JSON object, for Claude Code's headersHelper.
// Usage: mcp-headers cpm-<set>/<server>. Prints nothing else; plugin helpers get no credential-named
// variables, so values come from Secrets & env's files.
${common(p)}
const id = process.argv[2];
self.server = id || '';
self.source = 'remote';
const map = currentMap(id);
if (!map || typeof map.url !== 'string') fail('server_changed', 'server changed or removed; run /reload-plugins');
// A session still on an older folder may be connecting to an old URL: never send it today's credentials.
const asked = process.env.CLAUDE_CODE_MCP_SERVER_URL;
if (asked && asked !== map.url) fail('server_changed', 'server changed or removed; run /reload-plugins');
const out = {};
for (const [name, parts] of Object.entries(map.headers || {})) {
  if (!/^[A-Za-z0-9!#$%&'*+.^_\`|~-]{1,64}$/.test(name)) fail('bad_map', 'the server map is malformed');
  const v = value(parts);
  if (/[\\r\\n\\0]/.test(v)) fail('secret_invalid', 'header ' + name + ' would not be a valid header value');
  out[name] = v;
}
process.stdout.write(JSON.stringify(out));
`;
}

export const MCP_LAUNCH = launcherScript();
export const MCP_HEADERS = headersScript();
