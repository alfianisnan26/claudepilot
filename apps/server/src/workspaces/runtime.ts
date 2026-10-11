import type { Workspace, WorkspaceTarget, WorkspaceUsage } from '@portal/contracts';

/** Labels (Docker) / labels and annotations (Kubernetes) that mark what the portal owns. */
export const LABEL = {
  managed: 'claudepilot.managed',
  name: 'claudepilot.workspace',
} as const;

export const HOME = '/home/node';

export interface CreateSpec {
  name: string;
  cpus?: number;
  memoryMb?: number;
}

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
  state(name: string): Promise<{ exists: boolean; running: boolean }>;
  /** Runs `sh -c script` in a running workspace. */
  run(name: string, script: string, opts?: { user?: 'root' | 'node'; stdin?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Writes files and folders (with owner and mode) into a running or stopped workspace. */
  put(name: string, entries: TarEntry[]): Promise<void>;
  /** Reads one file from a running or stopped workspace; null when it doesn't exist. */
  read(name: string, path: string): Promise<string | null>;
  /** Calls `onStart` whenever a workspace starts, from inside or outside the portal. Returns a stop function. */
  watchStarts(onStart: (name: string) => void): () => void;
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
  shell(name: string, size: { cols: number; rows: number }): Promise<ShellSession>;
  /** Runs `command` as the workspace user, with stdin open, no terminal. */
  exec(name: string, command: string[]): Promise<ExecSession>;
  /** Calls `onChange` when a workspace changes outside the portal's own calls, when the runtime can tell. */
  watch?(onChange: () => void): () => void;
}
