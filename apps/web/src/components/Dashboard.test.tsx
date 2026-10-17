// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dashboard } from './Dashboard';
import type { SongRequest } from '../lib/types';
import {
  apiError,
  bodyOf,
  callsTo,
  deferred,
  FakeEventSource,
  headerOf,
  installFetch,
  json,
  makeRequest,
} from '../test/utils';

const CSRF = 'csrf-token-123';

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface Opts {
  queue?: SongRequest[] | Response;
  patch?: (id: string, status: string) => Response | Promise<Response>;
  onDelete?: (body: Record<string, unknown>) => Response;
}

function setup(opts: Opts = {}) {
  const onUnauthenticated = vi.fn();
  const onLoggedOut = vi.fn();
  const fetchSpy = installFetch((url, init) => {
    if (url === '/api/config') return json(200, { eventTitle: 'Test Night' });
    if (url === '/api/dj/requests' && init?.method === 'DELETE') {
      return opts.onDelete ? opts.onDelete(bodyOf(init)) : json(200, { deletedIds: [] });
    }
    if (url === '/api/dj/requests') {
      const q = opts.queue ?? [];
      return q instanceof Response ? q : json(200, { requests: q });
    }
    const m = /^\/api\/dj\/requests\/(.+)\/status$/.exec(url);
    if (m && init?.method === 'PATCH') {
      const status = String(bodyOf(init).status);
      return opts.patch ? opts.patch(decodeURIComponent(m[1]!), status) : apiError(500, 'PERSISTENCE_ERROR');
    }
    if (url === '/api/auth/logout') return json(200, { ok: true });
    return apiError(404, 'NOT_FOUND');
  });
  const user = userEvent.setup();
  render(<Dashboard csrfToken={CSRF} onUnauthenticated={onUnauthenticated} onLoggedOut={onLoggedOut} />);
  return { fetchSpy, user, onUnauthenticated, onLoggedOut };
}

const pendingCount = () => screen.getByTestId('pending-count').textContent;
const playedBtn = (n: number, title: string) =>
  screen.getByRole('button', { name: `Mark request ${n}, ${title}, as played` });

describe('Dashboard states', () => {
  it('shows a loading state, then the oldest pending request flagged as next up (FR-018, FR-019)', async () => {
    const pending = deferred<Response>();
    setup({ queue: undefined });
    cleanup();
    installFetch((url) => (url === '/api/dj/requests' ? pending.promise : json(200, { eventTitle: 'T' })));
    render(<Dashboard csrfToken={CSRF} onUnauthenticated={vi.fn()} onLoggedOut={vi.fn()} />);
    expect(screen.getByText('Loading the queue…')).toBeTruthy();

    pending.resolve(json(200, { requests: [makeRequest(2), makeRequest(1)] }));
    await screen.findByText('Song 1');
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('Song 1'); // lowest sequence first
    expect(rows[0]!.textContent).toContain('Next up');
    expect(rows[1]!.textContent).not.toContain('Next up');
    expect(pendingCount()).toBe('2');
  });

  it('shows an empty state when there are no requests (FR-024)', async () => {
    setup({ queue: [] });
    expect(await screen.findByText(/No requests yet/i)).toBeTruthy();
    expect(pendingCount()).toBe('0');
  });

  it('shows an error with a working retry when the queue fails to load (FR-037)', async () => {
    let fail = true;
    installFetch((url) => {
      if (url === '/api/dj/requests') return fail ? apiError(500, 'PERSISTENCE_ERROR') : json(200, { requests: [makeRequest(1)] });
      return json(200, { eventTitle: 'T' });
    });
    const user = userEvent.setup();
    render(<Dashboard csrfToken={CSRF} onUnauthenticated={vi.fn()} onLoggedOut={vi.fn()} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The queue could not be loaded.');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Song 1')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sends an expired session back to login instead of showing a blank queue (FR-031)', async () => {
    const { onUnauthenticated } = setup({ queue: apiError(401, 'UNAUTHENTICATED') });
    await waitFor(() => expect(onUnauthenticated).toHaveBeenCalled());
  });

  it('splits pending from history and labels status with words (FR-022, FR-023, §13.3)', async () => {
    setup({
      queue: [
        makeRequest(1, { status: 'played' }),
        makeRequest(2),
        makeRequest(3, { status: 'skipped' }),
      ],
    });
    await screen.findByText('Song 2');
    const pendingSection = screen.getByRole('region', { name: /Pending/ });
    const historySection = screen.getByRole('region', { name: /History/ });
    expect(within(pendingSection).getByText('Song 2')).toBeTruthy();
    expect(within(historySection).getByText('Song 1')).toBeTruthy();
    expect(within(historySection).getByText('Song 3')).toBeTruthy();
    expect(within(historySection).getByText('Played')).toBeTruthy();
    expect(within(historySection).getByText('Skipped')).toBeTruthy();
    // Handled rows have no action buttons.
    expect(within(historySection).queryByRole('button')).toBeNull();
  });
});

