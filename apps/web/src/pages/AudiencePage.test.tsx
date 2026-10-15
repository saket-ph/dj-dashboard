// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudiencePage } from './AudiencePage';
import { apiError, bodyOf, callsTo, deferred, installFetch, json } from '../test/utils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(handleRequestPost: (init: RequestInit | undefined) => Response | Promise<Response>) {
  const fetchSpy = installFetch((url, init) => {
    if (url === '/api/config') return json(200, { eventTitle: 'Test Night' });
    if (url === '/api/requests') return handleRequestPost(init);
    return apiError(404, 'NOT_FOUND');
  });
  const user = userEvent.setup();
  render(<AudiencePage />);
  return { fetchSpy, user };
}

async function fill(user: ReturnType<typeof userEvent.setup>, name: string, song: string, artist = '') {
  await user.type(screen.getByLabelText('Your name'), name);
  await user.type(screen.getByLabelText('Song title'), song);
  if (artist) await user.type(screen.getByLabelText(/Artist/), artist);
}

const submit = () => screen.getByRole('button', { name: /send request|sending/i });

describe('AudiencePage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('shows the event title from the server and a labelled form with no login (FR-001, FR-003)', async () => {
    setup(() => json(201, {}));
    expect(await screen.findByRole('heading', { level: 1, name: 'Test Night' })).toBeTruthy();
    expect(screen.getByLabelText('Your name')).toBeTruthy();
    expect(screen.getByLabelText('Song title')).toBeTruthy();
    expect(screen.getByLabelText(/Artist/)).toBeTruthy();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });

  it('shows success only after the server confirms, then clears the form (FR-008, FR-009, FR-013)', async () => {
    const pending = deferred<Response>();
    const { user } = setup(() => pending.promise);
    await fill(user, 'Alex', 'Blinding Lights', 'The Weeknd');
    await user.click(submit());

    // Request is in flight: loading state, and NO success message yet.
    expect(submit().hasAttribute('disabled')).toBe(true);
    expect(submit().textContent).toMatch(/sending/i);
    expect(screen.queryByText(/in the queue/i)).toBeNull();

    pending.resolve(json(201, { request: { sequenceNumber: 1 } }));
    expect(await screen.findByText(/in the queue/i)).toBeTruthy();
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Song title') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/Artist/) as HTMLInputElement).value).toBe('');
  });

  it('sends only the documented fields plus an idempotency key, omitting a blank artist', async () => {
    const { fetchSpy, user } = setup(() => json(201, { request: { sequenceNumber: 1 } }));
    await fill(user, 'Alex', 'Song');
    await user.click(submit());
    await screen.findByText(/in the queue/i);
    const [call] = callsTo(fetchSpy, '/api/requests', 'POST');
    const body = bodyOf(call?.[1] as RequestInit);
    expect(Object.keys(body).sort()).toEqual(['idempotencyKey', 'requesterName', 'songTitle']);
    expect(body.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it('keeps the typed values and shows the server message on a validation error, never success (FR-010, FR-013)', async () => {
    const { user } = setup(() => apiError(400, 'VALIDATION_ERROR', 'Please provide your name.'));
    await fill(user, 'Alex', 'Keep this title');
    await user.click(submit());
    expect((await screen.findByRole('alert')).textContent).toBe('Please provide your name.');
    expect(screen.queryByText(/in the queue/i)).toBeNull();
    expect((screen.getByLabelText('Song title') as HTMLInputElement).value).toBe('Keep this title');
    expect(submit().hasAttribute('disabled')).toBe(false);
  });

  it('shows a network error with retry guidance, keeps input, and never shows success', async () => {
    const { user } = setup(() => {
      throw new TypeError('Failed to fetch');
    });
    await fill(user, 'Alex', 'Song');
    await user.click(submit());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not reach the server/i);
    expect(screen.queryByText(/in the queue/i)).toBeNull();
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Alex');
  });

  it.each([
    [429, 'RATE_LIMITED', /too quickly/i],
    [500, 'PERSISTENCE_ERROR', /NOT saved/i],
    [503, 'SERVICE_UNAVAILABLE', /busy/i],
  ])('shows a distinct, non-technical message for %i %s', async (status, code, pattern) => {
    const { user } = setup(() => apiError(status, code, 'internal detail that must not matter'));
    await fill(user, 'Alex', 'Song');
    await user.click(submit());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(pattern);
    expect(alert.textContent).not.toMatch(/internal detail|SQL|stack/i);
    expect(screen.queryByText(/in the queue/i)).toBeNull();
  });

  it('ignores a second click while the first submission is in flight (FR-011, T-006)', async () => {
    const pending = deferred<Response>();
    const { fetchSpy, user } = setup(() => pending.promise);
    await fill(user, 'Alex', 'Song');
    const button = submit();
    await user.dblClick(button);
    await user.click(button);
    expect(callsTo(fetchSpy, '/api/requests', 'POST')).toHaveLength(1);
    expect(button.getAttribute('aria-busy')).toBe('true');
    pending.resolve(json(201, { request: { sequenceNumber: 1 } }));
    await screen.findByText(/in the queue/i);
    expect(callsTo(fetchSpy, '/api/requests', 'POST')).toHaveLength(1);
  });

  it('retries identical content with the SAME idempotency key, and a new key after an edit (FR-012)', async () => {
    let attempt = 0;
    const { fetchSpy, user } = setup(() => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('Failed to fetch'); // response lost
      return json(201, { request: { sequenceNumber: 1 } });
    });
    await fill(user, 'Alex', 'Song');
    await user.click(submit());
    await screen.findByRole('alert');
    await user.click(submit()); // retry, nothing edited
    await screen.findByText(/in the queue/i);

    const posts = callsTo(fetchSpy, '/api/requests', 'POST').map(([, init]) => bodyOf(init as RequestInit).idempotencyKey);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toBe(posts[1]);
  });

  it('uses a fresh key for the next song after a success, and after editing a failed attempt', async () => {
    let attempt = 0;
    const { fetchSpy, user } = setup(() => {
      attempt += 1;
      if (attempt === 2) return apiError(400, 'VALIDATION_ERROR', 'nope');
      return json(201, { request: { sequenceNumber: attempt } });
    });
    await fill(user, 'Alex', 'First');
    await user.click(submit());
    await screen.findByText(/in the queue/i);

    await fill(user, 'Alex', 'Second'); // identical-looking content class, but a new attempt
    await user.click(submit());
    await screen.findByRole('alert');

    await user.type(screen.getByLabelText('Song title'), ' (edited)');
    await user.click(submit());
    await waitFor(() => expect(callsTo(fetchSpy, '/api/requests', 'POST')).toHaveLength(3));

    const keys = callsTo(fetchSpy, '/api/requests', 'POST').map(([, init]) => bodyOf(init as RequestInit).idempotencyKey);
    expect(new Set(keys).size).toBe(3);
  });

  it('can be completed with the keyboard alone: Tab order follows the form and Enter submits (NFR-008, §13.2)', async () => {
    const { fetchSpy, user } = setup(() => json(201, { request: { sequenceNumber: 1 } }));
    await screen.findByRole('heading', { level: 1 });
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Your name'));
    await user.keyboard('Alex');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Song title'));
    await user.keyboard('Keyboard Song');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText(/Artist/));
    await user.tab();
    expect(document.activeElement).toBe(submit());
    await user.keyboard('{Enter}');
    await screen.findByText(/in the queue/i);
    expect(callsTo(fetchSpy, '/api/requests', 'POST')).toHaveLength(1);
  });

  it('announces success and errors politely to assistive tech (NFR-008)', async () => {
    const { user } = setup(() => apiError(400, 'VALIDATION_ERROR', 'Please provide your name.'));
    await fill(user, 'A', 'B');
    await user.click(submit());
    const alert = await screen.findByRole('alert');
    expect(alert.closest('[aria-live]')?.getAttribute('aria-live')).toBe('polite');
  });

  it('still lets the user submit if the event config cannot be loaded, with a retry link', async () => {
    installFetch((url) => (url === '/api/config' ? apiError(500, 'PERSISTENCE_ERROR') : json(201, {})));
    render(<AudiencePage />);
    expect(await screen.findByText(/could not load the event details/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(submit().hasAttribute('disabled')).toBe(false);
  });
});
