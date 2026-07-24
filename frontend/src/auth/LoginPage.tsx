import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { NotConfiguredNotice } from './NotConfiguredNotice';

// Custom login screen — SPA-direct InitiateAuth (SRP) against Cognito, no
// hosted UI (ADR 0005). On success, navigate to the profile page.

export function LoginPage() {
  const { authConfigured, login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!authConfigured) {
    return (
      <section>
        <h1>Sign in</h1>
        <NotConfiguredNotice />
      </section>
    );
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsPending(true);
    login(email, password)
      .then(() => {
        navigate('/profile');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not sign in.');
      })
      .finally(() => {
        setIsPending(false);
      });
  }

  return (
    <section>
      <h1>Sign in</h1>
      <form onSubmit={handleSubmit}>
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button type="submit" disabled={isPending}>
          {isPending ? 'Signing in…' : 'Sign in'}
        </button>
        {error && (
          <p role="status">
            <strong>Could not sign in.</strong> {error}
          </p>
        )}
      </form>
      <p>
        Don&rsquo;t have an account? <Link to="/register">Register</Link>
      </p>
    </section>
  );
}