describe('Dashboard actions', () => {
  it('marks played with the CSRF header, then moves the row to history (FR-034, FR-036)', async () => {
    const { fetchSpy, user } = setup({
      queue: [makeRequest(1), makeRequest(2)],
      patch: (id, status) => json(200, { request: makeRequest(1, { id, status: status as 'played', updatedAt: '2026-10-14T12:05:00.000Z' }) }),
    });
    await screen.findByText('Song 1');
    await user.click(playedBtn(1, 'Song 1'));

    await waitFor(() => expect(pendingCount()).toBe('1'));
    const [call] = callsTo(fetchSpy, '/api/dj/requests/id-1/status', 'PATCH');
    expect(headerOf(call![1] as RequestInit, 'X-CSRF-Token')).toBe(CSRF);
    expect(bodyOf(call![1] as RequestInit)).toEqual({ status: 'played' });
    const history = screen.getByRole('region', { name: /History/ });
    expect(within(history).getByText('Song 1')).toBeTruthy();
  });

  it('sends one PATCH on a double click and disables the buttons while in flight (FR-034)', async () => {
    const hold = deferred<Response>();
    const { fetchSpy, user } = setup({ queue: [makeRequest(1)], patch: () => hold.promise });
    await screen.findByText('Song 1');
    const played = playedBtn(1, 'Song 1');
    await user.dblClick(played);
    await waitFor(() => expect(played.hasAttribute('disabled')).toBe(true));
    expect(screen.getByRole('button', { name: /as skipped/ }).hasAttribute('disabled')).toBe(true);
    expect(callsTo(fetchSpy, '/api/dj/requests/id-1/status', 'PATCH')).toHaveLength(1);

    hold.resolve(json(200, { request: makeRequest(1, { status: 'played' }) }));
    await waitFor(() => expect(pendingCount()).toBe('0'));
    expect(callsTo(fetchSpy, '/api/dj/requests/id-1/status', 'PATCH')).toHaveLength(1);
  });

  it('keeps the row pending and shows an error when the update fails (FR-036, FR-037)', async () => {
    const { user } = setup({ queue: [makeRequest(1)], patch: () => apiError(500, 'PERSISTENCE_ERROR') });
    await screen.findByText('Song 1');
    await user.click(playedBtn(1, 'Song 1'));
    expect((await screen.findByRole('alert')).textContent).toBe('The request was not updated. Please try again.');
    expect(pendingCount()).toBe('1');
    expect(playedBtn(1, 'Song 1').hasAttribute('disabled')).toBe(false);
  });

  it('shows a network-specific message when the update cannot reach the server', async () => {
    const { user } = setup({
      queue: [makeRequest(1)],
      patch: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await screen.findByText('Song 1');
    await user.click(screen.getByRole('button', { name: /as skipped/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not reach the server/);
    expect(pendingCount()).toBe('1');
  });

  it('goes back to login when the session expired during an action', async () => {
    const { user, onUnauthenticated } = setup({ queue: [makeRequest(1)], patch: () => apiError(401, 'UNAUTHENTICATED') });
    await screen.findByText('Song 1');
    await user.click(playedBtn(1, 'Song 1'));
    await waitFor(() => expect(onUnauthenticated).toHaveBeenCalled());
  });

  it('reloads the queue when the request no longer exists', async () => {
    const { fetchSpy, user } = setup({ queue: [makeRequest(1)], patch: () => apiError(404, 'NOT_FOUND') });
    await screen.findByText('Song 1');
    const before = callsTo(fetchSpy, '/api/dj/requests', 'GET').length;
    await user.click(playedBtn(1, 'Song 1'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/no longer exists/);
    await waitFor(() => expect(callsTo(fetchSpy, '/api/dj/requests', 'GET').length).toBeGreaterThan(before));
  });

  it('logs out with the CSRF header and returns to the gate (FR-030)', async () => {
    const { fetchSpy, user, onLoggedOut } = setup({ queue: [] });
    await screen.findByText(/No requests yet/i);
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(onLoggedOut).toHaveBeenCalled());
    const [call] = callsTo(fetchSpy, '/api/auth/logout', 'POST');
    expect(headerOf(call![1] as RequestInit, 'X-CSRF-Token')).toBe(CSRF);
  });
});

describe('Dashboard live updates', () => {
  it('opens the DJ stream and reflects connection state in words', async () => {
    setup({ queue: [] });
    await screen.findByText(/No requests yet/i);
    const status = screen.getByTestId('connection-status');
    expect(status.textContent).toBe('Live updates: Connecting…');
    expect(FakeEventSource.last.url).toBe('/api/dj/requests/stream');

    act(() => FakeEventSource.last.emit('snapshot', { requests: [] }));
    expect(status.textContent).toBe('Live updates: Connected');

    act(() => FakeEventSource.last.emit('error'));
    expect(status.textContent).toBe('Live updates: Reconnecting…');
  });

  it('shows a new request pushed over the stream without a reload (FR-014, NFR-003)', async () => {
    const { fetchSpy } = setup({ queue: [makeRequest(1)] });
    await screen.findByText('Song 1');
    const getsBefore = callsTo(fetchSpy, '/api/dj/requests', 'GET').length;
    act(() => FakeEventSource.last.emit('snapshot', { requests: [makeRequest(1)] }));
    act(() => FakeEventSource.last.emit('request.created', makeRequest(2)));
    expect(await screen.findByText('Song 2')).toBeTruthy();
    expect(pendingCount()).toBe('2');
    expect(callsTo(fetchSpy, '/api/dj/requests', 'GET')).toHaveLength(getsBefore);
  });

  it('moves a row to history when another DJ screen marks it played (FR-036)', async () => {
    setup({ queue: [makeRequest(1), makeRequest(2)] });
    await screen.findByText('Song 1');
    act(() => FakeEventSource.last.emit('request.updated', makeRequest(1, { status: 'played', updatedAt: '2026-10-14T12:09:00.000Z' })));
    await waitFor(() => expect(pendingCount()).toBe('1'));
  });

  it('replaces local state with the snapshot sent on (re)connect', async () => {
    setup({ queue: [makeRequest(1), makeRequest(2)] });
    await screen.findByText('Song 2');
    act(() => FakeEventSource.last.emit('snapshot', { requests: [makeRequest(2), makeRequest(3)] }));
    await screen.findByText('Song 3');
    expect(screen.queryByText('Song 1')).toBeNull();
  });
});

describe('Deleting requests', () => {
  it('deletes only the selected songs after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { fetchSpy, user } = setup({
      queue: [makeRequest(1), makeRequest(2)],
      onDelete: (body) => json(200, { deletedIds: body.ids as string[] }),
    });
    await screen.findByText('Song 2');
    await user.click(screen.getByRole('checkbox', { name: 'Select request 1, Song 1' }));
    await user.click(screen.getByRole('button', { name: 'Delete selected (1)' }));
    await waitFor(() => expect(screen.queryByText('Song 1')).toBeNull());
    expect(screen.getByText('Song 2')).toBeTruthy();
    const call = callsTo(fetchSpy, '/api/dj/requests', 'DELETE');
    expect(call).toHaveLength(1);
    expect(headerOf(call[0]![1], 'X-CSRF-Token')).toBe(CSRF);
    expect(bodyOf(call[0]![1]).ids).toEqual(['id-1']);
  });

  it('does not delete when the confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { fetchSpy, user } = setup({ queue: [makeRequest(1)] });
    await screen.findByText('Song 1');
    await user.click(screen.getByRole('button', { name: 'Delete all' }));
    expect(screen.getByText('Song 1')).toBeTruthy();
    expect(callsTo(fetchSpy, '/api/dj/requests', 'DELETE')).toHaveLength(0);
  });

  it('clears pending and history together when deleting all', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user } = setup({
      queue: [makeRequest(1), makeRequest(2, { status: 'played' })],
      onDelete: () => json(200, { deletedIds: ['id-1', 'id-2'] }),
    });
    await screen.findByText('Song 1');
    await user.click(screen.getByRole('button', { name: 'Delete all' }));
    await screen.findByText(/No requests yet/i);
  });

  it('removes a song when another dashboard deletes it', async () => {
    setup({ queue: [makeRequest(1), makeRequest(2)] });
    await screen.findByText('Song 1');
    act(() => FakeEventSource.last.emit('request.deleted', { ids: ['id-1'] }));
    await waitFor(() => expect(screen.queryByText('Song 1')).toBeNull());
    expect(screen.getByText('Song 2')).toBeTruthy();
  });
});

