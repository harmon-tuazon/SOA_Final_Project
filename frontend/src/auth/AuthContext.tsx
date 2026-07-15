import { createContext, useContext, useMemo, type ReactNode } from 'react';

// TODO(cognito): this is a stub auth seam. Replace the mock user/session
// below with a real Amazon Cognito integration (hosted UI or Amplify Auth)
// once the frontend HTTPS PRD lands (Cognito requires HTTPS redirect URIs).
// Everything that consumes useAuth() should keep working unchanged — only
// this file's internals need to change.

export interface AuthUser {
  id: string;
  name: string;
}

export interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
  /** No-op placeholders until Cognito is wired in. */
  login: () => void;
  logout: () => void;
}

const MOCK_USER: AuthUser = { id: 'demo-user', name: 'Demo User' };

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  // TODO(cognito): replace with real session state (tokens, user attributes)
  // sourced from Cognito, and real login()/logout() that redirect to the
  // hosted UI.
  const value = useMemo<AuthState>(
    () => ({
      isAuthenticated: true,
      user: MOCK_USER,
      login: () => {
        console.warn('[auth] login() is a stub — Cognito not wired in yet');
      },
      logout: () => {
        console.warn('[auth] logout() is a stub — Cognito not wired in yet');
      },
    }),
    [],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth() must be used within an <AuthProvider>');
  }
  return ctx;
}
