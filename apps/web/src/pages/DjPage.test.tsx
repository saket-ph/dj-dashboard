// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DjPage } from './DjPage';
import { apiError, bodyOf, callsTo, deferred, FakeEventSource, installFetch, json } from '../test/utils';

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(session: () => Response, login?: () => Response | Promise<Response>) {
  const fetchSpy = installFetch((url) => {
    if (url === '/api/auth/session') return session();
    if (url === '/api/auth/login') return login ? login() : apiError(401, 'UNAUTHENTICATED');
    if (url === '/api/dj/requests') return json(200, { requests: [] });
    if (url === '/api/config') return json(200, { eventTitle: 'Test Night' });
    return apiError(404, 'NOT_FOUND');
  });
  const user = userEvent.setup();
  render(<DjPage />);
  return { fetchSpy, user };
}

describe('DjPage gate', () => {
  it('shows the login form, never the queue, when there is no session (FR-026)', async () => {
    const { fetchSpy } = setup(() => json(200, { authenticated: false }));
    expect(await screen.findByRole('heading', { name: 'DJ login' })).toBeTruthy();
    expect(screen.getByLabelText('Password').getAttribute('type')).toBe('password');
    expect(callsTo(fetchSpy, '/api/dj/requests')).toHaveLength(0);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('shows a neutral checking state before the session is confirmed', async () => {
    const hold = deferred<Response>();
    installFetch(() => hold.promise as unknown as Response);
    render(<DjPage />);
    expect(screen.getByText('Checking your session…')).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
    hold.resolve(json(200, { authenticated: false }));
    await screen.findByLabelText('Password');
  });

  it('goes straight to the dashboard when a valid session exists (FR-029)', async () => {
    setup(() => json(200, { authenticated: true, csrfToken: 'tok' }));
    expect(await screen.findByText(/No requests yet/i)).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('shows a reachable-server hint if the session check fails', async () => {
    setup(() => {
      throw new TypeError('Failed to fetch');
    });
    await screen.findByLabelText('Password');
    expect(screen.getByRole('status').textContent).toMatch(/could not reach the server/i);
  });

  it('returns to login with a short explanation when the session expires mid-use (FR-031, T4.11)', async () => {
    let expired = false;
    installFetch((url) => {
      if (url === '/api/auth/session') return json(200, { authenticated: true, csrfToken: 'tok' });
      if (url === '/api/dj/requests') return expired ? apiError(401, 'UNAUTHENTICATED') : json(200, { requests: [] });
      return json(200, { eventTitle: 'T' });
    });
    render(<DjPage />);
    await screen.findByText(/No requests yet/i);
    expired = true;
    // A reconnect/reload now discovers the session is gone.
    FakeEventSource.last.emit('error');
    await screen.findByRole('heading', { name: 'DJ login' });
    expect(screen.getByRole('status').textContent).toBe('Your session ended. Please log in again.');
    expect(FakeEventSource.last.closed).toBe(true); // stream is torn down, no zombie connection
  });

  it('shows a generic error for a wrong password and keeps the user on login (FR-029, T-011)', async () => {
    const { user } = setup(() => json(200, { authenticated: false }));
    await user.type(await screen.findByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Incorrect password.');
    expect(screen.queryByText(/No requests yet/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Log in' }).hasAttribute('disabled')).toBe(false);
  });

  it('shows the lockout message when rate limited', async () => {
    const { user } = setup(() => json(200, { authenticated: false }), () => apiError(429, 'RATE_LIMITED'));
    await user.type(await screen.findByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/too many failed attempts/i);
  });

  it('opens the dashboard after a correct password, and sends the password only to the login call (FR-028, T-010)', async () => {
    const { fetchSpy, user } = setup(
      () => json(200, { authenticated: false }),
      () => json(200, { authenticated: true, csrfToken: 'tok' }),
    );
    await user.type(await screen.findByLabelText('Password'), 'secret-pw');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText(/No requests yet/i)).toBeTruthy();
    expect(bodyOf(callsTo(fetchSpy, '/api/auth/login', 'POST')[0]![1] as RequestInit)).toEqual({ password: 'secret-pw' });
    // The password is never put in any URL and never persisted client-side.
    for (const [url] of fetchSpy.mock.calls) expect(String(url)).not.toContain('secret-pw');
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('secret-pw');
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('csrf');
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('tok');
  });

  it('ignores a double-click on Log in while the attempt is in flight', async () => {
    const hold = deferred<Response>();
    const { fetchSpy, user } = setup(() => json(200, { authenticated: false }), () => hold.promise as unknown as Response);
    await user.type(await screen.findByLabelText('Password'), 'pw');
    const button = screen.getByRole('button', { name: 'Log in' });
    await user.dblClick(button);
    expect(callsTo(fetchSpy, '/api/auth/login', 'POST')).toHaveLength(1);
    hold.resolve(json(200, { authenticated: true, csrfToken: 'tok' }));
    await screen.findByText(/No requests yet/i);
    expect(callsTo(fetchSpy, '/api/auth/login', 'POST')).toHaveLength(1);
  });

  it('uses the dark DJ theme only while on the DJ page', async () => {
    const { unmount } = render(<DjPage />);
    unmount();
    expect(document.body.classList.contains('theme-dj')).toBe(false);
    installFetch(() => json(200, { authenticated: false }));
    const view = render(<DjPage />);
    await waitFor(() => expect(document.body.classList.contains('theme-dj')).toBe(true));
    view.unmount();
    expect(document.body.classList.contains('theme-dj')).toBe(false);
  });
});
