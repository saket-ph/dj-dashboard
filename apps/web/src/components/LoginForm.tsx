import { useRef, useState, type FormEvent } from 'react';
import { apiFetch } from '../lib/api';
import { describeLoginError } from '../lib/messages';
import { createSubmitLock } from '../lib/submitLock';

interface Props {
  notice?: string;
  onLoggedIn: (csrfToken: string) => void;
}

export function LoginForm({ notice, onLoggedIn }: Props) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(createSubmitLock());

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!lock.current.tryAcquire()) return;
    setLoading(true);
    setError('');
    try {
      const { data } = await apiFetch<{ csrfToken: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      setPassword('');
      onLoggedIn(data.csrfToken);
    } catch (err) {
      setError(describeLoginError(err));
      setLoading(false);
    } finally {
      lock.current.release();
    }
  }

  return (
    <main className="page page--dj page--login">
      <h1>DJ login</h1>
      {notice && (
        <p className="message message--info" role="status">
          {notice}
        </p>
      )}
      <form className="card form" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="djPassword">Password</label>
          <input
            id="djPassword"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button type="submit" className="button button--primary" disabled={loading} aria-busy={loading}>
          {loading ? 'Logging in…' : 'Log in'}
        </button>
        <div className="feedback" aria-live="polite">
          {error && (
            <p className="message message--error" role="alert">
              {error}
            </p>
          )}
        </div>
      </form>
    </main>
  );
}

