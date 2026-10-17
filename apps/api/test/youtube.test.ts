import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { createSongRequestRepository } from '../src/db/requestRepository.js';
import {
  createYoutubeClient,
  parseIsoDuration,
  songSearchQuery,
  YoutubeLookupError,
  youtubeWatchUrl,
  type YoutubeMatch,
} from '../src/youtube.js';
import { makeTempDir, postJson, startTestServer, type TestServer } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('YouTube search client', () => {
  it('queries by song title and artist and keeps only a real video id', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      seen.push(String(input));
      return jsonResponse(200, {
        items: [{ id: { videoId: 'dQw4w9WgXcQ' }, snippet: { title: '  Example   Song  ' } }],
      });
    };
    const match = await createYoutubeClient('super-secret-yt', fetchImpl).search(songSearchQuery('Example Song', 'Example Artist'));
    assert.deepEqual(match, { videoId: 'dQw4w9WgXcQ', title: 'Example Song', durationSeconds: null });
    const url = new URL(seen[0]!);
    assert.equal(url.searchParams.get('q'), 'Example Song Example Artist');
    assert.equal(url.searchParams.get('type'), 'video');
    assert.equal(url.searchParams.get('maxResults'), '1');
    assert.equal(url.searchParams.get('key'), 'super-secret-yt');
    assert.equal(songSearchQuery('Only Title', null), 'Only Title');
    assert.equal(youtubeWatchUrl('dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(youtubeWatchUrl('https://evil.example'), null);
  });

  it('returns null when the result is missing or not a video id', async () => {
    const client = createYoutubeClient('k', async () => jsonResponse(200, { items: [{ id: { videoId: 'not a video' } }] }));
    assert.equal(await client.search('Song'), null);
    const empty = createYoutubeClient('k', async () => jsonResponse(200, { items: [] }));
    assert.equal(await empty.search('Song'), null);
  });

  it('stores the video length from YouTube', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/videos')) {
        return jsonResponse(200, { items: [{ id: 'dQw4w9WgXcQ', contentDetails: { duration: 'PT4M5S' } }] });
      }
      return jsonResponse(200, { items: [{ id: { videoId: 'dQw4w9WgXcQ' }, snippet: { title: 'Song' } }] });
    };
    const match = await createYoutubeClient('k', fetchImpl).search('Song');
    assert.equal(match?.durationSeconds, 245);
    assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
    assert.equal(parseIsoDuration('PT45S'), 45);
    assert.equal(parseIsoDuration('not-a-duration'), null);
  });

  it('reports an HTTP failure by status only', async () => {
    const client = createYoutubeClient('super-secret-yt', async () => jsonResponse(403, { error: { message: 'key=super-secret-yt' } }));
    await assert.rejects(client.search('Song'), (err: unknown) => {
      assert.ok(err instanceof YoutubeLookupError);
      assert.equal(err.status, 403);
      assert.equal(err.message, 'YouTube lookup failed');
      assert.ok(!err.message.includes('super-secret-yt'));
      return true;
    });
  });
});

