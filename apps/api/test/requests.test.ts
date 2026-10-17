import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { countRows, postJson, startTestServer, type TestServer } from './helpers.js';

const open: TestServer[] = [];
async function server(options?: Parameters<typeof startTestServer>[0]): Promise<TestServer> {
  const s = await startTestServer(options);
  open.push(s);
  return s;
}
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

const valid = { requesterName: 'Alex', songTitle: 'Example Song', artistName: 'Example Artist' };

describe('POST /api/requests (T1.11)', () => {
  it('creates exactly one row and returns 201 with the public shape (T-001)', async () => {
    const s = await server();
    const res = await postJson(`${s.baseUrl}/api/requests`, valid);
    assert.equal(res.status, 201);
    const body = (await res.json()) as { request: Record<string, unknown> };
    assert.equal(body.request.sequenceNumber, 1);
    assert.equal(body.request.requesterName, 'Alex');
    assert.equal(body.request.songTitle, 'Example Song');
    assert.equal(body.request.artistName, 'Example Artist');
    assert.equal(body.request.status, 'pending');
    assert.match(String(body.request.id), /^[0-9a-f-]{36}$/);
    assert.ok(!('updatedAt' in body.request));
    assert.ok(!('youtubeVideoId' in body.request));
    assert.equal(countRows(s.db), 1);
  });

  it('rejects a missing requester name with 400 and creates no row (T-002)', async () => {
    const s = await server();
    const res = await postJson(`${s.baseUrl}/api/requests`, { songTitle: 'S' });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.match(body.error.message, /name/i);
    assert.equal(countRows(s.db), 0);
  });

  it('rejects a missing song title with 400 and creates no row (T-003)', async () => {
    const s = await server();
    const res = await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'Alex' });
    assert.equal(res.status, 400);
    assert.equal(countRows(s.db), 0);
  });

  it('accepts an omitted artist and stores NULL (T-004)', async () => {
    const s = await server();
    const res = await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'Alex', songTitle: 'S' });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { request: { artistName: unknown } };
    assert.equal(body.request.artistName, null);
    const row = s.db.prepare('SELECT artist_name FROM song_requests').get() as { artist_name: unknown };
    assert.equal(row.artist_name, null);
  });

  it('rejects over-long input on the server (T-005)', async () => {
    const s = await server();
    const res = await postJson(`${s.baseUrl}/api/requests`, { ...valid, songTitle: 'x'.repeat(161) });
    assert.equal(res.status, 400);
    assert.equal(countRows(s.db), 0);
  });

  it('rejects malformed JSON and oversized bodies with a safe 400', async () => {
    const s = await server();
    const bad = await postJson(`${s.baseUrl}/api/requests`, '{not json');
    assert.equal(bad.status, 400);
    const big = await postJson(`${s.baseUrl}/api/requests`, { ...valid, songTitle: 'y'.repeat(50_000) });
    assert.equal(big.status, 400);
    assert.equal(countRows(s.db), 0);
    const text = JSON.stringify(await bad.json());
    assert.ok(!/SyntaxError|at .*\.js|node_modules/.test(text));
  });

  it('returns sequence 1 then 2 for successive requests', async () => {
    const s = await server();
    const a = (await (await postJson(`${s.baseUrl}/api/requests`, valid)).json()) as { request: { sequenceNumber: number } };
    const b = (await (await postJson(`${s.baseUrl}/api/requests`, { ...valid, songTitle: 'Second Song' })).json()) as {
      request: { sequenceNumber: number };
    };
    assert.deepEqual([a.request.sequenceNumber, b.request.sequenceNumber], [1, 2]);
  });

  it('never returns success when the database write fails (T-007)', async () => {
    const s = await server();
    // Simulate a real persistence failure: the table disappears out from under the app.
    s.db.exec('DROP TABLE song_requests');
    const res = await postJson(`${s.baseUrl}/api/requests`, valid);
    assert.ok(res.status === 500 || res.status === 503, `got ${res.status}`);
    const text = await res.text();
    const body = JSON.parse(text) as { error: { code: string }; request?: unknown };
    assert.equal(body.error.code, 'PERSISTENCE_ERROR');
    assert.equal(body.request, undefined);
    assert.ok(!/song_requests|SQLITE|SELECT|INSERT|\.sqlite|node_modules/i.test(text), 'must not leak DB details');
  });

  it('does not log the request body, names, or songs (NFR-012)', async () => {
    const s = await server();
    await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'UniqueNameXyz', songTitle: 'UniqueSongXyz' });
    const logs = s.logger.lines.join('\n');
    assert.ok(logs.includes('/requests'));
    assert.ok(!logs.includes('UniqueNameXyz'));
    assert.ok(!logs.includes('UniqueSongXyz'));
  });
});

