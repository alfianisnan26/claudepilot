import type { PersonaIdentity, PersonaPoolInfo } from '@portal/contracts';
import { useEffect, useSyncExternalStore } from 'react';
import { useLive } from '@/lib/live';
import { personasApi } from './api';

/**
 * One request however many rows ask: a tiny shared store per resource. Every component that uses it reads the same
 * value, the first to mount loads it, and a change to pools (the live topic) loads it again once for all of them.
 */
function sharedResource<T>(fetch: () => Promise<T>) {
  let value: T | null = null;
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const refresh = () => {
    inFlight ??= fetch()
      .then((next) => {
        value = next;
        listeners.forEach((l) => l());
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  return function useResource(): T | null {
    const current = useSyncExternalStore(
      (l) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      () => value,
    );
    useEffect(() => void refresh(), []);
    useLive('pools', () => void refresh());
    return current;
  };
}

/**
 * Every workspace's persona name and avatar (interface I11), for rows and headers that show who a session is.
 * `null` while loading or when it failed; a workspace with no persona is simply missing from the map.
 */
export const usePersonaIdentities = sharedResource<Record<string, PersonaIdentity>>(() => personasApi.identities());

/** The persona of one workspace, or null (none, or not loaded yet). */
export function usePersonaOf(workspaceId: string | null | undefined): PersonaIdentity | null {
  const all = usePersonaIdentities();
  return (workspaceId && all?.[workspaceId]) || null;
}

/** Each persona's avatar, default flag and waiting proposals by pool (cards, pickers). */
export const usePersonaPoolInfo = sharedResource<Record<string, PersonaPoolInfo>>(async () => Object.fromEntries((await personasApi.pools()).map((p) => [p.poolId, p])));
