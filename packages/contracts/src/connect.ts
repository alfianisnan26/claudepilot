// Connect (docs/prd/targets-connect.md): clusters and single hosts enrolled from the web.
//
// An AGENT on the target dials OUT to the portal over one WebSocket. The portal then reaches the target's Docker API, its Kubernetes API
// or its host (commands, terminals, files) through streams carried on that connection, so the portal needs no inbound reach to the
// target (NAT, firewalls, Caddy and Cloudflare tunnels all work). This file is the single reference for what the web, the server, the
// agent and the install scripts agree on:
//   1 kinds, roles, platforms and what is supported where        6 audit events
//   2 limits and constants                                         7 the tunnel: handshake, frames, stream open, control messages
//   3 what the registry shows                                      8 host service records, Docker policy rules
//   4 enrollment                                                   9 the install scripts: environment, exit codes, plan
//   5 admin requests                                              10 routes, close codes, helpers
// Types and constants only, no Node types: the web imports this file too. Anything that came out of an agent or a host (hostnames,
// versions, log lines, docker error text) is untrusted text: store it trimmed, show it as text, never as markup.

import type { RuntimeKind } from './workspace.js';

/* ------------------------------------------------------------------------------------------------------------------------------- *
 * 1. Kinds, roles, platforms
 * ------------------------------------------------------------------------------------------------------------------------------- */

/**
 * What an enrolled target is:
 *  - `docker`: a CLUSTER of one or more Docker hosts. The agent is a container with the Docker socket behind its policy proxy; the
 *    portal places plain workspace containers on a node. More hosts join with "Add node" (a second enrollment on the same target).
 *  - `swarm`: the same agent, installed once on a swarm manager as a global service, so every node enrolls itself. Workspaces are
 *    still plain containers on a chosen node, never swarm services (interactive and stateful).
 *  - `kubernetes`: a CLUSTER. The agent is a one-replica Deployment with a namespaced ServiceAccount and Role; workspaces are the
 *    existing Deployment + PVC per workspace in its namespace.
 *  - `container`: a SINGLE host. The workspace image runs on a Docker host with the agent inside; the container IS the workspace. The
 *    portal gets no Docker access to the host, only to that container.
 *  - `host`: a SINGLE host. The agent runs on the machine itself and the machine is the workspace (This machine, remotely): no
 *    isolation, a shell as the installing user.
 */
export const CONNECT_KINDS = ['docker', 'swarm', 'kubernetes', 'container', 'host'] as const;
export type ConnectKind = (typeof CONNECT_KINDS)[number];

/** `cluster`: new workspaces can be placed on it. `single`: it is one workspace that exists from the moment it connects. */
export type ConnectRole = 'cluster' | 'single';

export const CONNECT_ROLE: Record<ConnectKind, ConnectRole> = {
  docker: 'cluster',
  swarm: 'cluster',
  kubernetes: 'cluster',
  container: 'single',
  host: 'single',
};

/**
 * What runtime kind the rest of the portal sees. A single is `local` on purpose: the existing UI and server already treat `local` as
 * "one workspace you start and stop; nothing to create, nothing to remove" (NewWorkspaceDialog, WorkspacesPage, internalUrl).
 */
export const CONNECT_RUNTIME_KIND: Record<ConnectKind, RuntimeKind> = {
  docker: 'docker',
  swarm: 'docker',
  kubernetes: 'kubernetes',
  container: 'local',
  host: 'local',
};

/** Where the command is pasted (the operating system of that machine). */
export const CONNECT_PLATFORMS = ['linux', 'macos', 'windows'] as const;
export type ConnectPlatform = (typeof CONNECT_PLATFORMS)[number];

/** `v1`: built and offered. `preview`: offered with a label, checked only in part. `later`: not offered yet. `no`: cannot work. */
export type ConnectSupport = 'v1' | 'preview' | 'later' | 'no';
export interface ConnectSupportCell {
  support: ConnectSupport;
  /** Short note for the wizard's InfoTip (the reason a cell is not plain `v1`, or what the machine needs). */
  note: string;
}

const ok = (note = ''): ConnectSupportCell => ({ support: 'v1', note });

/** The wizard's matrix (PRD §13). Sandbox-checked cells are Linux; macOS and Windows cells are script logic plus manual checklists (🔬). */
export const CONNECT_MATRIX: Record<ConnectKind, Record<ConnectPlatform, ConnectSupportCell>> = {
  docker: {
    linux: ok('Needs Docker, and your user in the docker group (or sudo).'),
    macos: ok('Docker Desktop, Linux containers.'),
    windows: ok('Docker Desktop, Linux containers. PowerShell.'),
  },
  swarm: {
    linux: ok('Run it on a swarm manager.'),
    macos: ok('Docker Desktop with swarm mode on. Run it on the manager.'),
    windows: ok('Docker Desktop with swarm mode on. PowerShell, on the manager.'),
  },
  kubernetes: {
    linux: ok('Needs kubectl pointed at the cluster.'),
    macos: ok('Needs kubectl pointed at the cluster.'),
    windows: ok('Needs kubectl.exe pointed at the cluster. PowerShell.'),
  },
  container: {
    linux: ok('Needs Docker.'),
    macos: ok('Docker Desktop, Linux containers.'),
    windows: ok('Docker Desktop, Linux containers. PowerShell.'),
  },
  host: {
    linux: ok('Needs tmux, git and bash. Runs as you, with no isolation.'),
    macos: { support: 'preview', note: 'Needs tmux, jq, flock and setsid (Homebrew: tmux jq util-linux). Runs as you, with no isolation.' },
    windows: { support: 'later', note: 'Open a WSL2 Linux shell and pick Linux.' },
  },
};

export const connectSupport = (kind: ConnectKind, platform: ConnectPlatform): ConnectSupportCell => CONNECT_MATRIX[kind][platform];

/** What this build of the agent calls itself (semver). The build id (first 12 hex of the bundle's sha256) says exactly which bundle. */
export const CONNECT_AGENT_VERSION = '0.1.0';

/* ------------------------------------------------------------------------------------------------------------------------------- *
 * 2. Limits and constants (changing one is a protocol or policy change: say so in the PRD)
 * ------------------------------------------------------------------------------------------------------------------------------- */

/** The tunnel protocol number an agent and the portal speak. The portal accepts `CONNECT_PROTOCOL_MIN` to `CONNECT_PROTOCOL`. */
export const CONNECT_PROTOCOL = 1;
export const CONNECT_PROTOCOL_MIN = 1;
/** The WebSocket subprotocol: `Sec-WebSocket-Protocol: pilot.tunnel.v1`. */
export const CONNECT_SUBPROTOCOL = 'pilot.tunnel.v1';

