import { useCallback, useEffect, useState } from 'react';
import { Dashboard } from '../components/Dashboard';
import { LoginForm } from '../components/LoginForm';
import { apiFetch } from '../lib/api';
import { SESSION_EXPIRED_MESSAGE } from '../lib/messages';

type Gate =
  | { kind: 'checking' }
  | { kind: 'login'; notice?: string }
  | { kind: 'dashboard'; csrfToken: string };

/**
 * Gate for /dj. The server is the authority: the dashboard only renders after
 * GET /api/auth/session confirms a live session, and any 401 sends the DJ back to login.
 * The CSRF token is kept in memory only (never localStorage).
 */
export function DjPage() {
  const [gate, setGate] = useState<Gate>({ kind: 'checking' });

  // Dark, high-contrast theme for a dimly lit booth; scoped to this route only.
  useEffect(() => {
    document.body.classList.add('theme-dj');
    return () => document.body.classList.remove('theme-dj');
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ authenticated: boolean; csrfToken?: string }>('/api/auth/session')
      .then(({ data }) => {
        if (cancelled) return;
        setGate(
          data.authenticated && data.csrfToken
            ? { kind: 'dashboard', csrfToken: data.csrfToken }
            : { kind: 'login' },
        );
      })
      .catch(() => {
        if (!cancelled) setGate({ kind: 'login', notice: 'Could not reach the server. Try logging in again.' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onUnauthenticated = useCallback(() => setGate({ kind: 'login', notice: SESSION_EXPIRED_MESSAGE }), []);
  const onLoggedOut = useCallback(() => setGate({ kind: 'login' }), []);

  if (gate.kind === 'checking') {
    return (
      <main className="page page--dj">
        <p className="state" role="status">
          Checking your session…
        </p>
      </main>
    );
  }
  if (gate.kind === 'login') {
    return <LoginForm notice={gate.notice} onLoggedIn={(csrfToken) => setGate({ kind: 'dashboard', csrfToken })} />;
  }
  return <Dashboard csrfToken={gate.csrfToken} onUnauthenticated={onUnauthenticated} onLoggedOut={onLoggedOut} />;
}
