import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, onUnauthorized } from './api';

type AuthState = { status: 'loading' } | { status: 'out'; enabled: boolean } | { status: 'in' };

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
      setState({ status: 'out', enabled: true });
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
