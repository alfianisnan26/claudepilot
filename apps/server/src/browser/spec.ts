import { createHash } from 'node:crypto';

/**
 * Names and paths the browser pool agrees on with the workspace image, the browser container's image and the
 * gate (browser & desktop PRD §10, §11). One place, so the compiler, the companion manager and the tests can't
 * drift apart.
 */

export const BROWSER_BIN = '/etc/claudepilot/bin';
/** Under the workspace user's home: the pinned servers, installed from a lockfile (PRD §11.1). */
export const BROWSER_NPM_DIR = '.cache/claudepilot/browser/npm';
export const PLUGIN_NAME = 'cpb-browser';
export const PLUGIN_ID = `${PLUGIN_NAME}@claudepilot`;

/** The browser container is in the workspace's network namespace, so these are the workspace's own loopback. */
export const CDP_PORT = 9222;
export const SUPERVISOR_PORT = 9220;
export const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

export const HOME = '/home/node';
export const DOWNLOADS_DIR = `${HOME}/Downloads`;
/** Playwright's own output (screenshots, snapshots) when a tool is given no file name. */
export const PLAYWRIGHT_OUT = `${DOWNLOADS_DIR}/.playwright`;
/** The profile in the home volume (PRD §13 Profile): Claude is denied Read and Edit on it. */
export const PROFILE_REL = '.claudepilot/browser/profile';
export const PROFILE_DIR = `${HOME}/${PROFILE_REL}`;

/** Image that runs the browser: a bare tag is built from `images/browser` on first use. */
export const DEFAULT_IMAGE = 'claudepilot-browser:latest';

/** Labels on the browser container. Not `claudepilot.managed`: the workspace list must never show it as a workspace. */
export const LABELS = {
  browser: 'claudepilot.browser',
  workspace: 'claudepilot.browser.workspace',
  /** The workspace container's ID it shares a network namespace with: a recreated workspace means a new container. */
  netns: 'claudepilot.browser.netns',
  /** Hash of everything that decides how it is created, so a change shows without inspecting every field. */
  spec: 'claudepilot.browser.spec',
  pool: 'claudepilot.browser.pool',
  /**
   * The portal that made it. Several portals can share one Docker daemon (a test portal beside a real one), and each
   * sees the others' containers: a portal only ever manages the browser containers that carry its own ID.
   */
  portal: 'claudepilot.browser.portal',
} as const;

/**
 * `claudepilot-<name>.browser`: a dot can't be in a workspace name, so this never equals the name of another
 * workspace's container (`claudepilot-<name>-browser` would, for a workspace called `<name>-browser`).
 */
export const companionName = (workspace: string) => `claudepilot-${workspace}.browser`;
export const workspaceContainer = (workspace: string) => `claudepilot-${workspace}`;
export const homeVolume = (workspace: string) => `claudepilot-${workspace}-home`;

/** `<target>/<name>` → its parts. */
export function splitWorkspaceId(id: string): { target: string; name: string } {
  const i = id.indexOf('/');
  return { target: id.slice(0, i), name: id.slice(i + 1) };
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** Claude Code names a plugin's server tools `mcp__plugin_<plugin>_<server>__<tool>`. */
export const toolRuleName = (server: 'browser' | 'devtools' | 'desktop', tool: string) => `mcp__plugin_${PLUGIN_NAME}_${server}__${tool}`;