/** An enrollment token is `cpen_` plus 43 base64url characters (256 random bits). Only its SHA-256 is stored. */
export const CONNECT_TOKEN_PREFIX = 'cpen_';
export const CONNECT_TOKEN_TTL_MINUTES = { default: 15, cluster: 60, max: 1440 } as const;
export const CONNECT_TOKEN_USES_MAX = 50;
/** How long a used-up token still answers `GET enroll/status`, so the installer can wait for "connected". */
export const CONNECT_TOKEN_STATUS_GRACE_MINUTES = 30;
export const CONNECT_ID_PREFIX = { node: 'nd_', enrollment: 'en_' } as const;

export const CONNECT_LIMITS = {
  /** Mux frame header, bytes (yamux's). */
  frameHeader: 12,
  /** Largest DATA payload a sender writes in one frame. */
  maxFramePayload: 65_536,
  /** Each stream's receive window at the start; a receiver sends a window update once it has consumed `windowUpdateAt`. */
  initialWindow: 262_144,
  windowUpdateAt: 131_072,
  /** Open streams per connection, all services together. */
  maxStreams: 256,
  /** The acceptor's cap per service; one more is answered `busy`. */
  serviceStreams: { docker: 64, kube: 64, host: 32 },
  /**
   * The mux hands frames to the WebSocket only while `ws.bufferedAmount` is below `sendHighWater`, and resumes below `sendLowWater`; between
   * them it drains the streams round-robin, one frame each, control frames (window updates, pings, FIN, RST) first. This is what keeps a
   * keystroke from queuing behind a bulk transfer (PRD §9.3).
   */
  sendHighWater: 131_072,
  sendLowWater: 32_768,
  /** Both sides ping; nothing received for `deadAfterMs` ends the connection. */
  pingEveryMs: 15_000,
  deadAfterMs: 45_000,
  /** From the WebSocket opening to a good `auth`. */
  handshakeMs: 10_000,
  /** From a stream's SYN to the acceptor's answer line. */
  openMs: 10_000,
  /** The open request and answer lines, and a control message line, in bytes. */
  maxOpenLine: 16_384,
  maxControlLine: 262_144,
  /** `ws` maxPayload on both sides. */
  wsMaxPayload: 1_048_576,
  /** How often the agent sends `status` (also sent at once on a change, at most every 2 s). */
  statusEveryS: 30,
  /** Agent reconnect: exponential from `minMs` with full jitter, reset after a connection held `healthyAfterMs`. */
  reconnect: { minMs: 1_000, maxMs: 60_000, healthyAfterMs: 30_000, fatalMs: 3_600_000 },
  /** Unauthenticated sockets the portal holds at once, and how much one may send before `auth`. */
  preAuth: { perIp: 5, total: 100, firstMessageBytes: 8_192, upgradesPerIpPerMinute: 30 },
  /** Wrong enrollment tokens per client address (the same RateLimiter as sign-in). */
  enrollFailures: { attempts: 10, windowMs: 600_000 },
  /** After a key rotation the previous key still authenticates for this long (the agent may have died before saving the new one). */
  rekeyGraceMs: 600_000,
  /** Audit rows kept per target; pending targets nobody enrolled are removed after this many hours. */
  eventsKeep: 5_000,
  pendingTargetHours: 24,
  /** A docker or kube request body the policy proxy reads into memory (create bodies are small; archives are streamed, never read). */
  maxJsonBody: 1_048_576,
} as const;

/* ------------------------------------------------------------------------------------------------------------------------------- *
 * 3. What the registry shows
 * ------------------------------------------------------------------------------------------------------------------------------- */

/** `connected`: every node is. `partial`: some. `offline`: none (it has been seen). `pending`: no node has ever enrolled. */
export type ConnectLink = 'connected' | 'partial' | 'offline' | 'pending';

/** One service an agent offers and whether it works right now. */
export interface ConnectServiceStatus {
  name: 'docker' | 'kube' | 'host';
  ok: boolean;
  /** Why not, as the agent saw it (untrusted text, short). */
  error?: string;
  /** Docker engine version, Kubernetes server version, or the agent's user for `host`. */
  version?: string;
}

export interface ConnectHostUsage {
  cpuPercent: number | null;
  memoryBytes: number | null;
  cores: number | null;
  memoryTotalBytes: number | null;
}

/** `GET` of a node as the registry shows it. Fields from `info` come from the agent: untrusted text. */
export interface ConnectNodeView {
  id: string;
  targetId: string;
  /** The hostname, or the swarm node name; the admin can rename it. */
  name: string;
  state: 'enrolled' | 'revoked';
  link: 'connected' | 'offline';
  connectedSince: string | null;
  lastSeenAt: string | null;
  lastSeenIp: string | null;
  agentVersion: string | null;
  agentBuild: string | null;
  protocol: number | null;
  /** The agent's build differs from the bundle this portal serves (an upgrade is available). */
  outdated: boolean;
  /** The portal can't talk to this agent any more (its protocol is below the minimum): the agent must be upgraded by hand. */
  incompatible: boolean;
  os: string | null;
  arch: string | null;
  runtime: 'host' | 'container' | 'pod' | null;
  rttMs: number | null;
  /** No new workspaces are placed here (running ones are untouched). */
  drained: boolean;
  /** Seconds the agent's clock differs from the portal's at connect (positive: the agent is ahead); null when unknown. */
  clockSkewS: number | null;
  services: ConnectServiceStatus[];
  usage: ConnectHostUsage | null;
  docker: ConnectDockerInfo | null;
  swarm: { nodeId: string; role: 'manager' | 'worker' } | null;
  /** First 32 hex of the SHA-256 of the node's public key: `pilot-agent doctor` prints the same, so a person can compare. */
  keyFingerprint: string;
  rotatedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
}

export interface ConnectTargetSettings {
  /** Kubernetes: where the connector and the workspaces live. Default `claudepilot-workspaces`. */
  namespace?: string;
  storageClass?: string;
  /** PVC size per workspace, e.g. `10Gi`. */
  storage?: string;
  /** The image workspaces use here (docker, swarm, container). Default: the portal's `PORTAL_CONNECT_WORKSPACE_IMAGE`. */
  workspaceImage?: string;
  /** At most this many workspaces on a cluster; null or absent: no limit. */
  maxWorkspaces?: number | null;
  /** A single: whether the portal uses the workspace (switched on) or not (off). */
  running?: boolean;
  /** Whether pools, secrets and the chat host may be delivered into workspaces here (default true). Off: delivery reads "unsupported". */
  delivery?: boolean;
}

/** An enrolled target in the registry. */
export interface ConnectTargetView {
  source: 'enrolled';
  id: string;
  label: string;
  kind: ConnectKind;
  role: ConnectRole;
  /** `pending`: created in the wizard, nothing enrolled yet. */
  state: 'pending' | 'active';
  link: ConnectLink;
  /** Short line for lists: `docker 28.1 · 2 nodes`, `my-ctx / claudepilot-workspaces`, `lab-box (host)`. */
  where: string;
  /** The reason it can't be used right now (offline for how long, no node, a service down). */
  problem?: string;
  nodes: ConnectNodeView[];
  settings: ConnectTargetSettings;
  /** Workspaces on it as last seen (a single: 1). */
  workspaces: number;
  default: boolean;
  /** The newest enrollment that can still be used, so the page can say a token is waiting and when it expires. Never the token ("Command" makes a new one). */
  enrollment: ConnectEnrollment | null;
  portalUrl: string;
  createdAt: string;
  createdBy: string;
}

