import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError, type User } from './client.js';

/** Who is signed in, and whether first-run setup is still required. */
interface AuthState {
  loading: boolean;
  user: User | undefined;
  setupRequired: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | undefined>();
  const [setupRequired, setSetupRequired] = useState(false);

  const refresh = useCallback(async () => {
    const status = await api<{ setupRequired: boolean }>('GET', '/api/setup/status');
    setSetupRequired(status.setupRequired);
    try {
      setUser(await api<User>('GET', '/api/auth/me'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setUser(undefined);
      else throw err;
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const logout = useCallback(async () => {
    await api('POST', '/api/auth/logout');
    setUser(undefined);
  }, []);

  const value = useMemo(
    () => ({ loading, user, setupRequired, refresh, logout }),
    [loading, user, setupRequired, refresh, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
