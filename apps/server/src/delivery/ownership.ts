import { DROPIN_DIR, type Owner, type PoolType } from './types.js';

interface Declaration {
  /** This owner's drop-in in `managed-settings.d`. */
  dropIn?: string;
  /** Path prefixes this owner may write (a trailing `/` means a folder). */
  paths: string[];
  /** Top-level managed-settings keys this owner may set. */
  settings: string[];
  /** `env` variables this owner may set: exact names, or prefixes ending in `*`. */
  env?: string[];
}

/**
 * Who may write what (foundation PRD §7). The compiler rejects anything outside a declaration, so pools
 * can't overwrite each other's files or settings.
 */
export const OWNERSHIP: Record<Owner, Declaration> = {
  policy: {
    dropIn: '10-claudepilot-policy.json',
    paths: [],
    settings: ['permissions', 'sandbox', 'availableModels', 'maxEffortLevel', 'allowedMcpServers', 'deniedMcpServers', 'allowManagedMcpServersOnly', 'env'],
    env: ['CLAUDEPILOT_POLICY', 'CLAUDE_CODE_MAX_RETRIES'],
  },
  secrets: { dropIn: '20-claudepilot-env.json', paths: ['/etc/claudepilot/secrets/'], settings: ['env', 'sandbox'], env: ['*'] },
  mcpset: {
    dropIn: '30-claudepilot-mcp.json',
    paths: ['/etc/claudepilot/marketplace/', '/etc/claudepilot/bin/mcp-'],
    settings: ['managedMcpServers', 'enabledPlugins', 'env'],
    env: ['MCP_TIMEOUT', 'MCP_TOOL_TIMEOUT'],
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
    paths: ['/etc/claude-code/.claude/agents/', '/etc/claude-code/.claude/output-styles/'],
    settings: ['claudeMd', 'outputStyle', 'model', 'effortLevel', 'enabledPlugins'],
  },
  skillset: {
    dropIn: '60-claudepilot-skills.json',
    paths: ['/etc/claude-code/.claude/skills/', '/etc/claudepilot/marketplace/', '/etc/claudepilot/bin/skill-'],
    settings: ['enabledPlugins', 'permissions', 'hooks'],
  },
  browser: {
    dropIn: '70-claudepilot-browser.json',
    paths: ['/etc/claudepilot/browser/', '/etc/claudepilot/bin/browser-'],
    settings: ['managedMcpServers', 'enabledPlugins', 'env'],
    env: ['CLAUDEPILOT_BROWSER_*'],
  },
  foundation: { paths: ['/etc/claudepilot/state.json', '/etc/claudepilot/bin/', '/home/node/.claudepilot/'], settings: [] },
};

const POOL_TYPES = Object.keys(OWNERSHIP).filter((o) => o !== 'foundation') as PoolType[];

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

export function mayUseEnv(owner: Owner, name: string): boolean {
  return (OWNERSHIP[owner].env ?? []).some((rule) => (rule.endsWith('*') ? name.startsWith(rule.slice(0, -1)) : rule === name));
}

export const isListKey = (key: string) => LIST_KEYS.has(key);
