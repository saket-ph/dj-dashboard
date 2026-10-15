import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import { initializeDatabase } from '../src/db/database.js';
import { createSongRequestRepository } from '../src/db/requestRepository.js';
import { createMemoryLogger } from '../src/logger.js';
import type { SongRequest } from '../src/types.js';
import {
  authHeaders,
  countRows,
  loginAsDj,
  makeTempDir,
  postJson,
  seedRequests,
  startTestServer,
  TEST_PASSWORD,
  TEST_PASSWORD_HASH,
  TEST_SESSION_SECRET,
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

const valid = { requesterName: 'Alex', songTitle: 'Song' };

describe('submission rate limiting (T4.01, T-020)', () => {
  const limited = { SUBMISSION_RATE_LIMIT_MAX: '3', SUBMISSION_RATE_LIMIT_WINDOW_MS: '60000' };

  it('allows requests under the limit and throttles the next one without inserting', async () => {
    const s = await server({ env: limited });
    for (let i = 0; i < 3; i++) {
      assert.equal((await postJson(`${s.baseUrl}/api/requests`, valid)).status, 201);
    }
    const res = await postJson(`${s.baseUrl}/api/requests`, valid);
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.equal(countRows(s.db), 3, 'a throttled request must not create a row');
  });

  it('counts invalid submissions too, so spam cannot probe validation for free', async () => {
    const s = await server({ env: limited });
    for (let i = 0; i < 3; i++) await postJson(`${s.baseUrl}/api/requests`, { requesterName: '', songTitle: '' });
    assert.equal((await postJson(`${s.baseUrl}/api/requests`, valid)).status, 429);
  });

  it('allows submissions again after the window passes', async () => {
    const s = await server({ env: limited });
    for (let i = 0; i < 4; i++) await postJson(`${s.baseUrl}/api/requests`, valid);
    assert.equal((await postJson(`${s.baseUrl}/api/requests`, valid)).status, 429);
    s.clock.advance(60_001);
    assert.equal((await postJson(`${s.baseUrl}/api/requests`, valid)).status, 201);
  });

  it('limits each client IP separately when behind a trusted proxy', async () => {
    const s = await server({ env: { ...limited, TRUST_PROXY: 'true' } });
    const as = (ip: string) => ({ 'x-forwarded-for': ip });
    for (let i = 0; i < 4; i++) await postJson(`${s.baseUrl}/api/requests`, valid, as('203.0.113.1'));
    assert.equal((await postJson(`${s.baseUrl}/api/requests`, valid, as('203.0.113.1'))).status, 429);
    assert.equal((await postJson(`${s.baseUrl}/api/requests`, valid, as('203.0.113.2'))).status, 201);
  });

  it('does not rate-limit the DJ endpoints or reads', async () => {
    const s = await server({ env: limited });
    const login = await loginAsDj(s.baseUrl);
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${s.baseUrl}/api/dj/requests`, { headers: authHeaders(login, false) });
      assert.equal(res.status, 200);
    }
  });
});

describe('login rate limiting (T4.02, T-020)', () => {
  const limited = { LOGIN_RATE_LIMIT_MAX: '3', LOGIN_RATE_LIMIT_WINDOW_MS: '600000' };
  const attempt = (s: TestServer, password: string) => postJson(`${s.baseUrl}/api/auth/login`, { password });

  it('throttles repeated wrong passwords, even if a later password is correct', async () => {
    const s = await server({ env: limited });
    for (let i = 0; i < 3; i++) assert.equal((await attempt(s, 'wrong')).status, 401);
    const blocked = await attempt(s, TEST_PASSWORD);
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, 'RATE_LIMITED');
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.equal(s.sessions.count(), 0, 'no session may be created while throttled');
  });

  it('works again once the window has passed', async () => {
    const s = await server({ env: limited });
    for (let i = 0; i < 3; i++) await attempt(s, 'wrong');
    assert.equal((await attempt(s, TEST_PASSWORD)).status, 429);
    s.clock.advance(600_001);
    assert.equal((await attempt(s, TEST_PASSWORD)).status, 200);
  });

  it('a successful login clears the failure count', async () => {
    const s = await server({ env: limited });
    await attempt(s, 'wrong');
    await attempt(s, 'wrong');
    assert.equal((await attempt(s, TEST_PASSWORD)).status, 200);
    // Two more failures are fine again because the success reset the counter.
    assert.equal((await attempt(s, 'wrong')).status, 401);
    assert.equal((await attempt(s, 'wrong')).status, 401);
  });

  it('successful logins alone never trigger the limiter', async () => {
    const s = await server({ env: limited });
    for (let i = 0; i < 10; i++) assert.equal((await attempt(s, TEST_PASSWORD)).status, 200);
  });

  it('does not log attempted passwords, hashes, cookies, or the session secret (T4.12)', async () => {
    const s = await server({ env: limited });
    for (let i = 0; i < 4; i++) await attempt(s, `guess-number-${i}-SECRET`);
    const login = await loginAsDj(s.baseUrl, TEST_PASSWORD).catch(() => null);
    void login;
    const logs = s.logger.lines.join('\n');
    assert.ok(!/guess-number-\d-SECRET/.test(logs));
    assert.ok(!logs.includes(TEST_PASSWORD));
    assert.ok(!logs.includes(TEST_PASSWORD_HASH));
    assert.ok(!logs.includes(TEST_SESSION_SECRET));
    assert.ok(!/dj_session=/i.test(logs));
  });
});

describe('idempotency keys (T4.04, FR-012)', () => {
  const key = 'client-key-0001';

  it('replaying the same key and payload returns the original request and inserts nothing', async () => {
    const s = await server();
    const first = await postJson(`${s.baseUrl}/api/requests`, { ...valid, idempotencyKey: key });
    assert.equal(first.status, 201);
    const a = ((await first.json()) as { request: SongRequest }).request;

    const replay = await postJson(`${s.baseUrl}/api/requests`, { ...valid, idempotencyKey: key });
    assert.equal(replay.status, 200);
    const b = ((await replay.json()) as { request: SongRequest }).request;
    assert.equal(b.id, a.id);
    assert.equal(b.sequenceNumber, a.sequenceNumber);
    assert.equal(countRows(s.db), 1);
  });

  it('treats whitespace-only differences as the same payload (normalized before comparing)', async () => {
    const s = await server();
    await postJson(`${s.baseUrl}/api/requests`, { ...valid, idempotencyKey: key });
    const replay = await postJson(`${s.baseUrl}/api/requests`, {
      requesterName: '  Alex ',
      songTitle: ' Song  ',
      idempotencyKey: key,
    });
    assert.equal(replay.status, 200);
    assert.equal(countRows(s.db), 1);
  });

  it('rejects the same key with a different payload with 409 and changes nothing', async () => {
    const s = await server();
    const first = await postJson(`${s.baseUrl}/api/requests`, { ...valid, idempotencyKey: key });
    const original = ((await first.json()) as { request: SongRequest }).request;

    const clash = await postJson(`${s.baseUrl}/api/requests`, { ...valid, songTitle: 'Different', idempotencyKey: key });
    assert.equal(clash.status, 409);
    assert.equal(((await clash.json()) as { error: { code: string } }).error.code, 'CONFLICT');
    assert.equal(countRows(s.db), 1);
    assert.equal(s.repo.getById(original.id)?.songTitle, 'Song');
  });

  it('different keys always insert; requests without a key always insert', async () => {
    const s = await server();
    await postJson(`${s.baseUrl}/api/requests`, { ...valid, idempotencyKey: 'key-a' });
    await postJson(`${s.baseUrl}/api/requests`, { ...valid, idempotencyKey: 'key-b' });
    await postJson(`${s.baseUrl}/api/requests`, valid);
    await postJson(`${s.baseUrl}/api/requests`, valid);
    assert.equal(countRows(s.db), 4);
  });

  it('overlapping retries of one key create exactly one row', async () => {
    const s = await server();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => postJson(`${s.baseUrl}/api/requests`, { ...valid, idempotencyKey: 'burst-key' })),
    );
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses.filter((x) => x === 201).length, 1);
    assert.equal(statuses.filter((x) => x === 200).length, 9);
    assert.equal(countRows(s.db), 1);
  });

  it('rejects an over-long or empty key', async () => {
    const s = await server();
    assert.equal((await postJson(`${s.baseUrl}/api/requests`, { ...valid, idempotencyKey: 'k'.repeat(129) })).status, 400);
    assert.equal((await postJson(`${s.baseUrl}/api/requests`, { ...valid, idempotencyKey: '   ' })).status, 400);
    assert.equal(countRows(s.db), 0);
  });
});

describe('concurrent sequence assignment (T4.06, T-008, NFR-005)', () => {
  it('a burst of parallel HTTP submissions gets unique, contiguous sequences', async () => {
    const s = await server();
    const N = 60;
    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        postJson(`${s.baseUrl}/api/requests`, { requesterName: `G${i}`, songTitle: `Burst ${i}` }),
      ),
    );
    assert.ok(responses.every((r) => r.status === 201));
    const sequences = (await Promise.all(responses.map(async (r) => ((await r.json()) as { request: SongRequest }).request.sequenceNumber)))
      .sort((a, b) => a - b);
    assert.deepEqual(sequences, Array.from({ length: N }, (_, i) => i + 1));
    assert.equal(countRows(s.db), N);
  });

  it('separate database connections writing at once never share a sequence (write contention)', async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'contention.sqlite');
    const { db } = initializeDatabase(dbPath, createMemoryLogger());

    const WORKERS = 4;
    const PER_WORKER = 25;
    const results = await Promise.all(
      Array.from(
        { length: WORKERS },
        (_, i) =>
          new Promise<{ sequences: number[]; errors: string[] }>((resolve, reject) => {
            const worker = new Worker(new URL('./workers/insert-worker.ts', import.meta.url), {
              workerData: { dbPath, count: PER_WORKER, label: `w${i}` },
            });
            worker.once('message', resolve);
            worker.once('error', reject);
          }),
      ),
    );

    const errors = results.flatMap((r) => r.errors);
    assert.deepEqual(errors, [], 'no insert may fail under contention');
    const all = results.flatMap((r) => r.sequences).sort((a, b) => a - b);
    assert.equal(all.length, WORKERS * PER_WORKER);
    assert.deepEqual(all, Array.from({ length: WORKERS * PER_WORKER }, (_, i) => i + 1), 'unique and gap-free');
    assert.equal(createSongRequestRepository(db).count(), WORKERS * PER_WORKER);
    db.close();
  });

  it('list order follows sequence numbers, never timestamps', async () => {
    const s = await server();
    await seedRequests(s.baseUrl, 5);
    // Make timestamps run backwards relative to sequence.
    s.db.exec("UPDATE song_requests SET created_at = printf('2026-01-01T00:00:0%d.000Z', 6 - sequence_number)");
    const login = await loginAsDj(s.baseUrl);
    const res = await fetch(`${s.baseUrl}/api/dj/requests`, { headers: authHeaders(login, false) });
    const rows = ((await res.json()) as { requests: SongRequest[] }).requests;
    assert.deepEqual(
      rows.map((r) => r.sequenceNumber),
      [1, 2, 3, 4, 5],
    );
  });
});

describe('protected endpoints reject unauthenticated access (T4.15, NFR-007)', () => {
  it('every DJ route and logout rejects callers without a session', async () => {
    const s = await server();
    const [r] = await seedRequests(s.baseUrl, 1);
    const calls: Array<[string, string, unknown?]> = [
      ['GET', '/api/dj/requests'],
      ['GET', '/api/dj/requests/stream'],
      ['PATCH', `/api/dj/requests/${r!.id}/status`, { status: 'played' }],
      ['GET', '/api/dj/does-not-exist'],
      ['POST', '/api/auth/logout', {}],
    ];
    for (const [method, url, body] of calls) {
      const res = await fetch(`${s.baseUrl}${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(res.status, 401, `${method} ${url}`);
      const text = await res.text();
      assert.ok(!text.includes('Guest 1') && !text.includes('Song 1'), `${method} ${url} leaked data`);
    }
    assert.equal(s.repo.getById(r!.id)?.status, 'pending');
  });
});

describe('security headers (T4.05 defense in depth)', () => {
  it('sends a strict CSP and anti-sniffing headers on API responses', async () => {
    const s = await server();
    const res = await fetch(`${s.baseUrl}/api/health`);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

describe('unsafe text is stored and returned as plain data (T-025)', () => {
  it('round-trips markup and SQL-looking text unchanged as JSON strings', async () => {
    const s = await server();
    const nasty = {
      requesterName: '<img src=x onerror=alert(1)>',
      songTitle: '<script>alert("xss")</script>',
      artistName: "'); DROP TABLE song_requests;--",
    };
    const res = await postJson(`${s.baseUrl}/api/requests`, nasty);
    assert.equal(res.status, 201);
    const login = await loginAsDj(s.baseUrl);
    const list = await fetch(`${s.baseUrl}/api/dj/requests`, { headers: authHeaders(login, false) });
    assert.match(list.headers.get('content-type') ?? '', /application\/json/);
    const rows = ((await list.json()) as { requests: SongRequest[] }).requests;
    assert.equal(rows[0]?.songTitle, nasty.songTitle);
    assert.equal(rows[0]?.requesterName, nasty.requesterName);
    assert.equal(rows[0]?.artistName, nasty.artistName);
    assert.equal(countRows(s.db), 1);
  });
});
