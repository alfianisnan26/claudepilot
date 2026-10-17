import { DROPIN_DIR, MARKETPLACE_JSON, NODE, type HookName, type Owner, type PoolType } from './types.js';

/** Checks one settings key's value beyond "this owner may set it". Returns what's wrong, or null. */
export type SettingsCheck = (value: unknown, ctx: { owner: Owner; dropIn: string | null }) => string | null;

interface Declaration {
  /** This owner's drop-in in `managed-settings.d`. */
  dropIn?: string;
  /** Its drop-in's mode and group when not `root:root 0644`: one holding values only the workspace user may read. */
  dropInFile?: { mode: number; gid: number };
  /** Path prefixes this owner may write (a trailing `/` means a folder). */
  paths: string[];
  /** Top-level managed-settings keys this owner may set. */
  settings: string[];
  /** `env` variables this owner may set: exact names, or prefixes ending in `*` (the env registry, secrets A2). */
  env?: string[];
  /** Names and prefixes this owner may never set, even where `env` matches them. */
  envExcludes?: string[];
  /**
   * Present when this owner ships plugins in the portal marketplace (F6). With a `prefix`, every one of
   * its plugin names starts with it and no other owner's may; without one (skillsets), names are free
   * apart from every reserved prefix.
   */
  plugins?: { prefix?: string };
  /** Checks on the value of a settings key, beyond the key itself (secrets A1, for example). */
  validate?: Partial<Record<string, SettingsCheck>>;
  /** Image hooks this owner may ask the foundation for (`Fragment.hooks`, secrets A3). */
  hooks?: HookName[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `key` must be an object using only `allowed` sub-keys. */
const onlyKeys = (v: unknown, key: string, allowed: string[]) => {
  if (!isObject(v)) return `${key} must be an object`;
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  return extra.length ? `may set only ${allowed.map((k) => `${key}.${k}`).join(' and ')}, not ${key}.${extra[0]}` : null;
};

/** `permissions` holding only rule lists under `lists`, each rule accepted by `ok` (or rejected with its reason); `ok` is told which list. */
const ruleLists =
  (lists: string[], ok: (rule: string, ctx: { owner: Owner; dropIn: string | null; list: string }) => string | null): SettingsCheck =>
  (v, ctx) => {
    const shape = onlyKeys(v, 'permissions', lists);
    if (shape) return shape;
    for (const [list, rules] of Object.entries(v as Record<string, unknown>)) {
      if (!Array.isArray(rules) || rules.some((r) => typeof r !== 'string')) return `permissions.${list} must be a list of rules`;
      for (const rule of rules as string[]) {
        const problem = ok(rule, { ...ctx, list });
        if (problem) return `permissions.${list}: ${problem}`;
      }
    }
    return null;
  };

const SECRETS_DIR = '//etc/claudepilot/secrets';
/** The browser pool's profile folder, as a deny rule spells an absolute path (`//`). */
const BROWSER_PROFILE = '//home/node/.claudepilot/browser/profile/**';

/**
 * Secrets & env's deny rules (secrets A1): `Read(…)` and `Edit(…)` on what it delivers, written with the
 * absolute `//` prefix (a single `/` is anchored to the settings file and would protect nothing), plus
 * `Read(//proc/**\/environ)` for secrets exposed as variables.
 */
function secretsDenyRule(rule: string, ctx: { dropIn: string | null }): string | null {
  if (rule === 'Read(//proc/**/environ)') return null;
  const m = /^(Read|Edit)\(([^()\s]+)\)$/.exec(rule);
  const path = m?.[2] ?? '';
  const inSecrets = path === SECRETS_DIR || path.startsWith(`${SECRETS_DIR}/`);
  const ownDropIn = !!ctx.dropIn && path === `/${ctx.dropIn}`;
  if (!m || !(inSecrets || ownDropIn) || path.split('/').includes('..'))
    return `only Read(…) and Edit(…) on ${SECRETS_DIR}/**, its own drop-in and Read(//proc/**/environ) are allowed, not ${rule}`;
  return null;
}

/** `allowedMcpServers`: only the matchers pools report (`serverUrl` or `serverCommand`, MCP set FR19), never a name, which isn't a control. */
const mcpAllowlist: SettingsCheck = (v) => {
  if (!Array.isArray(v)) return 'allowedMcpServers must be a list';
  if (v.length > 300) return 'allowedMcpServers may hold at most 300 entries';
  for (const m of v) {
    if (!isObject(m)) return 'each allowedMcpServers entry must be an object';
    const keys = Object.keys(m);
    if (keys.length !== 1 || (keys[0] !== 'serverUrl' && keys[0] !== 'serverCommand')) return 'allowedMcpServers entries may only be { serverUrl } or { serverCommand }';
    const value = m[keys[0]!];
    if (keys[0] === 'serverUrl' && (typeof value !== 'string' || !value || value.length > 2000)) return 'serverUrl must be a non-empty string';
    if (keys[0] === 'serverCommand' && (!Array.isArray(value) || value.length === 0 || value.length > 60 || value.some((a) => typeof a !== 'string' || a.length > 2000))) return 'serverCommand must be a list of up to 60 strings';
  }
  return null;
};

/**
 * The policy owner's hooks (D-60, T-404): `PreToolUse` entries whose commands run only its own root-owned scripts
 * (`/etc/claudepilot/bin/policy-*`), so this drop-in can never run something a pool or a workspace supplies.
 */
const policyHooks: SettingsCheck = (v) => {
  const shape = onlyKeys(v, 'hooks', ['PreToolUse']);
  if (shape) return shape;
  const list = (v as Record<string, unknown>).PreToolUse;
  if (!Array.isArray(list)) return 'hooks.PreToolUse must be a list';
  for (const m of list) {
    if (!isObject(m) || typeof m.matcher !== 'string' || !Array.isArray(m.hooks)) return 'each hooks.PreToolUse entry must be { matcher, hooks }';
    for (const h of m.hooks as unknown[]) {
      if (!isObject(h) || h.type !== 'command' || typeof h.command !== 'string' || !/^\/etc\/claudepilot\/bin\/policy-[a-z0-9-]+( \|\| exit 2)?$/.test(h.command))
        return 'hooks.PreToolUse may only run the policy owner’s own scripts (/etc/claudepilot/bin/policy-*)';
    }
  }
  return null;
};

/** A boolean that can only be switched on: a protection is delivered as `true` or not at all. */
const onlyTrue =
  (key: string): SettingsCheck =>
  (v) =>
    v === true ? null : `${key} may only be true`;

/**
 * Who may write what (foundation PRD §7). The compiler rejects anything outside a declaration, so pools
 * can't overwrite each other's files or settings.
 */
export const OWNERSHIP: Record<Owner, Declaration> = {
  policy: {
    dropIn: '10-claudepilot-policy.json',
    // Its own scripts: the rule-file guard (D-60, T-404, `settings/ruleGuard.ts`) and the roots its `git -C` check reads (T-924).
    paths: ['/etc/claudepilot/bin/policy-', '/etc/claudepilot/git-c-roots'],
    settings: ['permissions', 'sandbox', 'availableModels', 'maxEffortLevel', 'deniedMcpServers', 'env', 'hooks'],
    // The agent policy (settings/agentEnv.ts, T-285): exact names, so no pool's catch-all can set them (`mayUseEnv`).
    env: [
      'CLAUDEPILOT_POLICY',
      'CLAUDE_CODE_MAX_RETRIES',
      'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL',
      'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
      'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
      'BASH_MAX_OUTPUT_LENGTH',
      'MAX_MCP_OUTPUT_TOKENS',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    ],
    // `sandbox` merges key by key across drop-ins; its credentials belong to Secrets & env.
    validate: { sandbox: (v) => (isObject(v) && 'credentials' in v ? 'sandbox.credentials belongs to Secrets & env' : null), hooks: policyHooks },
  },
  // The portal-wide switches (settings store): the MCP lockdown. `allowedMcpServers` and `allowManagedMcpServersOnly`
  // moved here from the policy owner, which delivers nothing yet; the pools' matchers fill the allowlist (MCP set FR19).
  settings: {
    dropIn: '05-claudepilot-settings.json',
    paths: [],
    settings: ['disableClaudeAiConnectors', 'allowManagedMcpServersOnly', 'allowedMcpServers'],
    validate: {
      disableClaudeAiConnectors: onlyTrue('disableClaudeAiConnectors'),
      allowManagedMcpServersOnly: onlyTrue('allowManagedMcpServersOnly'),
      allowedMcpServers: mcpAllowlist,
    },
  },
  secrets: {
    dropIn: '20-claudepilot-env.json',
    // It holds exposed secrets' values (secrets §10.1); Claude Code runs as the workspace user and reads it through the group.
    dropInFile: { mode: 0o440, gid: NODE },
    paths: ['/etc/claudepilot/secrets/'],
    settings: ['env', 'sandbox', 'permissions'],
    // Every name the registry leaves free: never one another owner declares (`mayUseEnv`), never Claude
    // Code's own `CLAUDE_*`, and never the portal's `CLAUDEPILOT_*` markers (`CLAUDEPILOT_VERIFY` switches
    // hook helpers off, skillset A7). FR4's other reserved names are refused when a set is saved.
    env: ['*'],
    envExcludes: ['CLAUDE_*', 'CLAUDEPILOT_*'],
    validate: {
      permissions: ruleLists(['deny'], secretsDenyRule),
      sandbox: (v) => onlyKeys(v, 'sandbox', ['credentials']),
    },
    // Login and interactive shells source its env.sh (A3).
    hooks: ['shell'],
  },
  mcpset: {
    dropIn: '30-claudepilot-mcp.json',
    paths: ['/etc/claudepilot/bin/mcp-'],
    settings: ['managedMcpServers', 'enabledPlugins', 'env', 'permissions'],
    env: ['MCP_TIMEOUT', 'MCP_TOOL_TIMEOUT'],
    plugins: { prefix: 'cpm-' },
    // Tool rules for its own servers only (MCP set A1).
    validate: {
      permissions: ruleLists(['ask', 'deny'], (rule) => (/^mcp__plugin_cpm-[A-Za-z0-9_-]+(?:__\*)?$/.test(rule) ? null : `only rules on mcp__plugin_cpm-… tools are allowed, not ${rule}`)),
    },
  },
  account: {
    dropIn: '40-claudepilot-account.json',
    paths: ['/etc/claudepilot/account/', '/etc/claudepilot/bin/account-'],
    settings: ['apiKeyHelper', 'env', 'hooks'],
    env: [
      'ANTHROPIC_*',
      'CLAUDE_CODE_USE_*',
      'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
      'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
      'CLAUDEPILOT_ACCOUNT',
      'CLAUDEPILOT_WORKSPACE',
      'DISABLE_LOGIN_COMMAND',
    ],
  },
  persona: {
    dropIn: '50-claudepilot-persona.json',
    // The managed CLAUDE.md, subagents, output styles, the chat prompt the session runner reads and its own
    // scripts (persona PRD A1). `claudeMd` and `agent` stay reserved: no fragment writes them in v1.
    paths: ['/etc/claude-code/CLAUDE.md', '/etc/claude-code/.claude/agents/', '/etc/claude-code/.claude/output-styles/', '/etc/claudepilot/persona/', '/etc/claudepilot/bin/persona-'],
    // `env` carries one stamp of what the persona delivers, so the drop-in changes with the text and running
    // sessions re-read the instructions (persona PRD §11, personas/render.ts `stamped`).
    settings: ['claudeMd', 'outputStyle', 'model', 'effortLevel', 'env', 'pluginConfigs', 'hooks', 'enabledPlugins'],
    env: ['CLAUDEPILOT_PERSONA'],
    plugins: { prefix: 'cpp-' },
  },
  // Instruction contexts (persona PRD A9): reusable instruction fragments, each one a managed rule file that
  // Claude Code loads next to the managed CLAUDE.md. Its drop-in holds only the same kind of stamp.
  context: {
    dropIn: '55-claudepilot-context.json',
    paths: ['/etc/claude-code/.claude/rules/'],
    settings: ['env'],
    env: ['CLAUDEPILOT_CONTEXT'],
  },
  skillset: {
    dropIn: '60-claudepilot-skills.json',
    paths: ['/etc/claude-code/.claude/skills/', '/etc/claudepilot/bin/skill-'],
    settings: ['enabledPlugins', 'permissions', 'hooks'],
    plugins: {},
    // Revocation deny rules for its own plugins' skills (skillset A1, §11.3).
    validate: {
      permissions: ruleLists(['deny'], (rule, ctx) => {
        const m = /^Skill\(([a-z0-9-]+):[^\s():]+( \*)?\)$/.exec(rule);
        return m && mayNamePlugin(ctx.owner, m[1]!) ? null : `only Skill(<plugin>:<skill>) rules on its own plugins are allowed, not ${rule}`;
      }),
    },
  },
  browser: {
    dropIn: '70-claudepilot-browser.json',
    paths: ['/etc/claudepilot/browser/', '/etc/claudepilot/bin/browser-'],
    settings: ['managedMcpServers', 'enabledPlugins', 'env', 'permissions'],
    env: ['CLAUDEPILOT_BROWSER_*'],
    plugins: { prefix: 'cpb-' },
    // Tool rules for its own servers, and the browser profile, which Claude never reads (browser PRD A1, A6).
    validate: {
      permissions: ruleLists(['ask', 'deny'], (rule, ctx) => {
        if (/^mcp__plugin_cpb-[A-Za-z0-9_-]+(?:__\*)?$/.test(rule)) return null;
        if (ctx.list === 'deny' && (rule === `Read(${BROWSER_PROFILE})` || rule === `Edit(${BROWSER_PROFILE})`)) return null;
        return `only rules on mcp__plugin_cpb-… tools, and Read(…) and Edit(…) denials on ${BROWSER_PROFILE}, are allowed, not ${rule}`;
      }),
    },
  },
  // The base drop-in registers the marketplace (skillset A2); the compiler writes it, and the catalog,
  // whenever a fragment ships a plugin.
  foundation: {
    dropIn: '00-claudepilot-base.json',
    // `/etc/profile.d/claudepilot.sh`: the shell hook (secrets A3), delivered only while a fragment asks for it.
    paths: ['/etc/claudepilot/state.json', '/etc/claudepilot/bin/', '/home/node/.claudepilot/', MARKETPLACE_JSON, '/etc/profile.d/claudepilot.sh'],
    settings: ['extraKnownMarketplaces'],
  },
};

const OWNERS = Object.keys(OWNERSHIP) as Owner[];
const POOL_TYPES = OWNERS.filter((o) => o !== 'foundation') as PoolType[];

/** Settings keys Claude Code combines across drop-ins, so several owners may contribute (§7 rule 2). */
const LIST_KEYS = new Set(['permissions', 'enabledPlugins', 'hooks', 'allowedMcpServers', 'deniedMcpServers', 'managedMcpServers']);

export const dropInPath = (owner: Owner) => {
  const name = OWNERSHIP[owner].dropIn;
  return name ? `${DROPIN_DIR}/${name}` : null;
};

/** Whether `owner` may write `path`. Pool scripts in `/etc/claudepilot/bin/` belong to their type's prefix. */
export function mayWrite(owner: Owner, path: string): boolean {
  if (path === dropInPath(owner)) return true;
  if (owner === 'foundation' && path.startsWith('/etc/claudepilot/bin/')) {
    const base = path.slice('/etc/claudepilot/bin/'.length);
    return !POOL_TYPES.some((t) => OWNERSHIP[t].paths.some((p) => p.startsWith('/etc/claudepilot/bin/') && base.startsWith(p.slice('/etc/claudepilot/bin/'.length))));
  }
  return OWNERSHIP[owner].paths.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(p)));
}

