import type { BrowserPoolContent, McpMatcher } from '@portal/contracts';
import { BROWSER_RULE_TOOLS, claudeMinimum } from '@portal/contracts';
import { compilePlugin } from '../delivery/marketplace.js';
import { ROOT, type Fragment, type PluginBundle } from '../delivery/types.js';
import type { PoolRef } from '../pools/kinds.js';
import { GATE_PATH, GATE_SCRIPT } from './gate.js';
import devtoolsTools from './pinned/tools-devtools.json' with { type: 'json' };
import pinnedLock from './pinned/package-lock.json' with { type: 'json' };
import pinnedPackage from './pinned/package.json' with { type: 'json' };
import playwrightTools from './pinned/tools-playwright.json' with { type: 'json' };
import { INSTALL_PATH, INSTALL_SCRIPT, SKILL } from './scripts.js';
import { CDP_ENDPOINT, DOWNLOADS_DIR, PLAYWRIGHT_OUT, PLUGIN_ID, PLUGIN_NAME, PROFILE_DIR, sha256, toolRuleName } from './spec.js';

/**
 * The browser fragment (browser & desktop PRD §11.1): one plugin, `cpb-browser`, whose `.mcp.json` starts each
 * pinned server through the gate, with the tool lists the gate answers from, the lockfile the servers install
 * from and the skill; the gate and the installer in `/etc/claudepilot/bin/browser-*`; and the drop-in that
 * enables the plugin, points tools at CDP and the downloads folder, and holds the tool rules. Plugins that
 * cannot be delivered here (Claude Code too old) are left out by the engine, with the reason.
 */

/** Claude Code that has everything the MCP and plugin work was observed on (MCP set FR14). */
export const BROWSER_MIN_CLAUDE = claudeMinimum('browser-pool');

export interface BrowserCompileInput {
  pool: PoolRef;
  content: BrowserPoolContent;
}

export interface BrowserCompiled {
  fragments: Fragment[];
  plugin: { name: string; version: string; treeHash: string; hash12: string; dir: string };
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** The pinned lockfile's own hash: what "installed" means, in the installer and in the portal's records. */
export const LOCK_HASH = sha256(json(pinnedLock)).slice(0, 16);

/** The servers a pool starts, as `.mcp.json` entries. Pure, so the review and the tests see exactly what runs. */
export function mcpServers(content: BrowserPoolContent): Record<string, unknown> {
  const root = '${CLAUDE_PLUGIN_ROOT}';
  // Header names the gate also redacts from tool results (PRD §24): names only, and only when the pool has headers.
  const redactNames = [...new Set((content.headers ?? []).map((h) => h.name))].sort();
  // The secrets' values are masked by value too: the gate reads them from variables of the same name that Claude Code passes through
  // (`${NAME:-}`, empty when the workspace doesn't have it). Only names are in the file; a name that isn't an environment variable is skipped.
  const secretVars = [...new Set((content.headers ?? []).map((h) => h.secret).filter((n) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(n)))].sort();
  const valueEnv = Object.fromEntries(secretVars.map((n) => [n, `\${${n}:-}`]));
  const common = (name: 'playwright' | 'devtools') => [
    '--tools',
    `${root}/tools/${name}.json`,
    '--npm-files',
    `${root}/npm`,
    ...(redactNames.length ? ['--redact', redactNames.join(',')] : []),
    ...(secretVars.length ? ['--redact-env', secretVars.join(',')] : []),
  ];
  const servers: Record<string, unknown> = {
    browser: {
      command: GATE_PATH,
      args: [
        'playwright',
        ...common('playwright'),
        ...(content.sessions === 'shared' ? ['--shared'] : []),
        '--',
        '--cdp-endpoint',
        CDP_ENDPOINT,
        '--output-dir',
        PLAYWRIGHT_OUT,
        ...(content.vision ? ['--caps', 'vision'] : []),
        ...(content.sessions === 'isolated' ? ['--isolated'] : []),
      ],
      ...(secretVars.length ? { env: valueEnv } : {}),
    },
  };
  if (content.devtools) {
    servers.devtools = {
      command: GATE_PATH,
      args: ['devtools', ...common('devtools'), '--', '--browser-url', CDP_ENDPOINT, '--no-usage-statistics', '--no-performance-crux'],
      env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1', CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1', ...valueEnv },
    };
  }
  return servers;
}

