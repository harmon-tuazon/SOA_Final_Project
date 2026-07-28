import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { NotConfiguredNotice } from './NotConfiguredNotice';

// Email-confirmation screen — ConfirmSignUp with the 6-digit code Cognito
// emails after registration (PRD user/0001 §3.4 step 2-3).

export function ConfirmPage() {
  const { authConfigured, confirm } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [email, setEmail] = useState(searchParams.get('email') ?? '');
  const [code, setCode] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!authConfigured) {
    return (
      <section>
        <h1>Confirm your email</h1>
        <NotConfiguredNotice />
      </section>
    );
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsPending(true);
    confirm(email, code)
      .then(() => {
        navigate('/login');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not confirm this code.');
      })
      .finally(() => {
        setIsPending(false);
      });
  }

  return (
    <section>
      <h1>Confirm your email</h1>
      <p>
        We emailed a 6-digit confirmation code to your address. Enter it below to activate your
        account. Didn&rsquo;t get it? Check your spam folder — Cognito&rsquo;s built-in sender can
        land there.
      </p>
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
          Confirmation code
          <input
            type="text"
            required
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
          />
        </label>
        <button type="submit" disabled={isPending}>
          {isPending ? 'Confirming…' : 'Confirm'}
        </button>
        {error && (
          <p role="status">
            <strong>Could not confirm this code.</strong> {error}
          </p>
        )}
      </form>
      <p>
        <Link to="/login">Back to sign in</Link>
      </p>
    </section>
  );
}
