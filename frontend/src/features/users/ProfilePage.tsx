import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMe, useUpdateMe } from './api';

// Profile page — email is read-only (Cognito owns it); displayName/phone are
// editable and saved via PUT /users/me. The service lazily creates the row
// from token claims on first GET, so a first-time visitor still sees a row.

export function ProfilePage() {
  const { data: profile, isLoading, isError, error } = useMe();
  const updateMe = useUpdateMe();

  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');

  // Seed the editable fields once the profile loads (or reloads after a save).
  useEffect(() => {
    if (profile) {
      setDisplayName(profile.displayName ?? '');
      setPhone(profile.phone ?? '');
    }
  }, [profile]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    updateMe.mutate({ displayName, phone });
  }

  if (isLoading) {
    return <p>Loading your profile…</p>;
  }

  if (isError) {
    return (
      <section>
        <h1>Your profile</h1>
        <div role="status">
          <strong>Backend unavailable.</strong>{' '}
          <span>{error instanceof Error ? error.message : 'Could not load your profile.'}</span>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h1>Your profile</h1>

      {profile && (
        <form onSubmit={handleSubmit}>
          <label>
            Email
            <input type="email" value={profile.email} readOnly disabled />
          </label>
          <label>
            Display name
            <input
              value={displayName}
              maxLength={100}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
          <label>
            Phone
            <input value={phone} maxLength={30} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <button type="submit" disabled={updateMe.isPending}>
            {updateMe.isPending ? 'Saving…' : 'Save'}
          </button>
          {updateMe.isError && (
            <p role="status">
              <strong>Could not save your profile.</strong>{' '}
              {updateMe.error instanceof Error ? updateMe.error.message : ''}
            </p>
          )}
          {updateMe.isSuccess && <p role="status">Saved.</p>}
        </form>
      )}

      <p>
        <Link to="/billing">Manage billing information</Link>
      </p>
    </section>
  );
}