/** A target the portal finds by itself (PORTAL_DOCKER_SOCKET, the kubeconfig, PORTAL_LOCAL_ENABLED): shown beside the enrolled ones. */
export interface ConnectScannedView {
  source: 'scanned';
  id: string;
  label: string;
  kind: RuntimeKind;
  where: string;
  available: boolean;
  problem?: string;
  /** The person hid it (it is not there, and they don't want it listed). It reappears in the list when it becomes reachable. */
  hidden: boolean;
}

export type ConnectTargetRow = ConnectTargetView | ConnectScannedView;

/** Portal-wide Connect settings (`GET`/`PUT /api/connect/settings`). */
export interface ConnectSettings {
  /** The address targets use to reach the portal, when the operator set one (`PORTAL_CONNECT_URL` or here); null: the browser's own. */
  publicUrl: string | null;
  /** Where `publicUrl` came from; `env` can't be changed here. */
  publicUrlSource: 'env' | 'setting' | null;
  /** Plain `http` to a non-loopback address is refused unless the operator turned this on (`PORTAL_CONNECT_ALLOW_HTTP`). Read only. */
  allowHttp: boolean;
  /** A private CA is configured (`PORTAL_CONNECT_CA_FILE`): the wizard offers it. Read only. */
  caConfigured: boolean;
  tokenTtlMinutes: number;
  /** Where new workspaces go when none is picked. */
  defaultTarget: string | null;
  /** The image enrolled Docker targets and single containers use unless a target says otherwise. Read only. */
  workspaceImage: string;
  /** The build of the agent bundle this portal serves. */
  agentBuild: string;
  agentVersion: string;
}

/* ------------------------------------------------------------------------------------------------------------------------------- *
 * 4. Enrollment
 * ------------------------------------------------------------------------------------------------------------------------------- */

/** What the wizard may set beyond kind, platform and name. Every field is optional; defaults are in PRD §13. */
export interface ConnectInstallOptions {
  /** `kubernetes`: where the connector and the workspaces live. */
  namespace?: string;
  storageClass?: string;
  storage?: string;
  /** `docker`, `swarm`, `container`: the workspace image on that host. */
  workspaceImage?: string;
  /** Name of this node (docker, swarm, host); default is the machine's hostname. */
  nodeName?: string;
  /** Linux Docker kinds: start the command with `sudo`. */
  sudo?: boolean;
  /** `host`: the admin confirmed "a shell as the installing user, no isolation". Required for that kind. */
  hostAccess?: boolean;
  /** Add the portal's configured CA to the commands (private TLS). */
  privateCa?: boolean;
}

/** `POST /api/connect/targets`: makes the target (pending) and its first enrollment. */
export interface CreateConnectTargetRequest {
  kind: ConnectKind;
  platform: ConnectPlatform;
  /** The target's id: a plain name, fixed for its life, the first part of its workspaces' ids. See `connectTargetIdProblem`. */
  id: string;
  /** What lists show. Defaults to the id. */
  label?: string;
  /** The origin the target reaches the portal on: `https`, or `http` on loopback. Default: the configured address, then this request's origin. */
  portalUrl?: string;
  options?: ConnectInstallOptions;
  ttlMinutes?: number;
  /** A cluster can enroll several nodes with one token; a single is always 1. */
  maxUses?: number;
}

/** `POST /api/connect/targets/:id/enrollments`: another token for a target ("Add node", or a lost agent). */
export interface CreateConnectEnrollmentRequest {
  platform: ConnectPlatform;
  options?: ConnectInstallOptions;
  ttlMinutes?: number;
  maxUses?: number;
}

export type ConnectEnrollmentState = 'waiting' | 'used' | 'expired' | 'revoked';

/** A token as lists show it. The token itself exists only in `ConnectEnrollmentCreated`, once. */
export interface ConnectEnrollment {
  id: string;
  targetId: string;
  /** Last 4 characters of the token, to tell tokens apart. */
  last4: string;
  platform: ConnectPlatform;
  state: ConnectEnrollmentState;
  uses: number;
  maxUses: number;
  expiresAt: string;
  createdAt: string;
  createdBy: string;
}

/** The commands for one enrollment. `install` and `verified` contain the token: they are shown once, never stored by the portal. */
export interface ConnectCommands {
  /** What to paste: `curl -fsSL <portal>/connect/install.sh | PILOT_URL=… PILOT_TOKEN=… sh` (PowerShell: `$env:…; irm … | iex`). */
  install: string;
  /** Download to a file, check the printed sha256, then run it: for people who read the script first. */
  verified: string;
  /** No token: they use what the installer left on the machine. */
  upgrade: string;
  uninstall: string;
  doctor: string;
  scriptUrl: string;
  /** SHA-256 of the script as this portal serves it now. */
  scriptSha256: string;
}

/** The reply to making a target or an enrollment. */
export interface ConnectEnrollmentCreated {
  target: ConnectTargetView;
  enrollment: ConnectEnrollment;
  /** The secret, once. */
  token: string;
  commands: ConnectCommands;
}

/** `GET …/enrollments/:id/plan`: what the installer will do for this enrollment, from the same code that builds its plan. No secrets. */
export interface ConnectPlanPreview {
  /** At most about six plain lines: `Pull node:22-bookworm-slim`, `Run container claudepilot-agent-lab with the Docker socket (filtered)`. */
  steps: string[];
  /** Kubernetes: the manifest the installer applies, with the token replaced by `<token>`. */
  manifest: string | null;
}

/** Why an agent-facing call was refused (the `error.details.reason` of the 4xx). */
export const CONNECT_ENROLL_REASONS = ['token_invalid', 'token_expired', 'token_used', 'token_revoked', 'target_enrolled', 'name_taken', 'bad_key', 'insecure_url', 'store_locked'] as const;
export type ConnectEnrollReason = (typeof CONNECT_ENROLL_REASONS)[number];

/** `POST /connect/v1/enroll` (Authorization: Bearer <token>): the agent hands over its PUBLIC key; the private key never leaves it. */
export interface ConnectEnrollRequest {
  /** Ed25519 public key, 32 raw bytes, base64url. */
  publicKey: string;
  hello: ConnectAgentHello;
  /** Name for this node; default the hello's hostname (made unique within the target by the portal). */
  nodeName?: string;
}

export interface ConnectEnrollResult {
  node: string;
  target: string;
  portalId: string | null;
  portalVersion: string;
  /** `wss://…/connect/v1/tunnel` (or `ws://` on loopback), derived from the target's portal address. */
  tunnel: string;
  protocol: number;
}

