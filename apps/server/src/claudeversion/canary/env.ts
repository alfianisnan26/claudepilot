// The canary's environment, built from an ALLOWLIST and never from `process.env` (docs/prd/claude-version-pinning.md §11; PLAN-2 A.11).
// The real Claude Code CLI runs only inside the throwaway container, as the workspace user, with a fake login in a private home folder. The
// portal process may itself run inside a Claude Code session (its environment can hold the owner's CLAUDE_CONFIG_DIR, a messaging token and
// socket, CLAUDECODE, SSH_AUTH_SOCK): none of it may reach the CLI under test, so the child's environment is spelled out here, name by name,
// and a name outside the lists below is dropped. A test sets those variables on the parent and proves none arrives.

/** Names a canary run may set, with what each is for. Anything else is dropped by `canaryEnv`. */
export const CANARY_ENV_ALLOWED = [
  'HOME',
  'PATH',
  'LANG',
  'TERM',
  /** The stand-in's CONNECT proxy and the throwaway CA that signs its certificate (never a real proxy or CA). */
  'HTTPS_PROXY',
  /** Local MCP servers of a check are reached directly, never through the stand-in's proxy. */
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  /** Keep the CLI quiet: no telemetry, no error reports. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is never set: it stops the usage fetch. */
  'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING',
  /** A plain-HTTP model endpoint (the stand-in's), for a check that does not use a login. */
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  /** A second Claude's folder inside the container, for a check about it. */
  'CLAUDE_CONFIG_DIR',
  /** What a check passes to the portal's own helpers (the session host's folders). */
  'CLAUDEPILOT_SESSIONS_DIR',
  'CLAUDEPILOT_UPLOADS_DIR',
  'CLAUDEPILOT_FILES_ROOT',
  /** A plugin folder for a check. */
  'CLAUDE_CODE_PLUGIN_SEED_DIR',
] as const;

const ALLOWED = new Set<string>(CANARY_ENV_ALLOWED);

export interface CanaryEnvInput {
  /** The home folder inside the container. */
  home: string;
  /** PATH inside the container: the scratch install's folder first for a candidate. */
  path: string;
  /** The stand-in proxy (`http://127.0.0.1:<port>`) and its CA file, once it is listening. */
  proxy?: string;
  ca?: string;
  /** More variables for one check; a name outside the allowlist is dropped (and so is every value that is not a string). */
  extra?: Record<string, string | undefined>;
}

/**
 * The environment of one CLI run. Reads NOTHING from `process.env`: the result is the allowlisted names given here plus fixed quiet-down
 * switches. The container supplies its own image variables (the update switches among them) to everything it execs.
 */
export function canaryEnv(input: CanaryEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    HOME: input.home,
    PATH: input.path,
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  };
  if (input.proxy) env.HTTPS_PROXY = input.proxy;
  if (input.ca) env.NODE_EXTRA_CA_CERTS = input.ca;
  for (const [name, value] of Object.entries(input.extra ?? {})) if (ALLOWED.has(name) && typeof value === 'string') env[name] = value;
  return env;
}
