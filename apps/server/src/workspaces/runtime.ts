import type { Workspace, WorkspaceTarget, WorkspaceUsage } from '@portal/contracts';

/** Labels (Docker) / labels and annotations (Kubernetes) that mark what the portal owns. */
export const LABEL = {
  managed: 'claudepilot.managed',
  name: 'claudepilot.workspace',
  /** The id of the portal that created the workspace: portals sharing one daemon never touch each other's workspaces. */
  portal: 'claudepilot.portal',
} as const;

/**
 * Whether a workspace's labels say another portal created it. Workspaces from before the label existed carry
 * none and stay adoptable; a portal that doesn't know its own id (a frozen store) can't tell, so it says no.
 */
export function createdByAnotherPortal(labels: Record<string, string> | null | undefined, mine: string | null): boolean {
  return foreignPortal(labels?.[LABEL.portal], mine);
}

/** The same, for a portal id already read from the label. */
export function foreignPortal(theirs: string | null | undefined, mine: string | null): boolean {
  return !!theirs && !!mine && theirs !== mine;
}

export const HOME = '/home/node';

export interface CreateSpec {
  name: string;
  cpus?: number;
  memoryMb?: number;
  /** The exact Claude Code version to pin the workspace to (x.y.z); the target's default image when absent (claude-version-pinning PRD). */
  claudeVersion?: string;
  /** An enrolled cluster's node to place it on (targets-connect PRD §12.4); the runtime picks when absent. */
  node?: string;
}

/**
 * What a call to an enrolled target fails with while its tunnel is down (targets-connect PRD §12.5): an outage, not a state change.
 * The manager answers it with 503 "Target unreachable (since 14:02)"; delivery keeps the workspace `pending`; chat readers wait.
 */
export class TargetUnreachableError extends Error {
  readonly code = 'TARGET_UNREACHABLE';
  constructor(
    readonly target: string,
    /** ISO time the target was last reachable; null when it never was since the portal started. */
    readonly since: string | null,
  ) {
    super(`Target unreachable${since ? ` (since ${new Date(since).toISOString().slice(11, 16)})` : ''}`);
    this.name = 'TargetUnreachableError';
  }
}

/** Whether an error says the target's tunnel is down (also across module copies: checked by name and code). */
export const isTargetUnreachable = (e: unknown): e is TargetUnreachableError =>
  e instanceof TargetUnreachableError || (!!e && typeof e === 'object' && (e as { code?: unknown }).code === 'TARGET_UNREACHABLE');

/** A terminal running inside a workspace. */
export interface ShellSession {
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  close(): void;
  onData(fn: (data: Buffer) => void): void;
  /** Fires once, when the shell ends (exit code when known). */
  onExit(fn: (code: number | null) => void): void;
}

/** A command running in a workspace without a terminal (stdout and stderr merged). */
export interface ExecSession {
  write(data: string): void;
  /** Drops the connection; the process itself may keep running. */
  close(): void;
  onData(fn: (data: Buffer) => void): void;
  /** Fires once, when the command ends (exit code when known). */
  onExit(fn: (code: number | null) => void): void;
}

export interface TarEntry {
  /** Absolute path in the workspace. */
  path: string;
  type: 'file' | 'directory';
  content?: string;
  /** Additive: a binary file's bytes, written instead of `content`. */
  bytes?: Buffer;
  mode: number;
  uid: number;
  gid: number;
}

/**
 * What the delivery engine needs from a runtime (foundation PRD §6.2). Secrets only ever travel in
 * `put` archives and `run` stdin, never in a command line.
 */