/** `GET /connect/v1/enroll/status` (Authorization: Bearer <token>): what the installer waits on. */
export interface ConnectEnrollStatus {
  state: 'waiting' | 'enrolled' | 'connected' | 'expired' | 'revoked';
  node?: string;
  target?: string;
}

/* ------------------------------------------------------------------------------------------------------------------------------- *
 * 5. Admin requests
 * ------------------------------------------------------------------------------------------------------------------------------- */

/** `PATCH /api/connect/targets/:id`. The id never changes. */
export interface UpdateConnectTargetRequest {
  label?: string;
  settings?: Partial<ConnectTargetSettings>;
  /** Make it where new workspaces go by default (false clears it if it is). */
  default?: boolean;
}

/** `PATCH /api/connect/nodes/:id`. */
export interface UpdateConnectNodeRequest {
  name?: string;
  drained?: boolean;
}

/**
 * The query of `DELETE /api/connect/targets/:id` that says what happens to the target's workspaces: `?onWorkspaces=keep|remove`. It is NOT
 * called `workspaces`: the portal's session guard (app.ts, `hostileWorkspaceField`) refuses a query of that name whose value is not a
 * workspace id. Build the URL with `CONNECT_API.removeTarget`.
 */
export const CONNECT_REMOVE_QUERY = 'onWorkspaces';

/**
 * `DELETE /api/connect/targets/:id?onWorkspaces=keep|remove` (`CONNECT_API.removeTarget`). A target with workspaces answers 428 CONFIRM_REQUIRED
 * (with `ConnectRemoveBlocked` in `error.details`) until the query says what happens to them: `keep` (default in the dialog) forgets the target
 * and leaves its workspaces where they are; `remove` first removes them on the target (it must be connected).
 */
export interface ConnectRemoveBlocked {
  workspaces: string[];
  connected: boolean;
}

/** `PUT /api/connect/settings`: the settings that are not read-only. */
export interface UpdateConnectSettingsRequest {
  publicUrl?: string | null;
  tokenTtlMinutes?: number;
  defaultTarget?: string | null;
}

/** `PATCH /api/connect/scanned/:id`: hide or unhide a scanned target. */
export interface UpdateConnectScannedRequest {
  hidden: boolean;
}

/* ------------------------------------------------------------------------------------------------------------------------------- *
 * 6. Audit events (`connect_events`; shown in a target's detail)
 * ------------------------------------------------------------------------------------------------------------------------------- */

export const CONNECT_EVENT_TYPES = [
  'target.created',
  'target.updated',
  'target.removed',
  'enrollment.created',
  'enrollment.used',
  'enrollment.rejected',
  'enrollment.revoked',
  'node.enrolled',
  'node.connected',
  'node.disconnected',
  'node.auth_failed',
  'node.duplicate_refused',
  'node.revoked',
  'node.rotated',
  'node.rotation_failed',
  'node.drained',
  'node.outdated',
  'policy.denied',
  'agent.log',
  'settings.changed',
] as const;
export type ConnectEventType = (typeof CONNECT_EVENT_TYPES)[number];

export interface ConnectEvent {
  id: number;
  at: string;
  type: ConnectEventType;
  targetId: string | null;
  nodeId: string | null;
  /** The audit string of whoever acted: `user:<id>` (an admin: `user:u_owner`), `agent:<node id>`, `system`, or `anonymous` (a refused token or key). */
  actor: string;
  /** The client address, when there is one. */
  ip: string | null;
  /** Small, flat, no secrets; agent-supplied text is trimmed and untrusted. Never a token, a key, an argv or a file's content. */
  detail: Record<string, string | number | boolean | null>;
}

/* ------------------------------------------------------------------------------------------------------------------------------- *
 * 7. The tunnel (PRD §9)
 *
 * One WebSocket per node, `wss://<portal>/connect/v1/tunnel`, subprotocol `pilot.tunnel.v1`, permessage-deflate OFF.
 *  - TEXT messages are the handshake (JSON, below), only before the first binary message.
 *  - BINARY messages are mux frames, one frame per message (a receiver parses the byte stream: it must also cope with several frames in
 *    one message). The wire format is yamux's (hashicorp/yamux spec.md): a Go agent can use that library unchanged.
 *  - The agent (the WebSocket client) opens odd stream ids, the portal even ones.
 * ------------------------------------------------------------------------------------------------------------------------------- */

/** Handshake 1, portal to agent, right after the WebSocket opens. */
export interface ConnectChallenge {
  t: 'challenge';
  v: 1;
  /** A fresh id for this connection; it is part of what the agent signs. */
  connId: string;
  /** 32 random bytes, base64url, good for this connection only and for `handshakeMs`. */
  nonce: string;
  serverTime: string;
  protocol: { min: number; max: number };
}

/** What an agent says about itself in `auth` and in `POST enroll`. All of it is informational and untrusted. */
export interface ConnectAgentHello {
  agentVersion: string;
  /** First 12 hex of the SHA-256 of the agent bundle that is running. */
  agentBuild: string;
  protocol: number;
  os: string;
  arch: string;
  hostname: string;
  /** What it was installed as. */
  mode: ConnectKind;
  /** Where the agent itself runs. */
  runtime: 'host' | 'container' | 'pod';
  services: ConnectServiceStatus[];
  /** The agent's clock, ISO. */
  clock: string;
  startedAt: string;
  /** The portal id the agent pinned at its first welcome (null before). A different one in `welcome` makes the agent refuse. */
  portalId?: string | null;
  swarm?: { nodeId: string; role: 'manager' | 'worker' };
}

/** Handshake 2, agent to portal: proof of the private key. See `CONNECT_SIGNED_MESSAGE`. */
export interface ConnectAuth {
  t: 'auth';
  node: string;
  /** Ed25519 signature over the signed message, base64url. */
  sig: string;
  hello: ConnectAgentHello;
}

/** Handshake 3 (ok), portal to agent. Mux frames follow. The agent then opens the `control` stream. */
export interface ConnectWelcome {
  t: 'welcome';
  v: 1;
  node: string;
  target: string;
  portalId: string | null;
  portalVersion: string;
  /** The build of the bundle this portal serves (the agent says "update available" when it differs). */
  agentBuild: string;
  protocol: number;
  heartbeat: { pingEveryMs: number; deadAfterMs: number };
}

/** Handshake 3 (refused). The portal closes the WebSocket with the code of `CONNECT_CLOSE` that matches. */
export interface ConnectReject {
  t: 'reject';
  code: ConnectRejectCode;
  message: string;
  retryAfterS?: number;
}

export const CONNECT_REJECT_CODES = [
  'unknown_node',
  'revoked',
  'target_removed',
  'bad_signature',
  'bad_request',
  'upgrade_required',
  'rate_limited',
  'already_connected',
  'store_locked',
  'portal_mismatch',
  'disabled',
] as const;
export type ConnectRejectCode = (typeof CONNECT_REJECT_CODES)[number];

