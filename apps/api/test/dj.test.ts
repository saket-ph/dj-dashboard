import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { SongRequest } from '../src/types.js';
import {
  authHeaders,
  loginAsDj,
  openStream,
  patchStatus,
  postJson,
  seedRequests,
  startTestServer,
  type TestServer,
} from './helpers.js';

const open: TestServer[] = [];
async function server(options?: Parameters<typeof startTestServer>[0]): Promise<TestServer> {
  const s = await startTestServer(options);
  open.push(s);
  return s;
}
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

async function listAs(s: TestServer, headers: Record<string, string>): Promise<SongRequest[]> {
  const res = await fetch(`${s.baseUrl}/api/dj/requests`, { headers });
  assert.equal(res.status, 200);
  return ((await res.json()) as { requests: SongRequest[] }).requests;
}

describe('unauthenticated access (T-012, NFR-007)', () => {
  it('rejects every DJ endpoint without a session and leaks no queue data', async () => {
    const s = await server();
    const [first] = await seedRequests(s.baseUrl, 2);
    assert.ok(first);

    const list = await fetch(`${s.baseUrl}/api/dj/requests`);
    assert.equal(list.status, 401);
    const listText = await list.text();
    assert.ok(!listText.includes('Song 1') && !listText.includes('Guest 1'));
    assert.equal((JSON.parse(listText) as { error: { code: string } }).error.code, 'UNAUTHENTICATED');

    const patch = await patchStatus(s.baseUrl, first.id, 'played', {});
    assert.equal(patch.status, 401);

    const del = await fetch(`${s.baseUrl}/api/dj/requests`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    assert.equal(del.status, 401);

    const restore = await fetch(`${s.baseUrl}/api/dj/requests/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [first.id] }),
    });
    assert.equal(restore.status, 401);
    assert.equal(s.repo.count(), 2);
    assert.equal(s.repo.getById(first.id)?.status, 'pending', 'unauthenticated patch must not write');

    for (const p of ['/api/dj/requests/stream', '/api/dj/anything']) {
      const res = await fetch(`${s.baseUrl}${p}`);
      assert.equal(res.status, 401, p);
    }
  });
});

describe('GET /api/dj/requests (T2.09, T-009)', () => {
  it('returns every request in ascending sequence order with the documented shape', async () => {
    const s = await server();
    await seedRequests(s.baseUrl, 5);
    const login = await loginAsDj(s.baseUrl);
    const rows = await listAs(s, authHeaders(login, false));
    assert.deepEqual(
      rows.map((r) => r.sequenceNumber),
      [1, 2, 3, 4, 5],
    );
    const first = rows[0]!;
    assert.deepEqual(Object.keys(first).sort(), [
      'artistName',
      'createdAt',
      'durationSeconds',
      'id',
      'likeCount',
      'requesterName',
      'sequenceNumber',
      'songTitle',
      'status',
      'updatedAt',
      'youtubeTitle',
      'youtubeVideoId',
    ]);
    assert.equal(first.artistName, null);
  });

  it('orders by sequence even when every created_at timestamp is identical', async () => {
    const s = await server();
    await seedRequests(s.baseUrl, 4);
    s.db.exec("UPDATE song_requests SET created_at = '2026-01-01T00:00:00.000Z'");
    const login = await loginAsDj(s.baseUrl);
    const rows = await listAs(s, authHeaders(login, false));
    assert.deepEqual(
      rows.map((r) => r.sequenceNumber),
      [1, 2, 3, 4],
    );
  });

  it('returns an empty list for an empty queue', async () => {
    const s = await server();
    const login = await loginAsDj(s.baseUrl);
    assert.deepEqual(await listAs(s, authHeaders(login, false)), []);
  });
});

describe('PATCH /api/dj/requests/:id/status (T2.10, T-013, T-014)', () => {
  it('marks played and skipped, persists, and keeps sequence numbers unchanged', async () => {
    const s = await server();
    const seeded = await seedRequests(s.baseUrl, 3);
    const login = await loginAsDj(s.baseUrl);

    const played = await patchStatus(s.baseUrl, seeded[0]!.id, 'played', authHeaders(login));
    assert.equal(played.status, 200);
    const playedBody = (await played.json()) as { request: SongRequest };
    assert.equal(playedBody.request.status, 'played');
    assert.equal(playedBody.request.sequenceNumber, 1);

    const skipped = await patchStatus(s.baseUrl, seeded[1]!.id, 'skipped', authHeaders(login));
    assert.equal(skipped.status, 200);
    assert.equal(((await skipped.json()) as { request: SongRequest }).request.sequenceNumber, 2);

    // "Refresh": a brand-new read from SQLite shows the same statuses and the same order.
    const rows = await listAs(s, authHeaders(login, false));
    assert.deepEqual(
      rows.map((r) => [r.sequenceNumber, r.status]),
      [
        [1, 'played'],
        [2, 'skipped'],
        [3, 'pending'],
      ],
    );
    // Played/skipped are retained as history, not deleted.
    assert.equal(rows.length, 3);
  });

  it('brings a played song back to the queue without changing its like count', async () => {
    const s = await server();
    const [song] = await seedRequests(s.baseUrl, 1);
    assert.ok(song);
    s.db.prepare('UPDATE song_requests SET like_count = 7 WHERE id = ?').run(song.id);
    const login = await loginAsDj(s.baseUrl);
    const headers = authHeaders(login);

    const played = await patchStatus(s.baseUrl, song.id, 'played', headers);
    assert.equal(played.status, 200);
    assert.equal(s.repo.getById(song.id)?.likeCount, 7);

    const hidden = await fetch(`${s.baseUrl}/api/songs`);
    assert.equal(((await hidden.json()) as { songs: unknown[] }).songs.length, 0);

    const restored = await fetch(`${s.baseUrl}/api/dj/requests/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ ids: [song.id] }),
    });
    assert.equal(restored.status, 200);
    const body = (await restored.json()) as { requests: SongRequest[] };
    assert.equal(body.requests.length, 1);
    assert.equal(body.requests[0]!.status, 'pending');
    assert.equal(body.requests[0]!.likeCount, 7);
    assert.equal(body.requests[0]!.sequenceNumber, song.sequenceNumber);
    assert.equal(s.repo.getById(song.id)?.likeCount, 7);

    const visible = await fetch(`${s.baseUrl}/api/songs`);
    const songs = ((await visible.json()) as { songs: { songTitle: string; count: number }[] }).songs;
    assert.equal(songs.length, 1);
    assert.equal(songs[0]!.count, 7);
  });

  it('updates updated_at but never created_at', async () => {
    const s = await server();
    const [r] = await seedRequests(s.baseUrl, 1);
    const login = await loginAsDj(s.baseUrl);
    const before = s.repo.getById(r!.id)!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await patchStatus(s.baseUrl, r!.id, 'played', authHeaders(login));
    const after = s.repo.getById(r!.id)!;
    assert.equal(after.createdAt, before.createdAt);
    assert.notEqual(after.updatedAt, before.updatedAt);
  });

  it('rejects pending and unknown statuses with 400 and writes nothing', async () => {
    const s = await server();
    const [r] = await seedRequests(s.baseUrl, 1);
    const login = await loginAsDj(s.baseUrl);
    for (const status of ['pending', 'deleted', '', 5, null, undefined]) {
      const res = await patchStatus(s.baseUrl, r!.id, status, authHeaders(login));
      assert.equal(res.status, 400, String(status));
    }
    assert.equal(s.repo.getById(r!.id)?.status, 'pending');
  });

  it('returns 404 for an unknown request id', async () => {
    const s = await server();
    const login = await loginAsDj(s.baseUrl);
    const res = await patchStatus(s.baseUrl, 'no-such-id', 'played', authHeaders(login));
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'NOT_FOUND');
  });

  it('requires a matching CSRF token and writes nothing without it (FR-062, T4.07)', async () => {
    const s = await server();
    const [r] = await seedRequests(s.baseUrl, 1);
    const login = await loginAsDj(s.baseUrl);

    const missing = await patchStatus(s.baseUrl, r!.id, 'played', authHeaders(login, false));
    assert.equal(missing.status, 403);
    const wrong = await patchStatus(s.baseUrl, r!.id, 'played', { ...authHeaders(login), 'x-csrf-token': 'not-the-token' });
    assert.equal(wrong.status, 403);
    assert.equal(s.repo.getById(r!.id)?.status, 'pending');
    assert.equal(s.sessions.count(), 1, 'a CSRF failure must not destroy the session');

    const good = await patchStatus(s.baseUrl, r!.id, 'played', authHeaders(login));
    assert.equal(good.status, 200);
    assert.equal(s.repo.getById(r!.id)?.status, 'played');
  });

  it('a token from another session does not work', async () => {
    const s = await server();
    const [r] = await seedRequests(s.baseUrl, 1);
    const a = await loginAsDj(s.baseUrl);
    const b = await loginAsDj(s.baseUrl);
    const res = await patchStatus(s.baseUrl, r!.id, 'played', { cookie: a.cookie, 'x-csrf-token': b.csrfToken });
    assert.equal(res.status, 403);
  });

  it('a read-only GET never requires the CSRF token', async () => {
    const s = await server();
    const login = await loginAsDj(s.baseUrl);
    const res = await fetch(`${s.baseUrl}/api/dj/requests`, { headers: authHeaders(login, false) });
    assert.equal(res.status, 200);
  });
});

