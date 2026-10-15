import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createHub } from '../src/realtime/hub.js';
import type { SongRequest } from '../src/types.js';
import {
  authHeaders,
  countRows,
  loginAsDj,
  openStream,
  patchStatus,
  postJson,
  seedRequests,
  startTestServer,
  type SseClient,
  type SseEvent,
  type TestServer,
} from './helpers.js';

const servers: TestServer[] = [];
const streams: SseClient[] = [];

async function server(options?: Parameters<typeof startTestServer>[0]): Promise<TestServer> {
  const s = await startTestServer(options);
  servers.push(s);
  return s;
}
async function stream(s: TestServer, headers: Record<string, string>): Promise<SseClient> {
  const c = await openStream(s.baseUrl, headers);
  streams.push(c);
  return c;
}
afterEach(async () => {
  for (const c of streams.splice(0)) c.abort();
  for (const s of servers.splice(0)) await s.close();
});

const created = (events: SseEvent[]) => events.filter((e) => e.event === 'request.created');

describe('GET /api/dj/requests/stream (T3.01)', () => {
  it('rejects an anonymous client with 401 and no stream', async () => {
    const s = await server();
    const res = await fetch(`${s.baseUrl}/api/dj/requests/stream`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('content-type') ?? '', /json/);
  });

  it('streams text/event-stream with a heartbeat for a logged-in client', async () => {
    const s = await server({ appDeps: () => ({ heartbeatMs: 40 }) });
    const login = await loginAsDj(s.baseUrl);
    const c = await stream(s, authHeaders(login, false));
    assert.equal(c.status, 200);
    assert.match(c.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.match(c.headers.get('cache-control') ?? '', /no-cache/);
    // The heartbeat is a named event so browsers can see it (SSE comments are invisible to JS).
    await c.waitFor((ev) => ev.filter((e) => e.event === 'heartbeat').length >= 2);
  });
});

describe('snapshot on connect (T3.03)', () => {
  it('sends the full persisted queue in sequence order before any live event', async () => {
    const s = await server();
    await seedRequests(s.baseUrl, 2);
    const login = await loginAsDj(s.baseUrl);
    const c = await stream(s, authHeaders(login, false));
    await c.waitFor((ev) => ev.length >= 1);
    const first = c.events[0]!;
    assert.equal(first.event, 'snapshot');
    const requests = (first.data as { requests: SongRequest[] }).requests;
    assert.deepEqual(
      requests.map((r) => r.sequenceNumber),
      [1, 2],
    );
  });

  it('snapshot rows match GET /api/dj/requests exactly (same public shape)', async () => {
    const s = await server();
    await seedRequests(s.baseUrl, 3);
    const login = await loginAsDj(s.baseUrl);
    const c = await stream(s, authHeaders(login, false));
    await c.waitFor((ev) => ev.length >= 1);
    const listed = ((await (await fetch(`${s.baseUrl}/api/dj/requests`, { headers: authHeaders(login, false) })).json()) as {
      requests: SongRequest[];
    }).requests;
    assert.deepEqual((c.events[0]!.data as { requests: SongRequest[] }).requests, listed);
  });
});

describe('events are published only after commit (T3.02)', () => {
  it('a new request produces exactly one request.created event and one SQLite row', async () => {
    const s = await server();
    const login = await loginAsDj(s.baseUrl);
    const c = await stream(s, authHeaders(login, false));
    await c.waitFor((ev) => ev.length >= 1);

    const res = await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'Alex', songTitle: 'Live Song' });
    assert.equal(res.status, 201);
    await c.waitFor((ev) => created(ev).length === 1);
    await c.settle(150);

    const events = created(c.events);
    assert.equal(events.length, 1);
    const payload = events[0]!.data as SongRequest;
    assert.equal(payload.songTitle, 'Live Song');
    assert.equal(payload.sequenceNumber, 1);
    assert.equal(payload.status, 'pending');
    assert.equal(countRows(s.db), 1, 'the event must not create a second row');
  });

  it('a status change produces a request.updated event carrying the same sequence', async () => {
    const s = await server();
    const [r] = await seedRequests(s.baseUrl, 2);
    const login = await loginAsDj(s.baseUrl);
    const c = await stream(s, authHeaders(login, false));
    await c.waitFor((ev) => ev.length >= 1);

    await patchStatus(s.baseUrl, r!.id, 'played', authHeaders(login));
    await c.waitFor((ev) => ev.some((e) => e.event === 'request.updated'));
    const updated = c.events.find((e) => e.event === 'request.updated')!.data as SongRequest;
    assert.equal(updated.id, r!.id);
    assert.equal(updated.status, 'played');
    assert.equal(updated.sequenceNumber, 1);
  });

  it('a failed insert emits no event and no row', async () => {
    const s = await server({
      wrapRepo: (repo) => ({
        ...repo,
        create: () => {
          throw Object.assign(new Error('boom'), { code: 'SQLITE_FULL' });
        },
      }),
    });
    const login = await loginAsDj(s.baseUrl);
    const c = await stream(s, authHeaders(login, false));
    await c.waitFor((ev) => ev.length >= 1);

    const res = await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'Alex', songTitle: 'Nope' });
    assert.equal(res.status, 500);
    const events = await c.settle(200);
    assert.equal(created(events).length, 0);
    assert.equal(countRows(s.db), 0);
  });

  it('a rejected (invalid or CSRF-less) write emits no event', async () => {
    const s = await server();
    const [r] = await seedRequests(s.baseUrl, 1);
    const login = await loginAsDj(s.baseUrl);
    const c = await stream(s, authHeaders(login, false));
    await c.waitFor((ev) => ev.length >= 1);

    await postJson(`${s.baseUrl}/api/requests`, { requesterName: '', songTitle: 'x' });
    await patchStatus(s.baseUrl, r!.id, 'played', authHeaders(login, false));
    const events = await c.settle(200);
    assert.deepEqual(
      events.map((e) => e.event).filter((name) => name !== 'heartbeat'),
      ['snapshot'],
    );
  });

  it('commits succeed with zero connected dashboards', async () => {
    const s = await server();
    const res = await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'Alex', songTitle: 'Alone' });
    assert.equal(res.status, 201);
    assert.equal(countRows(s.db), 1);
  });

  it('two dashboards each receive the event; SQLite still has one row', async () => {
    const s = await server();
    const a = await loginAsDj(s.baseUrl);
    const b = await loginAsDj(s.baseUrl);
    const ca = await stream(s, authHeaders(a, false));
    const cb = await stream(s, authHeaders(b, false));
    await ca.waitFor((ev) => ev.length >= 1);
    await cb.waitFor((ev) => ev.length >= 1);

    await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'Alex', songTitle: 'Shared' });
    await ca.waitFor((ev) => created(ev).length === 1);
    await cb.waitFor((ev) => created(ev).length === 1);
    assert.equal(countRows(s.db), 1);
  });
});