/** Whether some owner may write `path`: the only files the reconciler ever deletes, whatever a manifest lists. */
export const deliverable = (path: string) => OWNERS.some((o) => mayWrite(o, path));

const envRuleMatches = (rule: string, name: string) => (rule.endsWith('*') ? name.startsWith(rule.slice(0, -1)) : rule === name);

/** How specifically an owner declares `name`: exact beats a longer prefix beats a shorter one beats `*`; -1 if not at all. */
function envSpecificity(d: Declaration, name: string): number {
  if ((d.envExcludes ?? []).some((rule) => envRuleMatches(rule, name))) return -1;
  let best = -1;
  for (const rule of d.env ?? []) if (envRuleMatches(rule, name)) best = Math.max(best, rule.endsWith('*') ? rule.length - 1 : Number.MAX_SAFE_INTEGER);
  return best;
}

/**
 * Whether `owner` may set the `env` variable `name` (the env registry, secrets A2): its declaration
 * matches, it doesn't exclude the name, and no other owner declares the name more specifically. A
 * catch-all owner (Secrets & env's `*`) therefore never sets a name another owner declares.
 */
export function mayUseEnv(owner: Owner, name: string): boolean {
  const own = envSpecificity(OWNERSHIP[owner], name);
  return own >= 0 && !OWNERS.some((o) => o !== owner && envSpecificity(OWNERSHIP[o], name) > own);
}