export interface DeliveryAccess {
  /** `portal`: the id of the portal that created it, null when it carries none (made before the label existed). */
  state(name: string): Promise<{ exists: boolean; running: boolean; portal?: string | null }>;
  /** Runs `sh -c script` in a running workspace. */
  run(name: string, script: string, opts?: { user?: 'root' | 'node'; stdin?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Writes files and folders (with owner and mode) into a running or stopped workspace. */
  put(name: string, entries: TarEntry[]): Promise<void>;
  /** Reads one file from a running or stopped workspace; null when it doesn't exist. */
  read(name: string, path: string): Promise<string | null>;
  /** Calls `onStart` whenever a workspace starts, from inside or outside the portal. Returns a stop function. */
  watchStarts(onStart: (name: string) => void): () => void;
}

/** An image of the workspace as a target holds it (claude-version-pinning PRD). */
export interface ImageInfo {
  /** `claudepilot-workspace:cc-2.1.296`. */
  ref: string;
  /** The image's id on its daemon. */
  id: string;
  /** The exact Claude Code version its `claudepilot.claude-version` label says; null when it carries none. */
  version: string | null;
  builtAt: string | null;
  sizeBytes: number | null;
}

/** What a runtime offers for the workspace image, one tag per exact Claude Code version. Optional: This machine has none. */
export interface ImageAccess {
  /** The reference a workspace pinned to `version` is made from on this target. */
  refFor(version: string): string;
  /** The reference new workspaces get when no version is asked for. */
  readonly defaultRef: string;
  inspect(ref: string): Promise<ImageInfo | null>;
  /** Builds (Docker) or pulls the image of an exact version when it is missing; resolves with its reference. Long. */
  ensure(version: string, progress: (detail: string) => void): Promise<string>;
  /** The images of this portal's repository, one per tag. */
  list(): Promise<ImageInfo[]>;
  /** Removes a tag; refused by the daemon while a container uses it. */
  remove(ref: string): Promise<void>;
}

/** A container of the portal's own that is not a workspace: no managed label, no home volume, removed by whoever asked for it. */
export interface Throwaway {
  /** What `run`, `put`, `read` and `remove` take. */
  name: string;
}

/** Throwaway containers for the compatibility canary (claude-version-pinning PRD §11): never listed as workspaces. */
export interface ThrowawayAccess {
  /** `network: 'none'` for a canary of an image; `bridge` only while a candidate Claude Code is installed beside the image's. */
  start(spec: { image: string; network: 'none' | 'bridge'; cpus?: number; memoryMb?: number }): Promise<Throwaway>;
  run: DeliveryAccess['run'];
  put: DeliveryAccess['put'];
  read: DeliveryAccess['read'];
  /** A command with stdin open and no terminal, as the workspace user, in `cwd` (the home folder when absent), with exactly these extra variables. */
  exec(name: string, command: string[], opts?: { env?: Record<string, string>; cwd?: string }): Promise<ExecSession>;
  /** A terminal in the container as the workspace user: `claude mcp login` reads the pasted address from a terminal, not from a pipe. */
  shell(name: string, size: { cols: number; rows: number }, command: string[], opts?: { env?: Record<string, string> }): Promise<ShellSession>;
  /** Cuts the container off from every network (after a candidate Claude Code was installed): the checks run with none. */
  isolate(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** The throwaway containers this portal started and never removed (a restart in the middle of a canary). */
  leftovers(): Promise<Throwaway[]>;
}

/**
 * One place workspaces run. The runtime is the record: list() reads what exists from it, so the
 * portal keeps no state of its own and survives restarts.
 */
export interface Runtime {
  /** Present when the delivery engine can write into this runtime's workspaces. */
  readonly delivery?: DeliveryAccess;
  readonly target: Omit<WorkspaceTarget, 'available' | 'problem'>;
  /** Throws when the target can't be used right now. */
  check(): Promise<void>;
  list(): Promise<Workspace[]>;
  /** Long: may build or pull the image. `progress` reports what it's doing. */
  create(spec: CreateSpec, progress: (detail: string) => void): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  /** Removes the workspace and its home volume. */
  remove(name: string): Promise<void>;
  usage(names: string[]): Promise<Omit<WorkspaceUsage, 'id'>[]>;
  /** A terminal running `command` (a login shell when absent), as the workspace user. */
  shell(name: string, size: { cols: number; rows: number }, command?: string[]): Promise<ShellSession>;
  /** Runs `command` as the workspace user, with stdin open, no terminal. */
  exec(name: string, command: string[]): Promise<ExecSession>;
  /** Calls `onChange` when a workspace changes outside the portal's own calls, when the runtime can tell. */
  watch?(onChange: () => void): () => void;
  /** Image per exact Claude Code version (claude-version-pinning PRD). */
  readonly images?: ImageAccess;
  /** Throwaway containers for the compatibility canary. */
  readonly throwaway?: ThrowawayAccess;
  /**
   * Replaces the workspace's container with one made from `image`, KEEPING its home volume (everything outside the home folder, and every
   * running process, is not kept). A container that cannot be made or started is put back from the old image and the call fails.
   * `progress` says the step. Resolves with the image it was on and the one it is on.
   */
  recreate?(name: string, image: string, progress: (detail: string) => void): Promise<{ from: string | null; to: string }>;
  /** The image a workspace's container was made from and the Claude Code version that image says; null when the workspace is not there. */
  imageOf?(name: string): Promise<{ ref: string | null; version: string | null; id: string | null } | null>;
  /** Where a workspace on this target reaches the portal (an enrolled target's portal address); internalUrl derives it when absent. */
  readonly portalUrl?: string;
  /**
   * An enrolled target's last good list (targets-connect PRD §12.5), served by the manager while `check()` fails: each workspace
   * `unreachable` with `lastSeenAt`. Absent on scanned targets (they are skipped while down, as before).
   */
  listLastKnown?(): Workspace[];
  /** An enrolled target: whether the workspace's node is connected right now (sync, no call). Absent: always reachable. */
  reachable?(name: string): boolean;
}