/**
 * What the MCP lockdown's allowlist must admit for these servers (settings-policies, MCP lockdown): each server's
 * command line. ✅ Claude Code 2.1.296 matches `serverCommand` against the command with `${CLAUDE_PLUGIN_ROOT}`
 * already replaced by the plugin's folder in the marketplace (the raw text is blocked), so the folder is the
 * version folder this compile produced.
 */
export function browserMatchers(content: BrowserPoolContent, pluginDir: string): McpMatcher[] {
  return Object.values(mcpServers(content)).map((s) => {
    const { command, args } = s as { command: string; args: string[] };
    return { serverCommand: [command, ...args.map((a) => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginDir))] };
  });
}

/** devtools' network tools return headers and bodies, so they ask by default (FR7). */
const DEVTOOLS_DEFAULT_ASK = ['list_network_requests', 'get_network_request'];

/** `permissions.ask` and `permissions.deny` from the pool's tool rules, plus the profile Claude may never read (PRD §13). */
export function permissionRules(content: BrowserPoolContent): { ask: string[]; deny: string[] } {
  const rules = new Map<string, 'ask' | 'block'>();
  const rule = (tool: string) => toolRuleName(tool.startsWith('browser_') ? 'browser' : 'devtools', tool);
  if (content.devtools) for (const t of DEVTOOLS_DEFAULT_ASK) rules.set(rule(t), 'ask');
  for (const [tool, r] of Object.entries(content.toolRules)) {
    if (r === 'default') {
      rules.delete(rule(tool));
      continue;
    }
    rules.set(rule(tool), r);
  }
  const profile = `//${PROFILE_DIR.slice(1)}/**`;
  return {
    ask: [...rules].filter(([, r]) => r === 'ask').map(([name]) => name).sort(),
    deny: [...[...rules].filter(([, r]) => r === 'block').map(([name]) => name), `Read(${profile})`, `Edit(${profile})`].sort(),
  };
}

export function compileBrowser({ pool, content }: BrowserCompileInput): BrowserCompiled {
  const files = [
    { path: '.mcp.json', content: json({ mcpServers: mcpServers(content) }) },
    { path: 'tools/playwright.json', content: json(playwrightTools) },
    ...(content.devtools ? [{ path: 'tools/devtools.json', content: json(devtoolsTools) }] : []),
    { path: 'npm/package.json', content: json(pinnedPackage) },
    { path: 'npm/package-lock.json', content: json(pinnedLock) },
    { path: 'skills/browser/SKILL.md', content: SKILL },
  ];
  const hash8 = sha256(files.map((f) => `${f.path}\0${f.content}`).join('\0')).slice(0, 8);
  const bundle: PluginBundle = { name: PLUGIN_NAME, version: `${pool.revision}.0.0+${hash8}`, description: `Browser pool ${pool.name}`, files };
  const compiled = compilePlugin('browser', bundle);
  if (typeof compiled === 'string') throw new Error(`browser: ${compiled}`);

  const settings: Record<string, unknown> = {
    enabledPlugins: { [PLUGIN_ID]: true },
    // Where tools find the browser and its downloads; written empty after the pool is gone (foundation §6.4).
    env: { CLAUDEPILOT_BROWSER_CDP: CDP_ENDPOINT, CLAUDEPILOT_BROWSER_DOWNLOADS: DOWNLOADS_DIR },
    permissions: permissionRules(content),
  };
  const fragment: Fragment = {
    owner: 'browser',
    pool: { id: pool.id, revision: pool.revision },
    minClaudeVersion: BROWSER_MIN_CLAUDE,
    files: [
      { path: GATE_PATH, content: GATE_SCRIPT, mode: 0o755, uid: ROOT, gid: ROOT },
      { path: INSTALL_PATH, content: INSTALL_SCRIPT, mode: 0o755, uid: ROOT, gid: ROOT },
    ],
    plugins: [bundle],
    settings,
    envTombstones: {},
  };
  return {
    fragments: [fragment],
    plugin: { name: PLUGIN_NAME, version: bundle.version, treeHash: compiled.treeHash, hash12: compiled.treeHash.slice(0, 12), dir: compiled.dir },
  };
}

/** The tools a pool's rules can name, for the editor. */
export const RULE_TOOLS: readonly string[] = [...BROWSER_RULE_TOOLS, ...DEVTOOLS_DEFAULT_ASK];
