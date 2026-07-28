import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getCognitoConfig } from '../lib/config';
import { setAuthTokenGetter } from '../lib/api';

// Real Amazon Cognito integration — SPA-direct over the public HTTPS APIs
// (SignUp / ConfirmSignUp / InitiateAuth via SRP), per ADR 0005 and PRD
// user/0001 §3.4. No hosted UI, no redirect URIs: the login/register/confirm
// screens are hand-built and call amazon-cognito-identity-js directly.
//
// Tokens are persisted in localStorage by the library's default storage —
// an accepted, documented choice (PRD user/0001 §9.1), not an accident.

export interface AuthUser {
  /** The Cognito `sub` claim — the id every backend service verifies calls against. */
  id: string;
  email: string;
}

export interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
  /**
   * False when config.json ships no pool/client id (Cognito not deployed
   * yet, or running against a stripped-down local config). Auth screens must
   * render a graceful "authentication is not configured yet" message rather
   * than crash — PRD user/0001 §4.6.
   */
  authConfigured: boolean;
  /** True once the initial session-restore check (on mount) has settled. */
  initializing: boolean;
  register: (email: string, password: string) => Promise<void>;
  confirm: (email: string, code: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /**
   * Resolves the current session's ID token, refreshing via the refresh
   * token when the cached one has expired. Resolves null when signed out or
   * when auth isn't configured.
   */
  getIdToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

function userFromSession(session: CognitoUserSession): AuthUser {
  const payload = session.getIdToken().payload as Record<string, unknown>;
  return {
    id: typeof payload.sub === 'string' ? payload.sub : '',
    email: typeof payload.email === 'string' ? payload.email : '',
  };
}

/** Cognito error shape (amazon-cognito-identity-js callbacks pass a plain Error with `.message`). */
function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong. Please try again.';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { userPoolId, clientId } = getCognitoConfig();
  const authConfigured = Boolean(userPoolId && clientId);

  const poolRef = useRef<CognitoUserPool | null>(
    authConfigured ? new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId }) : null,
  );

  const [user, setUser] = useState<AuthUser | null>(null);
  const [initializing, setInitializing] = useState(authConfigured);

  const getIdToken = useCallback((): Promise<string | null> => {
    const pool = poolRef.current;
    const cognitoUser = pool?.getCurrentUser();
    if (!pool || !cognitoUser) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      // getSession() transparently refreshes an expired ID/access token
      // using the stored refresh token — this is the "current session"
      // resolver every apiFetch call goes through.
      cognitoUser.getSession((err: Error | null, session: CognitoUserSession | null) => {
        if (err || !session || !session.isValid()) {
          resolve(null);
          return;
        }
        resolve(session.getIdToken().getJwtToken());
      });
    });
  }, []);

  // Register the token getter with the hook-free api.ts module once, so
  // apiFetch can attach the Authorization header without depending on React.
  useEffect(() => {
    setAuthTokenGetter(getIdToken);
  }, [getIdToken]);

  // Restore an existing session on load (e.g. a page reload) so the user
  // stays signed in without re-entering credentials.
  useEffect(() => {
    const pool = poolRef.current;
    const cognitoUser = pool?.getCurrentUser();
    if (!pool || !cognitoUser) {
      setInitializing(false);
      return;
    }
    cognitoUser.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (!err && session && session.isValid()) {
        setUser(userFromSession(session));
      }
      setInitializing(false);
    });
  }, []);

  const register = useCallback(
    (email: string, password: string): Promise<void> => {
      const pool = poolRef.current;
      if (!pool) {
        return Promise.reject(new Error('Authentication is not configured yet.'));
      }
      const attributeList = [new CognitoUserAttribute({ Name: 'email', Value: email })];
      return new Promise((resolve, reject) => {
        pool.signUp(email, password, attributeList, [], (err) => {
          if (err) {
            reject(new Error(errorMessage(err)));
            return;
          }
          resolve();
        });
      });
    },
    [],
  );

  const confirm = useCallback(
    (email: string, code: string): Promise<void> => {
      const pool = poolRef.current;
      if (!pool) {
        return Promise.reject(new Error('Authentication is not configured yet.'));
      }
      const cognitoUser = new CognitoUser({ Username: email, Pool: pool });
      return new Promise((resolve, reject) => {
        cognitoUser.confirmRegistration(code, true, (err) => {
          if (err) {
            reject(new Error(errorMessage(err)));
            return;
          }
          resolve();
        });
      });
    },
    [],
  );

  const login = useCallback(
    (email: string, password: string): Promise<void> => {
      const pool = poolRef.current;
      if (!pool) {
        return Promise.reject(new Error('Authentication is not configured yet.'));
      }
      const cognitoUser = new CognitoUser({ Username: email, Pool: pool });
      const authDetails = new AuthenticationDetails({ Username: email, Password: password });

      return new Promise((resolve, reject) => {
        cognitoUser.authenticateUser(authDetails, {
          onSuccess: (session) => {
            setUser(userFromSession(session));
            resolve();
          },
          onFailure: (err) => {
            reject(new Error(errorMessage(err)));
          },
          // The app client only allows SRP + refresh-token auth (no
          // ALLOW_ADMIN_USER_PASSWORD_AUTH / forced first-login flow is
          // expected for this design) — surface it as an error rather than
          // implementing a separate "set new password" screen.
          newPasswordRequired: () => {
            reject(new Error('A new password is required. Please contact support.'));
          },
        });
      });
    },
    [],
  );

  const logout = useCallback(() => {
    const pool = poolRef.current;
    pool?.getCurrentUser()?.signOut();
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      isAuthenticated: user !== null,
      user,
      authConfigured,
      initializing,
      register,
      confirm,
      login,
      logout,
      getIdToken,
    }),
    [user, authConfigured, initializing, register, confirm, login, logout, getIdToken],
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
