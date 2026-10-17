import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { postJson, startTestServer, type TestServer } from './helpers.js';

const open: TestServer[] = [];
async function server(): Promise<TestServer> {
  const s = await startTestServer();
  open.push(s);
  return s;
}
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

async function voterCookie(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/songs`);
  const line = res.headers.getSetCookie().find((value) => value.startsWith('dj_voter='));
  assert.ok(line, 'audience list should set a voter cookie');
  return line.split(';')[0] ?? '';
}

async function cheer(baseUrl: string, cookie: string, id: string, move = false) {
  return fetch(`${baseUrl}/api/songs/${id}/like`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ move }),
  });
}

describe('one cheer per browser', () => {
  it('cheers without a name, refuses a second song until confirmed, and takes the cheer back', async () => {
    const s = await server();
    const first = (await (await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'Alex', songTitle: 'Blinding Lights' })).json()) as {
      request: { id: string };
    };
    const second = (await (await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'Alex', songTitle: 'Levitating' })).json()) as {
      request: { id: string };
    };
    const cookie = await voterCookie(s.baseUrl);

    const liked = await cheer(s.baseUrl, cookie, first.request.id);
    assert.equal(liked.status, 200);
    assert.deepEqual(await liked.json(), { liked: true, songTitle: 'Blinding Lights' });

    const blocked = await cheer(s.baseUrl, cookie, second.request.id);
    assert.equal(blocked.status, 409);
    const blockedBody = (await blocked.json()) as { error: { message: string } };
    assert.match(blockedBody.error.message, /one song at a time/);
    assert.match(blockedBody.error.message, /Blinding Lights/);
    assert.match(blockedBody.error.message, /Levitating/);

    const counts = s.repo.popularSongs(cookie.slice('dj_voter='.length));
    assert.equal(counts.find((song) => song.songTitle === 'Blinding Lights')?.count, 2);
    assert.equal(counts.find((song) => song.songTitle === 'Levitating')?.count, 1);

    const moved = await cheer(s.baseUrl, cookie, second.request.id, true);
    assert.equal(moved.status, 200);
    const afterMove = s.repo.popularSongs(cookie.slice('dj_voter='.length));
    assert.equal(afterMove.find((song) => song.songTitle === 'Blinding Lights')?.count, 1);
    assert.equal(afterMove.find((song) => song.songTitle === 'Levitating')?.count, 2);
    assert.equal(afterMove.find((song) => song.songTitle === 'Levitating')?.liked, true);

    const undone = await cheer(s.baseUrl, cookie, second.request.id);
    assert.equal(undone.status, 200);
    assert.equal(((await undone.json()) as { liked: boolean }).liked, false);
    assert.equal(s.repo.popularSongs(null).find((song) => song.songTitle === 'Levitating')?.count, 1);
  });

  it('drops a played song from the audience list so it can no longer be cheered', async () => {
    const s = await server();
    const created = (await (await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'Alex', songTitle: 'Once' })).json()) as {
      request: { id: string };
    };
    const cookie = await voterCookie(s.baseUrl);
    assert.equal((await cheer(s.baseUrl, cookie, created.request.id)).status, 200);
    s.repo.updateStatus(created.request.id, 'played');
    const songs = await fetch(`${s.baseUrl}/api/songs`, { headers: { Cookie: cookie } });
    const body = (await songs.json()) as { songs: { songTitle: string }[] };
    assert.deepEqual(body.songs, []);
    const again = await cheer(s.baseUrl, cookie, created.request.id);
    assert.equal(again.status, 404);
  });

  it('adds a typed duplicate onto the existing pending song', async () => {
    const s = await server();
    const first = await postJson(`${s.baseUrl}/api/requests`, { requesterName: 'Alex', songTitle: 'Blinding Lights' });
    assert.equal(first.status, 201);
    const second = await postJson(`${s.baseUrl}/api/requests`, {
      requesterName: 'Sam',
      songTitle: 'blinding lights',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });
    assert.equal(second.status, 200);
    const retry = await postJson(`${s.baseUrl}/api/requests`, {
      requesterName: 'Sam',
      songTitle: 'blinding lights',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });
    assert.equal(retry.status, 200);
    assert.equal(s.repo.list().length, 1);
    assert.equal(s.repo.list()[0]?.likeCount, 2);
    assert.equal(s.repo.list()[0]?.songTitle, 'Blinding Lights');
  });
});
