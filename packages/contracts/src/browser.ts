/**
 * Browser & desktop pool (browser-desktop-pool PRD): a browser, and optionally a Linux desktop, in a container
 * beside each workspace, driven by the agent over MCP and watched or driven by people in the portal. Pools are
 * of type `browser` (POOLS_API, one per workspace); what runs, who has control and the live views have their
 * own routes (BROWSER_API).
 */

/** Headless: Chromium with no display (the proxy view only). Browser: headful Chromium under a virtual display. Desktop: the same plus a desktop. */
export type BrowserTier = 'headless' | 'browser' | 'desktop';
export const BROWSER_TIERS: readonly BrowserTier[] = ['headless', 'browser', 'desktop'];

/** Display sizes (FR2); a 1280×800 screenshot costs about 1.3k image tokens, 1920×1080 about 2.6k. */
export const BROWSER_DISPLAYS = ['1280x800', '1024x768', '1366x768', '1920x1080'] as const;
export type BrowserDisplay = (typeof BROWSER_DISPLAYS)[number];

/** Per tool (FR7): follow the default, ask every call, or block. */
export type BrowserToolRule = 'default' | 'ask' | 'block';

/**
 * A request header the browser adds on its own (PRD §24): for requests over https to `hosts` it sets `name` to the value of the
 * Secrets & env entry called `secret`. The pool holds the entry's NAME, never its value; the portal reads the value at delivery
 * and only the browser container gets it. Each host must also be one of the pool's `allowedSites`.
 */
export interface BrowserHeaderRule {
  /** Hosts the header goes to: `app.example.com`, `app.example.com:8443` or `*.example.com`. */
  hosts: string[];
  /** The header's name, e.g. `CF-Access-Client-Id`. */
  name: string;
  /** The Secrets & env entry whose value is the header's value (or, with `key`, the env-file entry that holds it). */
  secret: string;
  /**
   * T-623: a variable inside an env-file entry (`KEY=VALUE` lines). The portal parses the entry at delivery, in memory only, and the header's
   * value is that variable's value; a missing key leaves the header out, with an audited reason that never holds a value. Without it the
   * entry's whole value is the header's value.
   */
  key?: string;
}

/** A variable name inside an env-file entry (`BrowserHeaderRule.key`). */
export const HEADER_SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** What a browser pool holds (PRD §9). Never a secret value: the portal doesn't store website credentials; `headers` names entries. */
export interface BrowserPoolContent {
  tier: BrowserTier;
  display: BrowserDisplay;
  /** Persistent: in the home volume. Fresh: wiped at each browser start. */
  profile: 'persistent' | 'fresh';
  /** Shared logins: one browser context, each Claude session in its own tab. Isolated: a context per session. */
  sessions: 'shared' | 'isolated';
  /** On first use (the first tool call or viewer), or with the workspace. */
  start: 'first_use' | 'with_workspace';
  /** Minutes without a call, viewer or control before Chrome closes; 0 never. */
  idleMinutes: number;
  resources: { cpus: number; memoryMb: number; shmMb: number; pids: number };
  /** Downloads land in ~/Downloads; off blocks them all. */
  downloads: boolean;
  /** Sites the browser may not open (Chrome policy URLBlocklist). */
  blockedSites: string[];
  /** Allowlist mode: block everything but `allowedSites`. */
  allowlistMode: boolean;
  allowedSites: string[];
  /** Headers the browser adds for some hosts, from named secrets (PRD §24). Pools saved before this have none. */
  headers: BrowserHeaderRule[];
  /** Also deliver chrome-devtools-mcp (console, network, traces, Lighthouse). */
  devtools: boolean;
  /** Coordinate tools (click at x,y, wheel scroll) beside the snapshot-based ones. */
  vision: boolean;
  /** Tool name (`browser_file_upload`) → rule. Defaults: Ask for uploads and devtools' network tools, Block for `browser_run_code_unsafe`. */
  toolRules: Record<string, BrowserToolRule>;
  /** The VNC live view (Browser and Desktop tiers). */
  liveView: boolean;
  /** The proxy view: a preview the portal itself renders from the browser's screencast, no VNC (PRD §22). */
  proxyView: boolean;
  /** People may take control from the live views. */
  takeOver: boolean;
  /** Every take-over hides the screen from other viewers (handoffs always do). */
  privateTakeOvers: boolean;
  /** Refuse to start Chrome without its sandbox (FR15). */
  requireSandbox: boolean;
}

