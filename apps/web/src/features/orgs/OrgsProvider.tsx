import { FOUNDING_USER_ID, type Ability, type Org } from '@portal/contracts';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api } from '@/lib/api';
import {
  browserStorage,
  currentContext,
  readContext,
  resolveContext,
  setCurrentContext,
  subscribeContext,
  writeContext,
  type AppContext,
} from '@/lib/orgContext';

interface OrgsValue {
  /** null while loading. */
  orgs: Org[] | null;
  abilities: Ability[] | null;
  context: AppContext;
  /** The org of the current context, when it is one. */
  currentOrg: Org | null;
  setContext: (ctx: AppContext) => void;
  reload: () => Promise<void>;
}

const OrgsContext = createContext<OrgsValue | null>(null);

/** The orgs the person is in, what they may do, and the context of this device (lib/orgContext). Once, around the signed-in shell. */
export function OrgsProvider({ children }: { children: ReactNode }) {
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [abilities, setAbilities] = useState<Ability[] | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const context = useSyncExternalStore(subscribeContext, currentContext, currentContext);

  const reload = useCallback(async () => {
    const [me, mine, ab] = await Promise.all([
      api.me().catch(() => null),
      api.orgs.mine().catch(() => [] as Org[]),
      api.orgs.abilities().catch(() => ({ abilities: [] as Ability[] })),
    ]);
    // A server-code sign-in is the founding user (its storage key is that id).
    const id = me?.kind === 'account' ? me.user.id : FOUNDING_USER_ID;
    setUserId(id);
    setOrgs(mine);
    setAbilities(ab.abilities);
    const resolved = resolveContext(readContext(browserStorage(), id), mine.map((o) => o.id));
    // A stored org the person left is forgotten, so the next load starts Personal too.
    writeContext(browserStorage(), id, resolved);
    setCurrentContext(resolved);
  }, []);

  useEffect(() => void reload(), [reload]);

  const setContext = useCallback(
    (ctx: AppContext) => {
      if (userId) writeContext(browserStorage(), userId, ctx);
      setCurrentContext(ctx);
    },
    [userId],
  );

  const value = useMemo<OrgsValue>(() => {
    const currentOrg = context.kind === 'org' ? (orgs?.find((o) => o.id === context.id) ?? null) : null;
    return { orgs, abilities, context, currentOrg, setContext, reload };
  }, [orgs, abilities, context, setContext, reload]);
  return <OrgsContext value={value}>{children}</OrgsContext>;
}

export function useOrgs(): OrgsValue {
  const v = useContext(OrgsContext);
  if (!v) throw new Error('useOrgs must be used inside <OrgsProvider>');
  return v;
}

/** The context alone, for a component outside the provider's concerns (a page keyed on it). */
export const useAppContext = () => useSyncExternalStore(subscribeContext, currentContext, currentContext);
