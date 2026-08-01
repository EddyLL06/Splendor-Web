import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import i18n from './i18n.js';

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  avatarUrl: string;
  hasCustomAvatar: boolean;
}

interface SessionResponse {
  user: AuthUser | null;
  csrfToken: string | null;
  sessionExpiresAt: string | null;
}

export class ClientApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

const parseErrorCode = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === 'string' ? body.error.code : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
};

const rawRequest = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: 'include' });
  } catch {
    throw new ClientApiError('NETWORK_ERROR', 0);
  }
  if (!response.ok) {
    throw new ClientApiError(await parseErrorCode(response), response.status);
  }
  return (await response.json()) as T;
};

export const localizedError = (caught: unknown): string => {
  const lobbyDetails = (caught as { details?: { error?: { code?: unknown } } } | null)?.details;
  const code = caught instanceof ClientApiError
    ? caught.code
    : typeof lobbyDetails?.error?.code === 'string'
      ? lobbyDetails.error.code
      : 'UNKNOWN';
  const key = `errors.${code}`;
  return i18n.exists(key) ? i18n.t(key) : i18n.t('errors.UNKNOWN');
};

interface AuthContextValue {
  user: AuthUser | null;
  csrfToken: string | null;
  loading: boolean;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  adoptSession: (session: SessionResponse) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: AuthUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionResponse>({
    user: null,
    csrfToken: null,
    sessionExpiresAt: null,
  });
  const [loading, setLoading] = useState(true);

  const adoptSession = useCallback((next: SessionResponse) => {
    setSession(next);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    const next = await rawRequest<SessionResponse>('/api/auth/me');
    adoptSession(next);
  }, [adoptSession]);

  useEffect(() => {
    window.localStorage.removeItem('gem-council-display-name');
    void refresh().catch(() => setLoading(false));
    const onFocus = () => void refresh().catch(() => undefined);
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(onFocus, 60_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const request = useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const headers = new Headers(init.headers);
      if (session.csrfToken && init.method && init.method !== 'GET') {
        headers.set('X-CSRF-Token', session.csrfToken);
      }
      try {
        return await rawRequest<T>(path, { ...init, headers });
      } catch (caught) {
        if (caught instanceof ClientApiError && caught.status === 401) {
          setSession({ user: null, csrfToken: null, sessionExpiresAt: null });
        }
        throw caught;
      }
    },
    [session.csrfToken],
  );

  const logout = useCallback(async () => {
    await request<{ ok: true }>('/api/auth/logout', { method: 'POST' });
    setSession({ user: null, csrfToken: null, sessionExpiresAt: null });
  }, [request]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session.user,
      csrfToken: session.csrfToken,
      loading,
      request,
      adoptSession,
      refresh,
      logout,
      setUser: (user) => setSession((current) => ({ ...current, user })),
    }),
    [adoptSession, loading, logout, refresh, request, session.csrfToken, session.user],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = (): AuthContextValue => {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider is missing.');
  return value;
};

export const jsonRequest = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
