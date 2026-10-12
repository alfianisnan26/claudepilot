import { ROOT, type DeliveredFile, type HookLine, type HookName } from './types.js';

/** What login and interactive shells run to pick up Secrets & env's variables (secrets PRD §10.3). */
const SOURCE_ENV_SH = 'if [ -r /etc/claudepilot/secrets/env.sh ]; then . /etc/claudepilot/secrets/env.sh; fi';

/**
 * The image hooks (secrets PRD A3, §10.3) for workspaces whose image doesn't carry them yet. Each has files
 * the foundation owns, delivered and drift-repaired like any file, and lines appended once to files nobody
 * owns. Both only source what exists, so they're harmless once the files they point at are gone.
 */
export const HOOKS: Record<HookName, { files: DeliveredFile[]; lines: HookLine[] }> = {
  shell: {
    // `bash -l` (the portal terminal) reads /etc/profile, which sources /etc/profile.d/*.sh.
    files: [{ path: '/etc/profile.d/claudepilot.sh', content: `# claudepilot: Secrets & env variables for login shells.\n${SOURCE_ENV_SH}\n`, mode: 0o644, uid: ROOT, gid: ROOT }],
    // Interactive non-login bash (VS Code terminals, `docker exec -it … bash`) reads only /etc/bash.bashrc.
    lines: [{ path: '/etc/bash.bashrc', line: `${SOURCE_ENV_SH} # claudepilot` }],
  },
};

export const sameLine = (a: HookLine, b: HookLine) => a.path === b.path && a.line === b.line;

/** The hook lines a workspace's manifest says were appended; anything malformed counts as not appended. */
export function appendedLines(manifest: { lines?: unknown } | null | undefined): HookLine[] {
  const lines = manifest?.lines;
  if (!Array.isArray(lines)) return [];
  return lines.filter((l): l is HookLine => !!l && typeof l === 'object' && typeof (l as HookLine).path === 'string' && typeof (l as HookLine).line === 'string');
}
