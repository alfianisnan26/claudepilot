// The seams the Connect packages build against (docs/prd/targets-connect.md appendix E). T1 owns this file; T2, T3 and T4 import from it.
// Additions are allowed; a changed signature goes through the coordinator.
import type { Duplex } from 'node:stream';
import type {
  ConnectAgentHello, ConnectEnrollment, ConnectEnrollStatus, ConnectHostOpen, ConnectInstallOptions, ConnectKind, ConnectNodeView,
  ConnectStatusMessage, ConnectStreamError, ConnectTargetSettings, Workspace,
} from '@portal/contracts';
import type { Runtime } from '../workspaces/runtime.js';

/** What a call over the tunnel fails with when there is no tunnel or the agent refused. */
export class ConnectError extends Error {
  constructor(readonly code: 'agent_offline' | 'target_removed' | ConnectStreamError, message: string) { super(message); }
}

/** A stream to a service on the agent, shaped like a connected socket (the net.Socket methods an http.Agent calls are no-ops). */
export type TunnelStream = Duplex & {
  setKeepAlive(enable?: boolean, ms?: number): TunnelStream; setNoDelay(on?: boolean): TunnelStream;
  setTimeout(ms: number, cb?: () => void): TunnelStream; ref(): TunnelStream; unref(): TunnelStream;
};

export interface NodeInfo { hello: ConnectAgentHello; status: ConnectStatusMessage | null; connectedAt: string; rttMs: number | null; ip: string | null }

/** One per node. Always exists for an enrolled node; `connected()` says whether the tunnel is up. */
export interface NodeLink {
  readonly nodeId: string;
  readonly targetId: string;
  connected(): boolean;
  /** Resolves when the agent accepted the stream; rejects with ConnectError. `args` is for `host` only. */
  open(service: 'docker' | 'kube' | 'host', args?: ConnectHostOpen, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<TunnelStream>;
  info(): NodeInfo | null;
  /** Fires on connect (true) and on disconnect (false). Returns an unsubscribe. */
  onChange(fn: (connected: boolean) => void): () => void;
  /** The per-connection bearer for the Kubernetes loopback listener; null when not connected. */
  kubeToken(): string | null;
}

export interface ConnectTargetRecord {
  id: string; label: string; kind: ConnectKind; portalUrl: string; settings: ConnectTargetSettings; active: boolean; isDefault: boolean;
}
export interface ConnectNodeRecord { id: string; targetId: string; name: string; drained: boolean; keyFingerprint: string }

/** What a runtime needs from the registry (T1 implements; T3 consumes). */
export interface RuntimeDeps {
  portalId(): string | null;
  /** The workspace image for this target (settings, else the portal's PORTAL_CONNECT_WORKSPACE_IMAGE). */
  image(target: ConnectTargetRecord): string;
  snapshots: { save(targetId: string, list: Workspace[]): void; last(targetId: string): { at: string; workspaces: Workspace[] } | null };
  /** A single's "switched on" flag. */
  switch: { get(targetId: string): boolean; set(targetId: string, on: boolean): void };
  log(line: string): void;
}

/** T3 implements it; T1 calls it when a target becomes usable or changes. One Runtime per target. */
export type RuntimeFactory = (target: ConnectTargetRecord, nodes: { record: ConnectNodeRecord; link: NodeLink }[], deps: RuntimeDeps) => Runtime;

/** What T4's routes need from T1: look a token up without using it. */
export interface EnrollmentLookup {
  /** The enrollment behind a token, or null when no such token exists. `usable` is false once expired, revoked or used up. */
  lookup(token: string): { enrollment: ConnectEnrollment; target: ConnectTargetRecord; options: ConnectInstallOptions; usable: boolean } | null;
  /** `enroll/status` for a token still inside its grace: waiting, enrolled, connected, expired or revoked. */
  status(token: string): ConnectEnrollStatus | null;
}

/** What `createInstallRoutes(deps)` (T4) is given. The bundle comes from T2's generated file. */
export interface InstallDeps {
  enrollments: EnrollmentLookup;
  bundle: { build: string; sha256: string; version: string; source: string };
  config: { baseImage: string; workspaceImage: string; caPem: string | null; allowHttp: boolean };
  /** The workspace image's build context (Dockerfile and cp-session) as a tar.gz stream, for PILOT_BUILD_IMAGE=1. */
  workspaceContext(): NodeJS.ReadableStream;
  log(line: string): void;
}

export interface ConnectModuleApi {
  useRuntimeFactory(f: RuntimeFactory): void;
  /** Adds, replaces and removes the enrolled targets' runtimes on the manager as the registry changes. */
  bind(workspaces: {
    addRuntime(r: Runtime): void; replaceRuntime(r: Runtime): void; removeRuntime(targetId: string): void;
    hooks: { beforeCreate?: (target: string, node?: string) => void };
  }): void;
  /** Resolves when every enrolled target has had a first connection, or after `ms`. */
  settled(ms: number): Promise<void>;
  /** For the manager's create: throws LIMIT_REACHED / CONFLICT when the quota or a drain says no. */
  canCreate(targetId: string, node?: string): void;
  /** Called with a target id when any of its nodes connects. */
  onReturned(fn: (targetId: string) => void): () => void;
  nodeViews(targetId: string): ConnectNodeView[];
}
