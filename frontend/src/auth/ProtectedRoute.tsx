import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';

// TODO(cognito): currently always-allow (the stub AuthProvider reports
// isAuthenticated: true). Once real Cognito auth lands, this should redirect
// unauthenticated users to the hosted UI / login route instead of rendering
// children through.

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    // TODO(cognito): redirect to a real login route instead of this fallback.
    return <p>You must be logged in to view this page.</p>;
  }

  return <>{children}</>;
}
