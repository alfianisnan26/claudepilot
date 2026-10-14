import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { removeThisBrowserRegistration } from '@/features/notify/deviceId';
import { resetNotifyStore } from '@/features/notify/store';
import { resetAttention } from '@/features/attention/store';
import { api, onUnauthorized } from './api';

/** `unreachable`: the server didn't answer, which says nothing about whether you are signed in. */
type AuthState = { status: 'loading' } | { status: 'out'; enabled: boolean } | { status: 'in' } | { status: 'unreachable' };

interface AuthContextValue {
  state: AuthState;
  login: (code: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const s = await api.session();
      setState(s.authenticated ? { status: 'in' } : { status: 'out', enabled: s.enabled });
    } catch {
      // Not "signed out": the server may be restarting or the network gone. Keep what we knew, or wait and retry.
      setState((prev) => (prev.status === 'in' ? prev : { status: 'unreachable' }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Signed out elsewhere (code rotated, session expired): back to the login page.
    return onUnauthorized(() => void refresh());
  }, [refresh]);

  const login = useCallback(async (code: string) => {
    await api.login(code);
    setState({ status: 'in' });
  }, []);

  const logout = useCallback(async () => {
    // This browser's push registration goes first, while the session can still remove it (PWA PRD 11.4).
    await removeThisBrowserRegistration();
    resetNotifyStore();
    resetAttention();
    await api.logout().catch(() => undefined);
    await refresh();
  }, [refresh]);

  const value = useMemo(() => ({ state, login, logout, refresh }), [state, login, logout, refresh]);
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