describe('queue survives a restart (T-017)', () => {
  it('DJ sees persisted statuses after the server restarts on the same file', async () => {
    const first = await server({ keepFiles: true });
    const [r] = await seedRequests(first.baseUrl, 2);
    const login = await loginAsDj(first.baseUrl);
    await patchStatus(first.baseUrl, r!.id, 'skipped', authHeaders(login));
    const { dir } = first;
    await first.close();

    const second = await server({ dir });
    const login2 = await loginAsDj(second.baseUrl);
    const rows = await listAs(second, authHeaders(login2, false));
    assert.deepEqual(
      rows.map((x) => [x.sequenceNumber, x.status]),
      [
        [1, 'skipped'],
        [2, 'pending'],
      ],
    );
    // Sessions are in SQLite too, so the old cookie keeps working until it expires.
    const reuse = await fetch(`${second.baseUrl}/api/dj/requests`, { headers: authHeaders(login, false) });
    assert.equal(reuse.status, 200);
  });
});

describe('DELETE /api/dj/requests', () => {
  it('removes the chosen rows, or the whole queue, and tells live dashboards', async () => {
    const s = await server();
    const seeded = await seedRequests(s.baseUrl, 3);
    const login = await loginAsDj(s.baseUrl);
    const headers = { ...authHeaders(login), 'content-type': 'application/json' };
    const stream = await openStream(s.baseUrl, authHeaders(login, false));
    await stream.waitFor((events) => events.some((event) => event.event === 'snapshot'));

    const noCsrf = await fetch(`${s.baseUrl}/api/dj/requests`, {
      method: 'DELETE',
      headers: { cookie: login.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [seeded[0]!.id] }),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(s.repo.count(), 3);

    const one = await fetch(`${s.baseUrl}/api/dj/requests`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ ids: [seeded[0]!.id, seeded[0]!.id] }),
    });
    assert.equal(one.status, 200);
    assert.deepEqual(((await one.json()) as { deletedIds: string[] }).deletedIds, [seeded[0]!.id]);
    assert.deepEqual(
      s.repo.list().map((row) => row.sequenceNumber),
      [2, 3],
    );

    const bad = await fetch(`${s.baseUrl}/api/dj/requests`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ ids: ['not-an-id'] }),
    });
    assert.equal(bad.status, 400);
    assert.equal(s.repo.count(), 2);

    const all = await fetch(`${s.baseUrl}/api/dj/requests`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ all: true }),
    });
    assert.equal(all.status, 200);
    assert.deepEqual(
      ((await all.json()) as { deletedIds: string[] }).deletedIds.sort(),
      [seeded[1]!.id, seeded[2]!.id].sort(),
    );
    assert.equal(s.repo.count(), 0);

    await stream.waitFor((events) => events.filter((event) => event.event === 'request.deleted').length >= 2);
    const deleted = stream.events.filter((event) => event.event === 'request.deleted');
    const removed = deleted.flatMap((event) => (event.data as { ids: string[] }).ids);
    assert.deepEqual(removed.sort(), seeded.map((row) => row.id).sort());
    stream.abort();

    const next = await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'Alex', songTitle: 'After clear' });
    assert.equal(next.status, 201);
    assert.equal(((await next.json()) as { request: { sequenceNumber: number } }).request.sequenceNumber, 1);
    const stillLoggedIn = await fetch(`${s.baseUrl}/api/dj/requests`, { headers: authHeaders(login, false) });
    assert.equal(stillLoggedIn.status, 200);
  });
});

describe('audience endpoint is not affected by DJ auth', () => {
  it('POST /api/requests stays public', async () => {
    const s = await server();
    const res = await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'A', songTitle: 'S' });
    assert.equal(res.status, 201);
  });
});
