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

/**
 * One place workspaces run. The runtime is the record: list() reads what exists from it, so the
 * portal keeps no state of its own and survives restarts.
 */
export interface Runtime {
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
}
