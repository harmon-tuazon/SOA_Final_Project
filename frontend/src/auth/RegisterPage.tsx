import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { NotConfiguredNotice } from './NotConfiguredNotice';

// Custom registration screen — SPA-direct SignUp against Cognito (ADR 0005).
// On success, navigate to the confirm-code step; the SPA carries the email
// forward via the confirm page's query string so the user doesn't retype it.

export function RegisterPage() {
  const { authConfigured, register } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!authConfigured) {
    return (
      <section>
        <h1>Register</h1>
        <NotConfiguredNotice />
      </section>
    );
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsPending(true);
    register(email, password)
      .then(() => {
        navigate(`/confirm?email=${encodeURIComponent(email)}`);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not register.');
      })
      .finally(() => {
        setIsPending(false);
      });
  }

  return (
    <section>
      <h1>Register</h1>
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
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label>
          Confirm password
          <input
            type="password"
            required
            minLength={8}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <button type="submit" disabled={isPending}>
          {isPending ? 'Registering…' : 'Register'}
        </button>
        {error && (
          <p role="status">
            <strong>Could not register.</strong> {error}
          </p>
        )}
      </form>
      <p>
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </section>
  );
}
