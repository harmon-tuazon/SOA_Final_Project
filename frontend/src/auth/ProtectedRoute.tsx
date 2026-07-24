import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

/**
 * Gates a route behind a real Cognito session (PRD user/0001 §3.4). When
 * auth isn't configured yet (no pool/client id in config.json) it degrades
 * gracefully instead of crashing or looping into a login screen that can
 * never succeed.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, authConfigured, initializing } = useAuth();

  if (!authConfigured) {
    return (
      <p role="status">
        Authentication is not configured yet — sign-in is unavailable until the Cognito user pool
        is deployed.
      </p>
    );
  }

  if (initializing) {
    return <p>Checking your session…</p>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
