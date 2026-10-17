import type { SongRequest } from '../types.js';

export type RealtimeEventName = 'request.created' | 'request.updated' | 'request.deleted';

export interface RealtimeClient {
  sessionId: string;
  /** Writes one SSE event. May throw if the socket is gone; the hub isolates such failures. */
  send(event: string, data: unknown): void;
  close(): void;
}

/**
 * In-process fan-out to connected DJ dashboards.
 *
 * Events are notifications only (FR-014, §9.4): they are published AFTER the SQLite commit
 * and are never the sole copy of a request. A dashboard that misses one recovers from the
 * snapshot sent on (re)connect or from GET /api/dj/requests.
 */
export interface RealtimeHub {
  add(client: RealtimeClient): () => void;
  publish(event: Exclude<RealtimeEventName, 'request.deleted'>, request: SongRequest): void;
  /** Tells dashboards which committed rows were removed. Empty lists are not sent. */
  publishDeleted(ids: readonly string[]): void;
  /** Closes every stream that belongs to a session (logout / expiry). */
  closeSession(sessionId: string): void;
  readonly size: number;
}

export function createHub(onError?: (reason: string) => void): RealtimeHub {
  const clients = new Set<RealtimeClient>();

  function sendAll(event: string, data: unknown): void {
    for (const client of [...clients]) {
      try {
        client.send(event, data);
      } catch {
        // A dead socket must never break a committed change or other dashboards.
        clients.delete(client);
        onError?.('client_send_failed');
      }
    }
  }

  return {
    add(client) {
      clients.add(client);
      return () => {
        clients.delete(client);
      };
    },
    publish(event, request) {
      sendAll(event, request);
    },
    publishDeleted(ids) {
      if (ids.length === 0) return;
      sendAll('request.deleted', { ids: [...ids] });
    },
    closeSession(sessionId) {
      for (const client of [...clients]) {
        if (client.sessionId !== sessionId) continue;
        clients.delete(client);
        try {
          client.close();
        } catch {
          onError?.('client_close_failed');
        }
      }
    },
    get size() {
      return clients.size;
    },
  };
}
