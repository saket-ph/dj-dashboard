import type { SongRequest } from './types';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

/** The subset of the browser EventSource API this module uses (so tests can fake it). */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  close(): void;
}

export interface LiveConnectionOptions {
  url: string;
  onState: (state: ConnectionState) => void;
  /** Authoritative full queue (sent by the server on every (re)connect): replace local state. */
  onSnapshot: (requests: SongRequest[]) => void;
  /** One committed request created or updated: upsert by id. */
  onUpsert: (request: SongRequest) => void;
  /** Ask the owner to reload the queue from SQLite via GET /api/dj/requests. */
  onReload: () => void;
  createEventSource?: (url: string) => EventSourceLike;
  /** Consecutive failures before the status reads "offline" (retries continue). Default 3. */
  maxFailuresBeforeOffline?: number;
  /** While the stream is down, reload the queue this often. Default 3000 ms. */
  pollMs?: number;
  /** Delay before re-opening a failed stream. Default 1s, doubling up to 10s. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /**
   * If nothing at all (events or heartbeat) arrives for this long, the connection is treated as
   * dead even though the browser has not reported an error (half-open TCP, sleeping phone,
   * proxy that stopped forwarding). Must exceed the server heartbeat (15 s). Default 40 s.
   */
  staleAfterMs?: number;
}

export interface LiveConnection {
  stop(): void;
}

const CLOSED = 2;

/**
 * Keeps the dashboard live over Server-Sent Events.
 *
 * - `snapshot` replaces local state; `request.created`/`request.updated` upsert by id.
 * - On any failure (browser error OR prolonged silence) the status becomes "reconnecting"
 *   (then "offline" after repeated failures), the queue is reloaded from SQLite immediately and
 *   then polled while the stream is down, so a missed notification is always corrected
 *   (NFR-009, §14).
 * - Events are hints only; this module never creates a request.
 */
export function startLiveConnection(options: LiveConnectionOptions): LiveConnection {
  const create = options.createEventSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);
  const maxFailures = options.maxFailuresBeforeOffline ?? 3;
  const pollMs = options.pollMs ?? 3000;
  const baseDelay = options.reconnectBaseMs ?? 1000;
  const maxDelay = options.reconnectMaxMs ?? 10_000;
  const staleAfterMs = options.staleAfterMs ?? 40_000;

  let stopped = false;
  let source: EventSourceLike | null = null;
  let failures = 0;
  let state: ConnectionState = 'connecting';
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let reopenTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  function setState(next: ConnectionState): void {
    if (stopped || next === state) return;
    state = next;
    options.onState(next);
  }

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling(): void {
    if (pollTimer !== null || stopped) return;
    pollTimer = setInterval(() => {
      if (!stopped) options.onReload();
    }, pollMs);
  }

  function clearWatchdog(): void {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  }

  /** Called on every sign of life from the current stream. */
  function armWatchdog(es: EventSourceLike): void {
    clearWatchdog();
    if (stopped) return;
    watchdog = setTimeout(() => {
      watchdog = null;
      if (source === es && !stopped) fail(es, true);
    }, staleAfterMs);
  }

  function markConnected(es: EventSourceLike): void {
    failures = 0;
    stopPolling();
    armWatchdog(es);
    setState('connected');
  }

  function parse<T>(raw: string | undefined): T | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  function scheduleReopen(): void {
    const delay = Math.min(baseDelay * 2 ** Math.max(0, failures - 1), maxDelay);
    if (reopenTimer !== null) clearTimeout(reopenTimer);
    reopenTimer = setTimeout(() => {
      reopenTimer = null;
      open();
    }, delay);
  }

  /**
   * One failed connection: browser-reported error, or silence past `staleAfterMs`.
   * `forceReopen` discards a stream the browser still believes is healthy.
   */
  function fail(es: EventSourceLike, forceReopen: boolean): void {
    if (source !== es || stopped) return;
    failures += 1;
    setState(failures >= maxFailures ? 'offline' : 'reconnecting');
    // Reload immediately, then keep polling until the stream is back.
    options.onReload();
    startPolling();

    if (forceReopen || es.readyState === CLOSED) {
      clearWatchdog();
      source = null;
      es.close();
      scheduleReopen();
    } else {
      // The browser is already retrying on its own (readyState CONNECTING). Keep watching it:
      // if it never comes back, the watchdog fires and we replace it.
      armWatchdog(es);
    }
  }

  function open(): void {
    if (stopped) return;
    const es = create(options.url);
    source = es;
    armWatchdog(es);

    es.addEventListener('open', () => {
      if (source === es) markConnected(es);
    });

    es.addEventListener('heartbeat', () => {
      if (source === es) markConnected(es);
    });

    es.addEventListener('snapshot', (e) => {
      if (source !== es) return;
      const data = parse<{ requests: SongRequest[] }>(e.data);
      if (data && Array.isArray(data.requests)) {
        markConnected(es);
        options.onSnapshot(data.requests);
      }
    });

    for (const type of ['request.created', 'request.updated'] as const) {
      es.addEventListener(type, (e) => {
        if (source !== es) return;
        armWatchdog(es);
        const request = parse<SongRequest>(e.data);
        if (request && typeof request.id === 'string') options.onUpsert(request);
      });
    }

    es.addEventListener('error', () => fail(es, false));
  }

  open();

  return {
    stop() {
      stopped = true;
      stopPolling();
      clearWatchdog();
      if (reopenTimer !== null) clearTimeout(reopenTimer);
      reopenTimer = null;
      source?.close();
      source = null;
    },
  };
}