describe('reconnect recovers the authoritative queue (T-018, T3.06)', () => {
  it('requests committed while disconnected appear in the next snapshot, in order', async () => {
    const s = await server();
    await seedRequests(s.baseUrl, 1);
    const login = await loginAsDj(s.baseUrl);

    const first = await stream(s, authHeaders(login, false));
    await first.waitFor((ev) => ev.length >= 1);
    first.abort(); // dashboard loses its connection

    // Requests and a status change happen while the dashboard is away: no event is delivered.
    await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'B', songTitle: 'Missed 2' });
    await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'C', songTitle: 'Missed 3' });
    const rows = s.repo.list();
    await patchStatus(s.baseUrl, rows[0]!.id, 'skipped', authHeaders(login));

    const second = await stream(s, authHeaders(login, false));
    await second.waitFor((ev) => ev.length >= 1);
    const snap = (second.events[0]!.data as { requests: SongRequest[] }).requests;
    assert.deepEqual(
      snap.map((r) => [r.sequenceNumber, r.status]),
      [
        [1, 'skipped'],
        [2, 'pending'],
        [3, 'pending'],
      ],
    );
    assert.equal(snap.length, countRows(s.db), 'snapshot row count equals SQLite row count');
  });

  it('notifications are never the sole record: a request with no listener is still listed', async () => {
    const s = await server();
    await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'A', songTitle: 'No listener' });
    const login = await loginAsDj(s.baseUrl);
    const listed = (await (await fetch(`${s.baseUrl}/api/dj/requests`, { headers: authHeaders(login, false) })).json()) as {
      requests: SongRequest[];
    };
    assert.equal(listed.requests.length, 1);
  });
});

describe('stream lifecycle', () => {
  it('removes a client from the hub when it disconnects', async () => {
    const hub = createHub();
    const s = await server({ appDeps: () => ({ hub }) });
    const login = await loginAsDj(s.baseUrl);
    const c = await stream(s, authHeaders(login, false));
    await c.waitFor((ev) => ev.length >= 1);
    const size = (): number => hub.size;
    assert.equal(size(), 1);
    c.abort();
    const deadline = Date.now() + 2000;
    while (size() !== 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(size(), 0);
  });

  it('logout closes that session\'s stream', async () => {
    const hub = createHub();
    const s = await server({ appDeps: () => ({ hub }) });
    const login = await loginAsDj(s.baseUrl);
    const c = await stream(s, authHeaders(login, false));
    await c.waitFor((ev) => ev.length >= 1);
    const res = await postJson(`${s.baseUrl}/api/auth/logout`, {}, authHeaders(login));
    assert.equal(res.status, 200);
    assert.equal(await c.closed, true, 'server should end the stream');
    assert.equal(hub.size, 0);
  });

  it('an expired session ends the stream at the next heartbeat', async () => {
    const hub = createHub();
    const s = await server({
      env: { SESSION_TTL_HOURS: '1' },
      appDeps: () => ({ hub, heartbeatMs: 40 }),
    });
    const login = await loginAsDj(s.baseUrl);
    const c = await stream(s, authHeaders(login, false));
    await c.waitFor((ev) => ev.length >= 1);
    s.clock.advance(2 * 3_600_000);
    assert.equal(await c.closed, true);
    assert.equal(hub.size, 0);
  });
});

describe('hub isolation', () => {
  it('a client whose socket throws never breaks other clients or the publisher', () => {
    const hub = createHub();
    const seen: string[] = [];
    hub.add({
      sessionId: 'bad',
      send: () => {
        throw new Error('socket closed');
      },
      close: () => {},
    });
    hub.add({ sessionId: 'good', send: (e) => void seen.push(e), close: () => {} });
    const fake = { id: 'x' } as unknown as SongRequest;
    assert.doesNotThrow(() => hub.publish('request.created', fake));
    assert.deepEqual(seen, ['request.created']);
    assert.equal(hub.size, 1, 'the dead client is dropped');
  });
});