export const isListKey = (key: string) => LIST_KEYS.has(key);

/**
 * Names `claude plugin validate` refuses as passing for Anthropic's own (seen on 2.1.296; skillset FR12):
 * these prefixes, these exact names, and "official" right beside "claude" or "anthropic".
 */
export const RESERVED_PLUGIN_PREFIXES = ['claude-', 'anthropic-', 'anthropics-', 'cc-plugin-'];
const RESERVED_PLUGIN_NAMES = new Set(['claude', 'anthropic', 'anthropics', 'claude-code', 'claude-mods']);
const OFFICIAL = /(?:claude|anthropic)-?official|official-?(?:claude|anthropic)/;
/** Kebab-case. MCP tool names (`mcp__plugin_<name>_<server>__<tool>`) leave little room, so 64 at most. */
const PLUGIN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Whether `owner` may ship a portal plugin called `name`, or switch it on or off: kebab-case, not a name
 * Claude Code reserves, and either under the owner's own prefix or, for an owner without one, outside
 * every owner's prefix.
 */
export function mayNamePlugin(owner: Owner, name: string): boolean {
  const own = OWNERSHIP[owner].plugins;
  if (!own || name.length > 64 || !PLUGIN_NAME.test(name)) return false;
  if (RESERVED_PLUGIN_PREFIXES.some((p) => name.startsWith(p)) || RESERVED_PLUGIN_NAMES.has(name) || OFFICIAL.test(name)) return false;
  if (own.prefix) return name.startsWith(own.prefix) && name.length > own.prefix.length;
  return !OWNERS.some((o) => {
    const prefix = OWNERSHIP[o].plugins?.prefix;
    return !!prefix && name.startsWith(prefix);
  });
}