/** Rejections an agent must not retry quickly: it waits `CONNECT_LIMITS.reconnect.fatalMs` and logs loudly (never exits: a restart policy would loop). */
export const CONNECT_REJECT_FATAL: readonly ConnectRejectCode[] = ['unknown_node', 'revoked', 'target_removed', 'upgrade_required', 'portal_mismatch'];

/**
 * What the agent signs with its Ed25519 private key (no prehash): the UTF-8 bytes of
 *   `claudepilot-connect-v1\n<connId>\n<nonce>\n<node id>`
 * `connId` and `nonce` are copied from the challenge exactly as sent. A signature made for one challenge can't be used for another.
 */
export const CONNECT_SIGNED_MESSAGE_PREFIX = 'claudepilot-connect-v1';
export const connectSignedMessage = (connId: string, nonce: string, nodeId: string): string => `${CONNECT_SIGNED_MESSAGE_PREFIX}\n${connId}\n${nonce}\n${nodeId}`;

/** A key rotation signs, with the OLD key: `claudepilot-connect-rekey-v1\n<node id>\n<new public key, base64url>`. */
export const CONNECT_REKEY_MESSAGE_PREFIX = 'claudepilot-connect-rekey-v1';
export const connectRekeyMessage = (nodeId: string, newPublicKey: string): string => `${CONNECT_REKEY_MESSAGE_PREFIX}\n${nodeId}\n${newPublicKey}`;

/** Known answers both ends' tests must reproduce (computed with Node's crypto; Ed25519 signatures are deterministic). */
export const CONNECT_TEST_VECTORS = {
  handshake: {
    /** The private key's 32-byte seed, base64url (bytes 0..31). PKCS8 DER = `302e020100300506032b657004220420` + seed. */
    seed: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    publicKey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',
    /** First 32 hex of SHA-256(raw public key). */
    fingerprint: '56475aa75463474c0285df5dbf2bcab7',
    connId: 'c0ffee00-0000-4000-8000-000000000001',
    nonce: '__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA',
    node: 'nd_0123456789ab',
    signature: 'BOeHtbSS4XZDc4uK_kpPsWtJ4dY5gjJkYXODktwo1WcsOrnjVAdBdFSR-Qz4tbKKzfwcnIRShkllrZ9HiKHKBQ',
  },
  /** Frame headers, hex (12 bytes: version, type, flags(2), stream id(4), length(4), big-endian). */
  frames: {
    dataSynStream1Len5: '000000010000000100000005',
    windowUpdateStream3Plus262144: '000100000000000300040000',
    pingSynValue01020304: '000200010000000001020304',
    dataFinStream2Len0: '000000040000000200000000',
    goAwayNormal: '000300000000000000000000',
  },
} as const;

/** Mux frame constants (yamux): see the vectors above. */
export const CONNECT_MUX = {
  version: 0,
  type: { data: 0, window: 1, ping: 2, goAway: 3 },
  /** SYN opens a stream (and, on a ping, asks); ACK accepts (and answers a ping); FIN half-closes; RST resets. */
  flag: { syn: 1, ack: 2, fin: 4, rst: 8 },
  goAway: { normal: 0, protocol: 1, internal: 2 },
} as const;

/** The services a stream can name. `control` is opened by the agent, once per connection; the others only by the portal. */
export const CONNECT_SERVICES = ['control', 'docker', 'kube', 'host'] as const;
export type ConnectService = (typeof CONNECT_SERVICES)[number];

/**
 * The first thing on every stream, from the opener: one JSON line ending in `\n` (at most `maxOpenLine` bytes). The acceptor answers one
 * line (`ConnectOpenResponse`). After an `ok` answer: `docker` and `kube` carry raw HTTP/1.1 bytes (the Docker Engine API, the
 * Kubernetes API); `control` carries JSON lines (`ConnectAgentMessage` one way, `ConnectPortalMessage` the other); `host` carries
 * records (section 8).
 */
export interface ConnectOpenRequest {
  v: 1;
  service: ConnectService;
  /** `host` only. */
  args?: ConnectHostOpen;
  /** 8 hex characters, in both sides' logs, to follow one request across the tunnel. */
  trace?: string;
}

export const CONNECT_STREAM_ERRORS = ['bad_open', 'service_unavailable', 'busy', 'denied', 'upstream_unreachable', 'timeout', 'internal'] as const;
export type ConnectStreamError = (typeof CONNECT_STREAM_ERRORS)[number];

export type ConnectOpenResponse = { v: 1; ok: true } | { v: 1; ok: false; code: ConnectStreamError; message: string };

/** `control` messages, agent to portal: one JSON object per line. */
export type ConnectAgentMessage = ConnectStatusMessage | ConnectLogMessage | ConnectRekeyMessage | ConnectByeMessage;

/** What the Docker engine on the node says about itself (from `GET /info`). */
export interface ConnectDockerInfo {
  engine: string;
  apiVersion: string;
  os: string;
  arch: string;
  ncpu: number;
  memTotal: number;
  containers: number;
  running: number;
  /** Docker Desktop (the socket is the VM's). */
  desktop: boolean;
  /** The workspace image refs the agent's policy allows creating containers from. */
  images: string[];
}

/** Sent every `statusEveryS` and on a change. The portal keeps the last one in memory and a summary in the registry. */
export interface ConnectStatusMessage {
  t: 'status';
  at: string;
  services: ConnectServiceStatus[];
  usage?: ConnectHostUsage;
  docker?: ConnectDockerInfo;
  swarm?: { nodeId: string; role: 'manager' | 'worker' };
  /** Requests the policy proxy refused since the last status, by rule (see `CONNECT_DOCKER_RULES`). */
  denied?: { rule: string; count: number }[];
  /** Streams open now, by service. */
  streams?: { docker: number; kube: number; host: number };
}

/** A line for the target's audit view. The agent sends few (at most 20 a minute) and never a secret, a command line or a file's content. */
export interface ConnectLogMessage {
  t: 'log';
  level: 'info' | 'warn' | 'error';
  message: string;
  at: string;
}

/** Key rotation, agent side: the new public key, signed with the old key (`connectRekeyMessage`). */
export interface ConnectRekeyMessage {
  t: 'rekey';
  publicKey: string;
  sig: string;
}

export interface ConnectByeMessage {
  t: 'bye';
  reason: 'shutdown' | 'upgrade' | 'uninstall' | 'error';
  message?: string;
}

/** `control` messages, portal to agent. */
export type ConnectPortalMessage = ConnectConfigMessage | ConnectRekeyAnswer | ConnectNoticeMessage | ConnectRevokedMessage;

/** Sent after the control stream opens, and again when something in it changes. */
export interface ConnectConfigMessage {
  t: 'config';
  portalId: string | null;
  statusEveryS: number;
  /** Per-service stream caps the agent applies (it never raises its own local caps). */
  limits: { docker: number; kube: number; host: number };
  /**
   * `kube` only: the bearer the portal's loopback listener sends; the agent's proxy refuses a request that doesn't carry it (so another
   * process on the portal's machine can't use the connector). New at every connect. Never logged.
   */
  kubeLocalToken?: string;
  /** Shown in the agent's `doctor` and in logs ("update available"). */
  agentBuild: string;
}

