import type { Router } from 'express';
import { getSession, type Clock } from '../auth/session.js';
import type { SongRequestRepository } from '../db/requestRepository.js';
import type { SessionRepository } from '../db/sessionRepository.js';
import { persistenceError } from '../http/errors.js';
import type { Logger } from '../logger.js';
import type { RealtimeHub } from '../realtime/hub.js';

export interface StreamDeps {
  hub: RealtimeHub;
  repo: SongRequestRepository;
  sessions: SessionRepository;
  logger: Logger;
  clock: Clock;
  heartbeatMs: number;
}

/**
 * GET /api/dj/requests/stream  (mounted inside the DJ router, so the session check already ran)
 *
 * On connect the client receives a full `snapshot` read from SQLite, then `request.created` /
 * `request.updated` / `request.deleted` events. A periodic `heartbeat` event keeps proxies from idling the stream
 * out, lets the client detect a dead connection, and doubles as a session re-check: if the
 * session ended, the stream is closed.
 */
export function mountStream(router: Router, deps: StreamDeps): void {
  const { hub, repo, sessions, logger, clock, heartbeatMs } = deps;

  router.get('/requests/stream', (req, res) => {
    const session = getSession(res);

    // Subscribe first, then read the snapshot synchronously (better-sqlite3 is synchronous), so no
    // committed event can fall between the snapshot and the first live event. The snapshot is read
    // BEFORE any headers are written so a database failure is still a clean JSON error.
    let alive = true;

    const write = (event: string, data: unknown): void => {
      if (!alive) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const remove = hub.add({
      sessionId: session.id,
      send: write,
      close: () => {
        cleanup();
        res.end();
      },
    });

    let snapshot;
    try {
      snapshot = repo.list();
    } catch (err) {
      remove();
      throw persistenceError(logger, err, 'stream_snapshot');
    }

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // tell nginx-style proxies not to buffer the stream
    });
    res.flushHeaders();
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);

    res.write('retry: 2000\n\n');
    write('snapshot', { requests: snapshot });

    const heartbeat = setInterval(() => {
      if (!alive) return;
      try {
        if (!sessions.getValid(session.id, clock().toISOString())) {
          cleanup();
          res.end();
          return;
        }
        // A named event (not an SSE comment) so the browser exposes it to the client, which uses
        // it to detect a silently dead connection. It also keeps proxies from idling the stream out.
        write('heartbeat', {});
      } catch {
        // Never let a timer throw. If the session check fails (e.g. database trouble), end this
        // stream; the dashboard reconnects and reloads the authoritative queue.
        logger.warn('stream heartbeat failed; closing stream');
        cleanup();
        try {
          res.end();
        } catch {
          // socket already gone
        }
      }
    }, heartbeatMs);

    function cleanup(): void {
      if (!alive) return;
      alive = false;
      clearInterval(heartbeat);
      remove();
    }

    req.on('close', cleanup);
    res.on('error', cleanup);
  });
}