describe('GET /api/health and /api/config (T1.12, T1.16)', () => {
  it('health returns only a minimal status', async () => {
    const s = await server();
    const res = await fetch(`${s.baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  it('health returns 503 with a minimal body when the database is unusable', async () => {
    const s = await server({
      wrapRepo: (repo) => ({
        ...repo,
        ping: () => {
          throw new Error('disk gone: C:\\secret\\path.sqlite');
        },
      }),
    });
    const res = await fetch(`${s.baseUrl}/api/health`);
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { status: 'error' });
    assert.ok(!text.includes('secret'));
  });

  it('lists songs by request count without requester names', async () => {
    const s = await server();
    await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'Secret Guest', songTitle: 'Once' });
    await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'Secret Guest', songTitle: 'twice' });
    await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'Another', songTitle: 'Twice' });
    const res = await fetch(`${s.baseUrl}/api/songs`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes('Secret Guest'));
    assert.ok(!text.includes('Another'));
    const body = JSON.parse(text) as { songs: { songTitle: string; count: number; liked: boolean }[] };
    assert.equal(body.songs.length, 2);
    assert.equal(body.songs[0]?.count, 2);
    assert.equal(body.songs[0]?.songTitle, 'twice');
    assert.equal(body.songs[0]?.liked, false);
    assert.equal(body.songs[1]?.songTitle, 'Once');
    assert.equal(body.songs[1]?.count, 1);
  });

  it('config exposes only the event title', async () => {
    const s = await server();
    const res = await fetch(`${s.baseUrl}/api/config`);
    assert.deepEqual(await res.json(), { eventTitle: 'Test Night' });
  });

  it('unknown /api paths return the JSON error contract', async () => {
    const s = await server();
    const res = await fetch(`${s.baseUrl}/api/nope`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});

describe('persistence across restarts (T-015, T-017, NFR-004)', () => {
  it('keeps committed requests after the server restarts on the same file', async () => {
    const first = await server({ keepFiles: true });
    const res = await postJson(`${first.baseUrl}/api/requests`, valid);
    assert.equal(res.status, 201);
    const created = ((await res.json()) as { request: { id: string } }).request;
    const { dir } = first;
    await first.close();

    const second = await server({ dir });
    const rows = second.repo.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, created.id);
    assert.ok(!second.logger.lines.some((l) => /new empty database/i.test(l)));
    // Sequence continues rather than restarting.
    const next = (await (await postJson(`${second.baseUrl}/api/requests`, { ...valid, songTitle: 'Later Song' })).json()) as {
      request: { sequenceNumber: number };
    };
    assert.equal(next.request.sequenceNumber, 2);
  });

  it('audience refresh (a fresh GET of the page/config) does not delete requests (T-015)', async () => {
    const s = await server();
    await postJson(`${s.baseUrl}/api/requests`, valid);
    for (let i = 0; i < 3; i++) await fetch(`${s.baseUrl}/api/config`);
    assert.equal(countRows(s.db), 1);
  });
});