/** The answer to `rekey`: `ok` once the portal stored the new key (the agent then swaps its identity file), else refused. */
export type ConnectRekeyAnswer = { t: 'rekey-answer'; ok: true; publicKey: string } | { t: 'rekey-answer'; ok: false; reason: string };

/** The portal asks the agent to rotate its key now (an admin pressed "Rotate key"). The agent answers with `rekey`. */
export interface ConnectNoticeMessage {
  t: 'notice';
  level: 'info' | 'warn';
  message: string;
  /** `rotate`: start a key rotation. */
  action?: 'rotate';
}

/** Sent just before the portal closes the connection because the node was revoked or its target removed. */
export interface ConnectRevokedMessage {
  t: 'revoked';
  reason: string;
}

/* ------------------------------------------------------------------------------------------------------------------------------- *
 * 8. The `host` service and the Docker policy
 * ------------------------------------------------------------------------------------------------------------------------------- */

/** What a `host` stream does (the open request's `args`). `user` is the workspace user (`node`) or root; on a `host` kind root means the agent's own user. */
export type ConnectHostOpen =
  | {
      op: 'exec';
      argv: string[];
      cwd?: string;
      /** Added to the workspace user's environment. Values are never logged. */
      env?: Record<string, string>;
      user?: 'node' | 'root';
      /** A terminal of this size; absent: pipes. */
      tty?: { cols: number; rows: number };
      /** Merge stderr into stdout (no `STDERR` records). Always true with a tty. */
      merge?: boolean;
    }
  /** The portal sends a tar archive (`DATA` records, then `EOF`); the agent extracts it with each entry's owner and mode. */
  | { op: 'put' }
  /** The agent sends the file (`DATA` records), then `RESULT`. */
  | { op: 'read'; path: string; maxBytes?: number };

/**
 * After the open answer, a `host` stream carries records both ways: 1 byte kind, 4 bytes payload length (big-endian), the payload.
 * A payload is at most `maxFramePayload` bytes. `DATA`: stdin (portal to agent) or stdout (agent to portal; stdout and stderr merged
 * when `merge` or a tty). `STDERR`: agent to portal only. `RESIZE`: portal to agent, JSON `{cols,rows}`. `EOF`: stdin ends (portal to
 * agent) or the file is complete (agent to portal, before `RESULT`). `RESULT`: agent to portal, last record, JSON `ConnectHostResult`.
 * `SIGNAL`: portal to agent, JSON `{signal:'SIGTERM'|'SIGINT'|'SIGKILL'|'SIGHUP'}`.
 */
export const CONNECT_HOST_RECORD = { data: 1, stderr: 2, resize: 3, eof: 4, result: 5, signal: 6 } as const;

export interface ConnectHostResult {
  /** Exit code, or null when it died of a signal or could not be started. */
  code: number | null;
  signal?: string;
  error?: { code: 'ENOENT' | 'EACCES' | 'E2BIG' | 'ETIMEDOUT' | 'EIO' | 'EINVAL' | 'TOO_LARGE' | 'FAILED'; message: string };
  /** `put`: the entries the agent did not write (at most 50), each with why: `path`, `link`, `type`, `escape` or an error code. Added by T2. */
  skipped?: { path: string; reason: string }[];
}

/** The only Docker profile in v1. `full` is reserved: it will be a flag the person sets on the host at install time, never a portal setting. */
export const CONNECT_DOCKER_PROFILES = ['managed'] as const;
export type ConnectDockerProfile = (typeof CONNECT_DOCKER_PROFILES)[number];

/** The rule ids the policy proxy reports in `status.denied` and logs (PRD appendix A). */
export const CONNECT_DOCKER_RULES = [
  'path',
  'method',
  'unmanaged',
  'events.filter',
  'create.name',
  'create.image',
  'create.label',
  'create.field',
  'create.privileged',
  'create.namespace',
  'create.bind',
  'create.volume',
  'create.device',
  'create.capability',
  'create.network',
  'create.port',
  'exec.privileged',
  'volume.name',
  'volume.options',
  'image.ref',
  'build',
  'body',
  'upgrade',
] as const;
export type ConnectDockerRule = (typeof CONNECT_DOCKER_RULES)[number];

/** `pilot-agent doctor --json`, and what the install script's checks print in the same vocabulary. `ok: null` means skipped. */
export const CONNECT_DOCTOR_CHECKS = [
  'portal.dns',
  'portal.tcp',
  'portal.tls',
  'portal.health',
  'portal.websocket',
  'portal.proxy',
  'clock',
  'identity',
  'docker.socket',
  'docker.api',
  'docker.policy',
  'kube.api',
  'kube.rbac',
  'host.tools',
  'host.pty',
  'disk',
] as const;
export type ConnectDoctorCheckId = (typeof CONNECT_DOCTOR_CHECKS)[number];

export interface ConnectDoctorCheck {
  id: ConnectDoctorCheckId;
  ok: boolean | null;
  detail: string;
  /** What to do about it, one line. */
  hint?: string;
}

export interface ConnectDoctorReport {
  agentVersion: string;
  agentBuild: string;
  protocol: number;
  at: string;
  checks: ConnectDoctorCheck[];
}

/* ------------------------------------------------------------------------------------------------------------------------------- *
 * 9. The install scripts (PRD §13): static `install.sh` and `install.ps1`, a plan fetched with the token
 * ------------------------------------------------------------------------------------------------------------------------------- */

/** Variables the generated command and the scripts use. The token travels only here and in the `Authorization` header, never in a URL or an argument. */
export const CONNECT_INSTALL_ENV = {
  /** The portal's origin. */
  url: 'PILOT_URL',
  /** The enrollment token. */
  token: 'PILOT_TOKEN',
  /** `1`: print what would happen and change nothing. */
  dryRun: 'PILOT_DRY_RUN',
  /** `1`: no questions (the host-access confirmation too: pass it only when the admin ticked it in the wizard). */
  yes: 'PILOT_YES',
  /** `1`: don't wait for the node to show as connected. */
  noWait: 'PILOT_NO_WAIT',
  /** `1`: shell tracing without the token. */
  debug: 'PILOT_DEBUG',
  /** A PEM file that signs the portal's certificate (private CA). */
  ca: 'PILOT_CA',
  /** Extra request headers (`Name: value`, one per line), for a portal behind a proxy that wants them. Never logged. */
  headers: 'PILOT_HEADERS',
  /** `1`: build the workspace image from the portal's context instead of pulling it. */
  buildImage: 'PILOT_BUILD_IMAGE',
  /** Where the agent keeps its state (host kind). */
  dataDir: 'PILOT_DATA_DIR',
  /** How a host-kind agent is kept running: `systemd` (user unit), `launchd`, `nohup` (a start script) or `none` (the person runs it). Default: what the machine has. */
  service: 'PILOT_SERVICE',
  /** Where to get the official Node.js tarball from when a host has none (default https://nodejs.org/dist). */
  nodeMirror: 'PILOT_NODE_MIRROR',
  /** Kubernetes: the kubectl context to use (default: the current one; the installer shows it and asks before applying). */
  kubeContext: 'PILOT_KUBE_CONTEXT',
} as const;