export const BROWSER_POOL_DEFAULTS: BrowserPoolContent = {
  tier: 'browser',
  display: '1280x800',
  profile: 'persistent',
  sessions: 'shared',
  start: 'first_use',
  idleMinutes: 30,
  resources: { cpus: 2, memoryMb: 3072, shmMb: 1024, pids: 1024 },
  downloads: true,
  blockedSites: [],
  allowlistMode: false,
  allowedSites: [],
  headers: [],
  devtools: false,
  vision: true,
  toolRules: { browser_file_upload: 'ask', browser_run_code_unsafe: 'block' },
  liveView: true,
  proxyView: true,
  takeOver: true,
  privateTakeOvers: false,
  requireSandbox: false,
};

/** Tools the pool can set a rule for: the ones that need one (the rest follow Claude Code's own permissions). */
export const BROWSER_RULE_TOOLS = [
  'browser_file_upload',
  'browser_run_code_unsafe',
  'browser_evaluate',
  'browser_drop',
  'browser_network_requests',
  'browser_network_request',
  'browser_navigate',
] as const;

/** Chrome's state inside the browser container (PRD §9 `chrome`). */
export type BrowserChromeState = 'asleep' | 'starting' | 'up' | 'closed' | 'crashed' | 'error';

/** The container (companion) as the portal sees it. */
export type BrowserContainerState = 'none' | 'stopped' | 'starting' | 'running' | 'error';

/** The state a person sees (PRD §15.5): one word for the browser as a whole. */
export type BrowserState =
  | 'none'
  | 'workspace_stopped'
  /** Kubernetes: the browser is added, changed or removed when the workspace's pod restarts (PRD §10.3); `detail` says so. */
  | 'restart_needed'
  | 'starting'
  | 'asleep'
  | 'ready'
  | 'working'
  | 'needs_input'
  | 'in_control'
  | 'error';

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
}

export interface BrowserControl {
  held: boolean;
  /** The device that holds it, as a label for people ("Alfian's iPhone"). */
  label: string | null;
  since: string | null;
  leaseUntil: string | null;
  private: boolean;
  /** Whether the caller is the holder. */
  mine: boolean;
}

export type BrowserHandoffState = 'waiting' | 'in_control' | 'handed_back' | 'declined' | 'expired' | 'left' | 'cancelled';

/** A request from the agent for a person to take over (PRD §12.4). `reason` is the agent's words: untrusted, shown quoted. */
export interface BrowserHandoff {
  id: string;
  reason: string;
  /** The scheme and host the portal read from the agent's tab; null when unknown. */
  origin: string | null;
  state: BrowserHandoffState;
  requestedAt: string;
  resolvedAt: string | null;
  note: string;
}

/** `GET /api/workspaces/:target/:name/browser`: everything the Configuration row and the live view header need. */
export interface BrowserStatus {
  workspaceId: string;
  /** The assigned pool, null when the workspace has no browser. */
  pool: { id: string; name: string; revision: number; tier: BrowserTier } | null;
  state: BrowserState;
  /** Why it is in `error`, or what is wrong, as text for people. */
  detail: string | null;
  container: BrowserContainerState;
  chrome: BrowserChromeState | null;
  sandbox: 'on' | 'off' | null;
  display: { width: number; height: number } | null;
  tabs: BrowserTab[];
  control: BrowserControl | null;
  handoffs: BrowserHandoff[];
  viewers: number;
  /** When Chrome closes if nothing uses it. */
  idleStopAt: string | null;
  /** Container memory in use against its limit, bytes. */
  memory: { used: number; limit: number } | null;
  /** The last tool the agent called, and when. */
  lastTool: { name: string; at: string } | null;
  /** Which live views this browser offers right now. */
  views: { vnc: boolean; proxy: boolean };
  /** Whether this connection may take control: needs HTTPS or localhost (PRD §12.1), and the pool must allow it. */
  canTakeOver: boolean;
  /** Why not, when `canTakeOver` is false. */
  takeOverBlocked: string | null;
  /** When the portal read this. */
  at: string;
}

