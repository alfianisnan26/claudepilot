import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { removeThisBrowserRegistration } from '@/features/notify/deviceId';
import { resetNotifyStore } from '@/features/notify/store';
import { resetAttention } from '@/features/attention/store';
import { api, onUnauthorized } from './api';
import { resetMe } from './me';
import { authStateOf, type AuthState } from './authState';

export { authStateOf, isAdminState, type AuthState } from './authState';

interface AuthContextValue {
  state: AuthState;
  login: (code: string) => Promise<void>;
  /** T-118: sign in with an email account. */
  loginEmail: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const s = await api.session();
      setState(authStateOf(s));
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
    resetMe();
    // The server code is the platform's own sign-in: always the admin's app.
    setState({ status: 'in', admin: true });
  }, []);

  const loginEmail = useCallback(async (email: string, password: string) => {
    await api.loginEmail(email, password);
    resetMe();
    // A member account gets the member's app (D-82 S1a): the server says which.
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    // This browser's push registration goes first, while the session can still remove it (PWA PRD 11.4).
    await removeThisBrowserRegistration();
    resetNotifyStore();
    resetAttention();
    await api.logout().catch(() => undefined);
    // The next person's account menu never shows this one's name.
    resetMe();
    await refresh();
  }, [refresh]);

  const value = useMemo(() => ({ state, login, loginEmail, logout, refresh }), [state, login, loginEmail, logout, refresh]);
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