/**
 * The agent's own environment (what the installer, the Kubernetes manifest and the Swarm service set; `agent.json` holds the same
 * values for a host). None of these holds a secret except `enrollToken`, which only Kubernetes and Swarm use and the agent forgets once
 * it has an identity.
 */
export const CONNECT_AGENT_ENV = {
  url: 'PILOT_URL',
  mode: 'PILOT_MODE',
  dataDir: 'PILOT_DATA_DIR',
  dockerSocket: 'PILOT_DOCKER_SOCKET',
  /** Comma-separated image references the Docker policy allows containers to be created from. */
  images: 'PILOT_IMAGES',
  kubeNamespace: 'PILOT_KUBE_NAMESPACE',
  nodeName: 'PILOT_NODE_NAME',
  ca: 'PILOT_CA',
  headers: 'PILOT_HEADERS',
  logLevel: 'PILOT_LOG_LEVEL',
  /** Kubernetes and Swarm: enroll at first start with this token (from a Secret, or the service environment). Absent once an identity exists. */
  enrollToken: 'PILOT_ENROLL_TOKEN',
  /** Kubernetes: the Secret the agent keeps its identity in. */
  identitySecret: 'PILOT_IDENTITY_SECRET',
  /** The bootstrap fetcher: what to download, and the sha256 it must have. */
  bundleUrl: 'PILOT_BUNDLE_URL',
  bundleSha256: 'PILOT_BUNDLE_SHA256',
  /** `host` mode: the directory `/home/node` maps to (default the user's home). */
  home: 'PILOT_HOME',
  /** `1`: the portal address may be plain `http` (a lab portal with PORTAL_CONNECT_ALLOW_HTTP; the installer sets it, the agent can't know). Added by T2. */
  allowHttp: 'PILOT_ALLOW_HTTP',
} as const;

/** Subcommands: `… | sh -s -- <subcommand>`. */
export const CONNECT_INSTALL_COMMANDS = ['install', 'upgrade', 'uninstall', 'doctor', 'status'] as const;
export type ConnectInstallCommand = (typeof CONNECT_INSTALL_COMMANDS)[number];

/** Exit codes of both scripts. The last line printed is `PILOT_RESULT=<connected|installed|failed|dry-run>` for tests and wrappers. */
export const CONNECT_INSTALL_EXIT = {
  ok: 0,
  preflight: 10,
  unreachable: 11,
  tokenRejected: 12,
  download: 13,
  install: 14,
  notConnected: 15,
  declined: 20,
} as const;
export const CONNECT_INSTALL_RESULT_PREFIX = 'PILOT_RESULT=';

/**
 * The keys of `GET /connect/v1/plan` (text, one `KEY=value` per line, values limited to `[A-Za-z0-9._:/@,+=-]`; the scripts read
 * them with a fixed allow-list and never `eval` them). More keys may be added; an unknown key is ignored.
 */
export const CONNECT_PLAN_KEYS = [
  'PILOT_PLAN',
  'PILOT_KIND',
  'PILOT_ROLE',
  'PILOT_TARGET',
  'PILOT_NAME',
  'PILOT_PLATFORM',
  'PILOT_PORTAL',
  'PILOT_TUNNEL',
  'PILOT_PROTOCOL',
  'PILOT_AGENT_BUILD',
  'PILOT_AGENT_URL',
  'PILOT_AGENT_SHA256',
  'PILOT_NODE_IMAGE',
  'PILOT_NODE_VERSION',
  'PILOT_NODE_SHA256_LINUX_X64',
  'PILOT_NODE_SHA256_LINUX_ARM64',
  'PILOT_NODE_SHA256_DARWIN_X64',
  'PILOT_NODE_SHA256_DARWIN_ARM64',
  'PILOT_WORKSPACE_IMAGE',
  'PILOT_IMAGES',
  'PILOT_PTY_PACKAGE',
  'PILOT_NAMESPACE',
  'PILOT_STORAGE_CLASS',
  'PILOT_STORAGE',
  'PILOT_MAX_USES',
  'PILOT_EXPIRES',
  'PILOT_HOST_ACK',
  'PILOT_CA_SHA256',
  /** Added by T4. The pty package's npm integrity (`sha512-…`), and its platform package's per OS and architecture (PRD §13.4). */
  'PILOT_PTY_INTEGRITY',
  'PILOT_PTY_INTEGRITY_LINUX_X64',
  'PILOT_PTY_INTEGRITY_LINUX_ARM64',
  'PILOT_PTY_INTEGRITY_DARWIN_X64',
  'PILOT_PTY_INTEGRITY_DARWIN_ARM64',
  /** Added by T4. `1`: the portal accepts a plain `http` address (PORTAL_CONNECT_ALLOW_HTTP); the installer then sets the agent's `allowHttp`. */
  'PILOT_ALLOW_HTTP',
] as const;
export type ConnectPlanKey = (typeof CONNECT_PLAN_KEYS)[number];

/* ------------------------------------------------------------------------------------------------------------------------------- *
 * 10. Routes, close codes, helpers
 * ------------------------------------------------------------------------------------------------------------------------------- */

const seg = encodeURIComponent;

/** Admin routes: the session cookie, the Origin check, JSON `{ data }` / `{ error }` like every other `/api` route. */
export const CONNECT_API = {
  /** GET: `ConnectTargetRow[]` (scanned and enrolled). POST `CreateConnectTargetRequest`: `ConnectEnrollmentCreated` (201). */
  targets: '/api/connect/targets',
  /** GET: `ConnectTargetView`. PATCH `UpdateConnectTargetRequest`: `ConnectTargetView`. (DELETE: see `removeTarget`.) */
  target: (id: string) => `/api/connect/targets/${seg(id)}`,
  /** DELETE: `{ ok: true }`. A target with workspaces answers 428 `ConnectRemoveBlocked` until `onWorkspaces` says `keep` or `remove` (`CONNECT_REMOVE_QUERY`). */
  removeTarget: (id: string, onWorkspaces?: 'keep' | 'remove') => `/api/connect/targets/${seg(id)}${onWorkspaces ? `?${CONNECT_REMOVE_QUERY}=${onWorkspaces}` : ''}`,
  /** POST: check it now (not the cached answer): `ConnectTargetView`. */
  check: (id: string) => `/api/connect/targets/${seg(id)}/check`,
  /** GET: `ConnectEnrollment[]`. POST `CreateConnectEnrollmentRequest`: `ConnectEnrollmentCreated` (201). */
  enrollments: (id: string) => `/api/connect/targets/${seg(id)}/enrollments`,
  /** DELETE: revoke the token (it stops working at once). */
  enrollment: (id: string, enrollmentId: string) => `/api/connect/targets/${seg(id)}/enrollments/${seg(enrollmentId)}`,
  /** GET: `ConnectPlanPreview`. */
  plan: (id: string, enrollmentId: string) => `/api/connect/targets/${seg(id)}/enrollments/${seg(enrollmentId)}/plan`,
  /** GET `?limit=&before=<id>`: `ConnectEvent[]`, newest first. */
  events: (id: string) => `/api/connect/targets/${seg(id)}/events`,
  /** PATCH `UpdateConnectNodeRequest`: `ConnectNodeView`. DELETE: revoke the node (disconnected now, can't come back with its key). */
  node: (nodeId: string) => `/api/connect/nodes/${seg(nodeId)}`,
  /** POST: ask the connected agent to rotate its key (202); 409 when it is offline. */
  rotate: (nodeId: string) => `/api/connect/nodes/${seg(nodeId)}/rotate`,
  /** PATCH `UpdateConnectScannedRequest`: `ConnectScannedView`. */
  scanned: (id: string) => `/api/connect/scanned/${seg(id)}`,
  /** GET: `ConnectSettings`. PUT `UpdateConnectSettingsRequest`: `ConnectSettings`. */
  settings: '/api/connect/settings',
} as const;