describe('YouTube columns on an existing queue', () => {
  it('adds the columns without changing the song that was already stored', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const db = new Database(path.join(dir, 'old.sqlite'));
    db.exec(`
      CREATE TABLE song_requests (
        id TEXT PRIMARY KEY,
        sequence_number INTEGER NOT NULL UNIQUE,
        requester_name TEXT NOT NULL,
        song_title TEXT NOT NULL,
        artist_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        idempotency_key TEXT UNIQUE
      );
    `);
    db.prepare(
      `INSERT INTO song_requests
         (id, sequence_number, requester_name, song_title, artist_name, status, created_at, updated_at, idempotency_key)
       VALUES ('id-1', 1, 'Alex', 'Old Song', NULL, 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`,
    ).run();

    applySchema(db);
    const repo = createSongRequestRepository(db);
    const existing = repo.getById('id-1');
    assert.equal(existing?.songTitle, 'Old Song');
    assert.equal(existing?.youtubeVideoId, null);
    assert.equal(existing?.status, 'pending');

    const saved = repo.setYoutube('id-1', 'dQw4w9WgXcQ', '  Official\nVideo  ');
    assert.equal(saved?.youtubeVideoId, 'dQw4w9WgXcQ');
    assert.equal(saved?.youtubeTitle, 'Official Video');
    assert.equal(saved?.status, 'pending');
    assert.equal(saved?.updatedAt, existing?.updatedAt);

    assert.equal(repo.setYoutube('id-1', 'abcdefghijk', 'Other'), undefined);
    assert.equal(repo.getById('id-1')?.youtubeVideoId, 'dQw4w9WgXcQ');
    assert.equal(repo.setYoutube('id-1', 'javascript:alert(1)', 'x'), undefined);

    const played = repo.updateStatus('id-1', 'played');
    assert.equal(played?.status, 'played');
    assert.equal(played?.youtubeVideoId, 'dQw4w9WgXcQ');
    db.close();
  });
});

describe('POST /api/requests YouTube lookup', () => {
  const open: TestServer[] = [];
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close();
  });

  it('returns 201 before the lookup finishes, then stores the video and keeps the key out of the logs', async () => {
    let release: (match: YoutubeMatch | null) => void = () => {};
    const gate = new Promise<YoutubeMatch | null>((resolve) => {
      release = resolve;
    });
    const queries: string[] = [];
    const s = await startTestServer({
      appDeps: () => ({
        youtube: {
          search: (query) => {
            queries.push(query);
            return gate;
          },
        },
      }),
    });
    open.push(s);

    const res = await postJson(`${s.baseUrl}/api/requests`, {
      requesterName: 'Alex',
      songTitle: 'Example Song',
      artistName: 'Example Artist',
      idempotencyKey: 'same-song',
    });
    try {
      assert.equal(res.status, 201);
      const body = (await res.json()) as { request: Record<string, unknown> };
      assert.ok(!('youtubeVideoId' in body.request));
      assert.equal(s.repo.getById(String(body.request.id))?.youtubeVideoId, null);

      release({ videoId: 'dQw4w9WgXcQ', title: 'Example Song (Official)' });
      await s.whenYoutubeIdle();

      const stored = s.repo.list()[0];
      assert.equal(stored?.youtubeVideoId, 'dQw4w9WgXcQ');
      assert.equal(stored?.youtubeTitle, 'Example Song (Official)');
      assert.deepEqual(queries, ['Example Song Example Artist']);

      const retry = await postJson(`${s.baseUrl}/api/requests`, {
        requesterName: 'Alex',
        songTitle: 'Example Song',
        artistName: 'Example Artist',
        idempotencyKey: 'same-song',
      });
      assert.equal(retry.status, 200);
      await s.whenYoutubeIdle();
      assert.equal(queries.length, 1, 'a retry of the same request must not search YouTube again');
      assert.ok(!s.logger.lines.join('\n').includes('super-secret'));
    } finally {
      release(null);
    }
  });

  it('still saves the request when YouTube throws, and does not log the error text', async () => {
    const s = await startTestServer({
      appDeps: () => ({
        youtube: {
          search: async () => {
            throw new Error('connect ECONNREFUSED key=super-secret-yt');
          },
        },
      }),
    });
    open.push(s);
    const res = await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'Alex', songTitle: 'Example Song' });
    assert.equal(res.status, 201);
    await s.whenYoutubeIdle();
    assert.equal(s.repo.list()[0]?.youtubeVideoId, null);
    assert.equal(s.repo.list()[0]?.songTitle, 'Example Song');
    const lines = s.logger.lines.join('\n');
    assert.match(lines, /youtube lookup failed/);
    assert.ok(!lines.includes('super-secret-yt'));
    assert.ok(!lines.includes('ECONNREFUSED'));
  });
});
