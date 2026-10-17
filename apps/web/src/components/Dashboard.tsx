import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiFetch } from '../lib/api';
import { startLiveConnection, type ConnectionState } from '../lib/liveConnection';
import { describeActionError, describeDeleteError, describeLoadError } from '../lib/messages';
import { applySnapshot, mergeReload, removeRequests, splitQueue, upsertRequest } from '../lib/queue';
import type { SongRequest } from '../lib/types';
import { RequestRow } from './RequestRow';

interface Props {
  csrfToken: string;
  onUnauthenticated: () => void;
  onLoggedOut: () => void;
}

type LoadState = 'loading' | 'ready' | 'error';

/** Status is always a word, never color alone (§13.3). */
const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  offline: 'Offline — retrying',
};

const CONNECTION_CLASS: Record<ConnectionState, string> = {
  connecting: 'conn--reconnecting',
  connected: 'conn--connected',
  reconnecting: 'conn--reconnecting',
  offline: 'conn--offline',
};

export function Dashboard({ csrfToken, onUnauthenticated, onLoggedOut }: Props) {
  const [eventTitle, setEventTitle] = useState('');
  const [requests, setRequests] = useState<SongRequest[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState('');
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  // Ids deleted locally that a stale GET must not put back. Cleared when a stream snapshot arrives.
  const suppressed = useRef(new Set<string>());
  // Synchronous guard: blocks a second click before React re-renders the button as disabled.
  const inFlight = useRef(new Set<string>());

  const handleError = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthenticated();
        return true;
      }
      return false;
    },
    [onUnauthenticated],
  );

  const loadQueue = useCallback(async () => {
    setLoadState((s) => (s === 'ready' ? s : 'loading'));
    try {
      const { data } = await apiFetch<{ requests: SongRequest[] }>('/api/dj/requests');
      // The persisted queue from SQLite. Merged (not replaced) so a row an SSE event delivered
      // while this GET was in flight is not lost; the stream snapshot is the strict replace.
      setRequests((local) => mergeReload(local, data.requests).filter((row) => !suppressed.current.has(row.id)));
      setLoadState('ready');
      setLoadError('');
    } catch (err) {
      if (handleError(err)) return;
      setLoadError(describeLoadError(err));
      setLoadState((s) => (s === 'ready' ? s : 'error'));
    }
  }, [handleError]);

  // Keep the latest loader in a ref so the live connection is opened once, not on every render.
  const reloadRef = useRef(loadQueue);
  useEffect(() => {
    reloadRef.current = loadQueue;
  }, [loadQueue]);

  useEffect(() => {
    void loadQueue();
    apiFetch<{ eventTitle: string }>('/api/config')
      .then(({ data }) => setEventTitle(data.eventTitle))
      .catch(() => undefined);
  }, [loadQueue]);

  useEffect(() => {
    const live = startLiveConnection({
      url: '/api/dj/requests/stream',
      onState: setConnection,
      // A snapshot is the authoritative queue read from SQLite: replace local state.
      onSnapshot: (list) => {
        suppressed.current.clear();
        setRequests(applySnapshot(list));
        setLoadState('ready');
        setLoadError('');
      },
      onUpsert: (request) =>
        setRequests((local) => (suppressed.current.has(request.id) ? local : upsertRequest(local, request))),
      onDeleted: (ids) => applyDeleted(ids),
      onReload: () => void reloadRef.current(),
    });

    // A phone or laptop that slept may have missed events: reload when the tab is visible again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reloadRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      live.stop();
    };
  }, []);

  async function mark(id: string, status: 'played' | 'skipped') {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setBusyIds(new Set(inFlight.current));
    setActionError('');
    try {
      const { data } = await apiFetch<{ request: SongRequest }>(
        `/api/dj/requests/${encodeURIComponent(id)}/status`,
        { method: 'PATCH', body: JSON.stringify({ status }), csrfToken },
      );
      setRequests((list) => upsertRequest(list, data.request));
    } catch (err) {
      if (handleError(err)) return;
      setActionError(describeActionError(err));
      if (err instanceof ApiError && err.code === 'NOT_FOUND') void loadQueue();
    } finally {
      inFlight.current.delete(id);
      setBusyIds(new Set(inFlight.current));
    }
  }

  function applyDeleted(ids: readonly string[]) {
    for (const id of ids) suppressed.current.add(id);
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
    setRequests((local) => removeRequests(local, ids));
  }

  async function deleteSongs(body: { all: true } | { ids: string[] }, confirmText: string) {
    if (deleting) return;
    if (!window.confirm(confirmText)) return;
    setDeleting(true);
    setActionError('');
    try {
      const { data } = await apiFetch<{ deletedIds: string[] }>('/api/dj/requests', {
        method: 'DELETE',
        body: JSON.stringify(body),
        csrfToken,
      });
      applyDeleted(data.deletedIds);
    } catch (err) {
      if (handleError(err)) return;
      setActionError(describeDeleteError(err));
    } finally {
      setDeleting(false);
    }
  }

  function toggleSelected(id: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(on: boolean) {
    setSelected(on ? new Set(requests.map((row) => row.id)) : new Set());
  }

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', body: JSON.stringify({}), csrfToken });
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        setActionError('Could not log out. Please try again.');
        setLoggingOut(false);
        return;
      }
    }
    onLoggedOut();
  }

  const { pending, history } = useMemo(() => splitQueue(requests), [requests]);
  const allSelected = requests.length > 0 && requests.every((row) => selected.has(row.id));

  return (
    <main className="page page--dj page--dashboard">
      <header className="dash-header">
        <div>
          <h1>{eventTitle || 'DJ dashboard'}</h1>
          <p className="dash-sub">DJ dashboard</p>
        </div>
        <div className="dash-header__right">
          <p
            className={`conn ${CONNECTION_CLASS[connection]}`}
            data-testid="connection-status"
            role="status"
            aria-live="polite"
          >
            Live updates: {CONNECTION_LABEL[connection]}
          </p>
          <button type="button" className="button" onClick={() => void logout()} disabled={loggingOut}>
            {loggingOut ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      </header>

      {actionError && (
        <p className="message message--error" role="alert">
          {actionError}
        </p>
      )}

      {loadState === 'loading' && (
        <p className="state" role="status">
          Loading the queue…
        </p>
      )}

      {loadState === 'error' && (
        <div className="state state--error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="button button--primary" onClick={() => void loadQueue()}>
            Try again
          </button>
        </div>
      )}

      {loadState === 'ready' && (
        <>
          {loadError && (
            <p className="message message--error" role="alert">
              {loadError}{' '}
              <button type="button" className="link-button" onClick={() => void loadQueue()}>
                Retry
              </button>
            </p>
          )}

          {requests.length > 0 && (
            <div className="dash-actions">
              <label className="dash-actions__all">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(event) => toggleAll(event.target.checked)}
                  aria-label="Select all requests"
                />
                Select all
              </label>
              <button
                type="button"
                className="button button--danger"
                disabled={selected.size === 0 || deleting}
                onClick={() =>
                  void deleteSongs(
                    { ids: [...selected] },
                    `Delete ${selected.size} selected ${selected.size === 1 ? 'request' : 'requests'}? This cannot be undone.`,
                  )
                }
              >
                {deleting ? 'Deleting…' : `Delete selected${selected.size > 0 ? ` (${selected.size})` : ''}`}
              </button>
              <button
                type="button"
                className="button button--danger"
                disabled={deleting}
                onClick={() => void deleteSongs({ all: true }, 'Delete every request in the queue? This cannot be undone.')}
              >
                Delete all
              </button>
            </div>
          )}

          <section aria-labelledby="pending-heading">
            <h2 id="pending-heading">
              Pending <span className="count" data-testid="pending-count">{pending.length}</span>
            </h2>
            {requests.length === 0 ? (
              <p className="state state--empty">No requests yet. New requests will show up here.</p>
            ) : pending.length === 0 ? (
              <p className="state state--empty">Nothing pending. Every request so far has been handled.</p>
            ) : (
              <ol className="queue">
                {pending.map((r, i) => (
                  <RequestRow
                    key={r.id}
                    request={r}
                    isNext={i === 0}
                    busy={busyIds.has(r.id)}
                    selected={selected.has(r.id)}
                    onSelect={toggleSelected}
                    onMark={mark}
                  />
                ))}
              </ol>
            )}
          </section>

          <section aria-labelledby="history-heading">
            <h2 id="history-heading">
              History <span className="count">{history.length}</span>
            </h2>
            {history.length === 0 ? (
              <p className="state state--empty">Played and skipped requests will appear here.</p>
            ) : (
              <ol className="queue queue--history">
                {history.map((r) => (
                  <RequestRow key={r.id} request={r} selected={selected.has(r.id)} onSelect={toggleSelected} />
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </main>
  );
}