/**
 * Agent-facing routes: no session cookie and none of `/api`'s Origin machinery, outside `/api`. A request that carries an `Origin` header to
 * `enroll` or `tunnel` is refused: a browser must never act as an agent. ONE prefix, `/connect/`, so a proxy, a tunnel or an access
 * policy that must let agents through needs one rule. How each is authorized is said here; none of them reads a cookie.
 */
export const CONNECT_PUBLIC = {
  prefix: '/connect/',
  /** GET, open: `{ ok: true, protocol, version }` (what `doctor` and the installer's preflight call). */
  health: '/connect/v1/health',
  /** GET, open: the static installers (text/plain). `ETag` is their sha256. */
  installSh: '/connect/install.sh',
  installPs1: '/connect/install.ps1',
  /** GET, `Authorization: Bearer <token>`: the plan (text, `KEY=value` lines). Does not use the token up. */
  plan: '/connect/v1/plan',
  /** GET, bearer: the Kubernetes manifest (YAML) for a `kubernetes` enrollment. */
  manifest: '/connect/v1/manifest',
  /** POST, bearer: `ConnectEnrollRequest` → `{ data: ConnectEnrollResult }`. Uses the token up. */
  enroll: '/connect/v1/enroll',
  /** GET, bearer: `{ data: ConnectEnrollStatus }`; still answers for `CONNECT_TOKEN_STATUS_GRACE_MINUTES` after the last use. */
  enrollStatus: '/connect/v1/enroll/status',
  /** GET, WebSocket upgrade, authorized by the signed challenge (section 7). */
  tunnel: '/connect/v1/tunnel',
  /** GET, open: `{ build, sha256, version, protocol, url }` of the bundle this portal serves (what `upgrade` reads). */
  latest: '/connect/v1/agent/latest.json',
  /** GET, open: the agent bundle (an ES module, one file). */
  bundle: (build: string) => `/connect/v1/agent/${seg(build)}/agent.mjs`,
  /** GET, open: the workspace image's build context (Dockerfile and cp-session) as a tar.gz, for `PILOT_BUILD_IMAGE=1`. */
  workspaceContext: '/connect/v1/image/workspace/context.tgz',
} as const;

/** WebSocket close codes (application range). */
export const CONNECT_CLOSE = {
  unauthorized: 4401,
  forbidden: 4403,
  timeout: 4408,
  alreadyConnected: 4409,
  upgradeRequired: 4426,
  rateLimited: 4429,
  internal: 4500,
  unavailable: 4503,
} as const;

/** The close code that goes with a rejection. */
export const CONNECT_CLOSE_OF: Record<ConnectRejectCode, number> = {
  unknown_node: CONNECT_CLOSE.unauthorized,
  revoked: CONNECT_CLOSE.unauthorized,
  bad_signature: CONNECT_CLOSE.unauthorized,
  target_removed: CONNECT_CLOSE.forbidden,
  disabled: CONNECT_CLOSE.forbidden,
  portal_mismatch: CONNECT_CLOSE.forbidden,
  bad_request: CONNECT_CLOSE.timeout,
  already_connected: CONNECT_CLOSE.alreadyConnected,
  upgrade_required: CONNECT_CLOSE.upgradeRequired,
  rate_limited: CONNECT_CLOSE.rateLimited,
  store_locked: CONNECT_CLOSE.unavailable,
};

/** Ids that can't be an enrolled target's: the scanned targets', and words the routes and pages use. */
export const CONNECT_RESERVED_IDS: readonly string[] = ['docker', 'docker-host', 'kubernetes', 'local', 'api', 'connect', 'new', 'targets', 'default', 'scanned'];

export const CONNECT_TARGET_ID_MAX = 30;
export const CONNECT_LABEL_MAX = 40;

/**
 * Why a target id can't be used, or null when it can. It becomes the first part of every workspace id on the target (`<id>/<name>`), a
 * URL segment and part of container names, so it is a plain lowercase name.
 */
export function connectTargetIdProblem(id: string): string | null {
  if (!id) return 'Give it a name.';
  if (id.length > CONNECT_TARGET_ID_MAX) return `Use at most ${CONNECT_TARGET_ID_MAX} characters.`;
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/.test(id)) return 'Lowercase letters, digits and dashes; start with a letter, don’t end with a dash.';
  if (CONNECT_RESERVED_IDS.includes(id)) return 'That name is taken by a built-in target.';
  return null;
}

/** True for a string shaped like an enrollment token (`cpen_` + 43 base64url characters). Does not say it is valid. */
export const isConnectToken = (s: string): boolean => /^cpen_[A-Za-z0-9_-]{43}$/.test(s);

/** What a list shows of a token: `cpen_…1a2b`. */
export const connectTokenPreview = (last4: string): string => `${CONNECT_TOKEN_PREFIX}…${last4}`;

/** The WebSocket URL for a portal origin (`https://x` → `wss://x/connect/v1/tunnel`, `http://x` → `ws://x/connect/v1/tunnel`). */
export function connectTunnelUrl(origin: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base.replace(/^http/, 'ws')}${CONNECT_PUBLIC.tunnel}`;
}

/** Whether a portal origin may be used for an agent: `https`, or `http` on loopback. (`PORTAL_CONNECT_ALLOW_HTTP` widens it on the server only.) */
export function connectOriginProblem(origin: string, allowHttp = false): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return 'Not an address.';
  }
  if (url.username || url.password) return 'No user name or password in the address.';
  if (url.pathname !== '/' || url.search || url.hash) return 'The address alone, with no path.';
  if (url.protocol === 'https:') return null;
  if (url.protocol !== 'http:') return 'Use https.';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  return loopback || allowHttp ? null : 'Use https: this address would send the token and every command in the clear.';
}