describe('Safe rendering of untrusted text (FR-058, T-025)', () => {
  const hostile = {
    requesterName: '<img src=x onerror="window.__pwned=1">',
    songTitle: '<script>window.__pwned=1</script>Evil Song',
    artistName: '<b>bold</b>&amp;',
  };

  it('renders markup in names and titles as literal text, not elements', async () => {
    setup({ queue: [makeRequest(1, hostile)] });
    const song = await screen.findByText(hostile.songTitle);
    expect(song.textContent).toBe(hostile.songTitle);
    expect(screen.getByText(hostile.artistName)).toBeTruthy();
    expect(screen.getByText(`Requested by ${hostile.requesterName}`)).toBeTruthy();

    const main = document.querySelector('main')!;
    expect(main.querySelector('script')).toBeNull();
    expect(main.querySelector('img')).toBeNull();
    expect(main.querySelector('b')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('shows the YouTube link when the lookup arrives on the live stream', async () => {
    setup({ queue: [makeRequest(1)] });
    await screen.findByText('Song 1');
    expect(screen.queryByRole('link')).toBeNull();
    act(() =>
      FakeEventSource.last.emit(
        'request.updated',
        makeRequest(1, { youtubeVideoId: 'dQw4w9WgXcQ', youtubeTitle: 'Song 1 video' }),
      ),
    );
    const link = await screen.findByRole('link', { name: 'Song 1 video' });
    expect(link.getAttribute('href')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('shows a YouTube link only for a real video id, as text', async () => {
    setup({
      queue: [
        makeRequest(1, { youtubeVideoId: 'dQw4w9WgXcQ', youtubeTitle: '<b>Official</b>' }),
        makeRequest(2, { youtubeVideoId: 'https://evil.example', youtubeTitle: 'Do not link' }),
      ],
    });
    const link = await screen.findByRole('link', { name: '<b>Official</b>' });
    expect(link.getAttribute('href')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.querySelector('b')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Do not link' })).toBeNull();
  });

  it('renders markup arriving over the stream as text too', async () => {
    setup({ queue: [] });
    await screen.findByText(/No requests yet/i);
    act(() => FakeEventSource.last.emit('request.created', makeRequest(1, hostile)));
    await screen.findByText(hostile.songTitle);
    expect(document.querySelector('main script')).toBeNull();
  });
});
