import type { MultiPoolType } from './kinds.js';

/** What a workspace's assigned Secrets & env sets provide under one entry name (Secrets & env FR21). */
export interface SecretName {
  /** The entry's kind: 'variable', 'secret', or a tool login such as 'github' or 'npm'. */
  kind: string;
  /**
   * A file at `/etc/claudepilot/secrets/files/<name>` holds its value, so `{{secret-file:NAME}}` resolves:
   * secrets, and the token-only file of a single-token tool login.
   */
  file: boolean;
  /** Its value is in the Secrets & env drop-in's `env`, so `${NAME}` resolves: variables, and exposed secrets. */
  variable: boolean;
}

/** Implemented by Secrets & env. */
export interface SecretNameSource {
  /** Every entry name the workspace's assigned sets provide, at the revisions the workspace gets. */
  namesFor(workspaceId: string): Map<string, SecretName>;
}

/** A pool that uses Secrets & env names. */
export interface ReferencingPool {
  type: MultiPoolType;
  poolId: string;
  poolName: string;
}

/** Implemented by each pool type that references Secrets & env entries by name (MCP sets, for one). */
export interface ReferenceSource {
  type: MultiPoolType;
  /** Pools of this type whose newest or deliverable revisions reference `name` (Secrets & env FR19, FR23). */
  referencing(name: string): { poolId: string; poolName: string }[];
  /** Names this type's pools assigned to the workspace reference (for the unassign warning, FR23). */
  namesUsedBy(workspaceId: string): Map<string, { poolId: string; poolName: string }[]>;
}

/**
 * Cross-pool references (Secrets & env FR21–FR23), so pool modules never import each other. Pools that
 * use entries by name resolve them here against the same workspace's sets (FR22); Secrets & env asks
 * here who uses a name before an entry is renamed or removed, or a set is deleted or unassigned. One
 * instance, made in index.ts and handed to every pool kind that takes part.
 */
export class References {
  #secrets: SecretNameSource | null = null;
  readonly #sources: ReferenceSource[] = [];

  /** Secrets & env registers itself as the place names resolve. */
  provideSecretNames(source: SecretNameSource): void {
    this.#secrets = source;
  }

  /** The names a workspace's sets provide; empty when Secrets & env isn't registered (nothing resolves). */
  secretNamesFor(workspaceId: string): Map<string, SecretName> {
    return this.#secrets?.namesFor(workspaceId) ?? new Map();
  }

  /** A pool type that references names registers itself here. */
  addSource(source: ReferenceSource): void {
    this.#sources.push(source);
  }

  /** Every pool, of any type, that references `name`. */
  referencing(name: string): ReferencingPool[] {
    return this.#sources.flatMap((s) => s.referencing(name).map((p) => ({ type: s.type, ...p })));
  }

  /** The names pools assigned to `workspaceId` reference, with the pools that use each. */
  namesUsedBy(workspaceId: string): Map<string, ReferencingPool[]> {
    const out = new Map<string, ReferencingPool[]>();
    for (const s of this.#sources)
      for (const [name, pools] of s.namesUsedBy(workspaceId)) out.set(name, [...(out.get(name) ?? []), ...pools.map((p) => ({ type: s.type, ...p }))]);
    return out;
  }
}