/** `POST /api/workspaces/:target/:name/browser/:action`. */
export type BrowserAction = 'wake' | 'stop' | 'restart';

/** `PUT …/browser/control`: take or renew control, from a device. */
export interface BrowserControlRequest {
  on: boolean;
  /** A stable id this browser tab or app keeps in its own storage, so switching apps keeps the lease (PRD §12.3). */
  deviceId: string;
  /** What to call the device ("iPhone", "Chrome on Mac"). */
  label?: string;
  /** Hide the screen from other viewers. */
  private?: boolean;
  /** Take control from another device that holds it. */
  takeOver?: boolean;
  /** The handoff this answers, when it comes from a handoff card. */
  handoffId?: string;
}

/** `POST …/browser/handoffs/:id`: answer a handoff. */
export interface BrowserHandoffAnswer {
  state: 'handed_back' | 'declined';
  note?: string;
  /** The device answering, so handing back also ends its control. */
  deviceId?: string;
}

/* ---------- The proxy view (browser PRD §22) ---------- */

/**
 * What a viewer's page may send over `…/browser/preview`: the whole list. The portal validates each message again,
 * drops what the viewer's role may not do, and writes the rest to the container as these same messages; raw CDP is
 * never forwarded in either direction. Positions are fractions (0 to 1) of the frame the viewer is looking at.
 */
export type PreviewClientMessage =
  | { t: 'mouse'; a: 'move' | 'down' | 'up' | 'wheel'; x: number; y: number; b?: 0 | 1 | 2; cc?: number; dx?: number; dy?: number; m?: number }
  | { t: 'key'; a: 'down' | 'up'; key: string; code?: string; vk?: number; text?: string; m?: number }
  | { t: 'text'; text: string }
  | { t: 'go'; url: string }
  | { t: 'back' | 'forward' | 'reload' | 'stop' }
  | { t: 'tab'; id: string }
  | { t: 'newTab'; url?: string }
  | { t: 'closeTab'; id: string }
  | { t: 'viewport'; w: number; h: number; dpr?: number; mobile?: boolean }
  | { t: 'viewport'; reset: true }
  | { t: 'quality'; q: number; maxW?: number; fps?: number }
  | { t: 'dialog'; accept: boolean; text?: string }
  | { t: 'ping' };

/** Events on the preview socket (text frames); the screen itself arrives as binary frames. */
export type PreviewServerEvent =
  | { e: 'ready'; role: 'viewer' | 'controller' }
  | { e: 'tabs'; tabs: BrowserTab[]; current: string | null }
  | { e: 'url'; id: string; url: string; title: string }
  | { e: 'loading'; on: boolean }
  | { e: 'dialog'; kind: string; message: string; prompt: string }
  | { e: 'dialog-closed' }
  | { e: 'error'; message: string; fatal?: boolean }
  | { e: 'pong' };

/**
 * The header of a binary frame: the page's size in CSS pixels, the tab it shows, and whether the size is emulated.
 * A binary message on the preview socket is `[u16 big-endian header length][header JSON][JPEG bytes]`.
 */
export interface PreviewFrameHeader {
  dw: number;
  dh: number;
  tab: string;
  emu: boolean;
}

export const BROWSER_API = {
  workspace: (id: string) => `/api/workspaces/${id}/browser`,
} as const;
