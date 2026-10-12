// Where a GitHub token lives (docs/prd/codespaces-poc.md §9): a normal sealed secret in a Secrets & env set, nothing of its own. The
// manual path and the device flow both end here; a connection only remembers the set and the entry name. Values are sealed by the
// Secrets store (secret_values, AES-GCM under the portal key, bound to their row); this file opens one only for the call that needs it.
//
// The set is an ordinary set: it shows in Secrets & env, rotates and is versioned like any other, and could be assigned to a workspace.
// Assigning it would deliver a token that can create codespaces into that workspace, so the set's description says what it is for.

import { AppError } from '@isnanme/core';
import type { SecretsContent } from '@portal/contracts';
import type { PoolService } from '../pools/service.js';
import type { SecretValues } from '../secrets/values.js';

export const TOKEN_ENTRY = 'GITHUB_CODESPACES_TOKEN';
const VALUE_FIELD = 'value';

export interface StoredToken {
  poolId: string;
  poolName: string;
  entryId: string;
  entryName: string;
  hint: string | null;
}

export interface TokenVault {
  /** Seals a token into a new set (or a new version of the same entry in `into`), and says where it went. */
  put(token: string, opts: { login: string; into?: { poolId: string; entryName: string } | null }): StoredToken;
  /** Where an existing entry is, or null when the set or the entry is gone. */
  locate(poolId: string, entryName: string): StoredToken | null;
  /** The entry's newest stored, unrevoked value; null when there is none. The caller uses it for one call and drops it. */
  open(poolId: string, entryName: string): string | null;
  /** Deletes a set the portal made (refused while a workspace has it). */
  remove(poolId: string): void;
}

export function secretsVault(pools: Pick<PoolService, 'create' | 'update' | 'get' | 'delete' | 'list'>, values: Pick<SecretValues, 'newest' | 'open'>): TokenVault {
  const entries = (poolId: string) => {
    const d = pools.get(poolId);
    if (d.type !== 'secrets') throw new AppError('VALIDATION_FAILED', 'That is not a secret set.');
    return { name: d.name, entries: (d.content as SecretsContent).entries };
  };
  const locate = (poolId: string, entryName: string): StoredToken | null => {
    let found: ReturnType<typeof entries>;
    try {
      found = entries(poolId);
    } catch (e) {
      if (e instanceof AppError && e.code === 'NOT_FOUND') return null;
      throw e;
    }
    const e = found.entries.find((x) => x.kind === 'secret' && x.name === entryName);
    return e ? { poolId, poolName: found.name, entryId: e.id, entryName, hint: e.secret?.hint ?? null } : null;
  };
  return {
    put(token, { login, into }) {
      if (into) {
        const d = pools.get(into.poolId);
        const list = (d.content as SecretsContent).entries.map((e) => ({ ...e }));
        const at = list.find((e) => e.kind === 'secret' && e.name === into.entryName);
        if (at) Object.assign(at, { newValue: token });
        else list.push({ kind: 'secret', name: into.entryName, newValue: token } as never);
        pools.update(into.poolId, { content: { entries: list }, note: 'GitHub token for Codespaces' });
        return locate(into.poolId, into.entryName)!;
      }
      const taken = new Set(pools.list('secrets').map((p) => p.name.toLowerCase()));
      const base = `GitHub ${login}`.slice(0, 60);
      let name = base;
      for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} (${i})`;
      const p = pools.create('secrets', {
        name,
        description: 'GitHub token for Codespaces (made by the portal). It can create and delete codespaces: assign it to a workspace only on purpose.',
        content: { entries: [{ kind: 'secret', name: TOKEN_ENTRY, newValue: token }] },
        note: 'GitHub token for Codespaces',
      });
      return locate(p.id, TOKEN_ENTRY)!;
    },
    locate,
    open(poolId, entryName) {
      const at = locate(poolId, entryName);
      if (!at) return null;
      const v = values.newest(poolId, at.entryId, VALUE_FIELD);
      if (!v || v.revokedAt || !v.stored) return null;
      return values.open(v.id);
    },
    remove(poolId) {
      pools.delete(poolId);
    },
  };
}
