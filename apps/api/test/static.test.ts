// T5.01: one process, one origin. The API serves the built web app and /api together.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeTempDir, postJson, startTestServer, type TestServer } from './helpers.js';

const INDEX = '<!doctype html><html><body><div id="root"></div><script src="/assets/app-abc123.js"></script></body></html>';

describe('single-origin web serving (T5.01)', () => {
  let server: TestServer;
  let distDir: string;

  before(async () => {
    distDir = makeTempDir();
    fs.mkdirSync(path.join(distDir, 'assets'));
    fs.writeFileSync(path.join(distDir, 'index.html'), INDEX);
    fs.writeFileSync(path.join(distDir, 'assets', 'app-abc123.js'), 'console.log("hi")');
    fs.writeFileSync(path.join(path.dirname(distDir), 'secret-outside-dist.txt'), 'TOP SECRET');
    server = await startTestServer({ webDistDir: distDir });
  });

  after(async () => {
    await server.close();
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(distDir), 'secret-outside-dist.txt'), { force: true });
  });

  it('serves the app shell at / and at client routes like /dj (SPA fallback)', async () => {
    for (const p of ['/', '/dj', '/dj/anything', '/some/unknown/page']) {
      const res = await fetch(`${server.baseUrl}${p}`);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      assert.equal(await res.text(), INDEX, p);
    }
  });

  it('serves built assets with their own content type', async () => {
    const res = await fetch(`${server.baseUrl}/assets/app-abc123.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /javascript/);
  });

  it('does not let a stale app shell stick: index.html is revalidated, not cached for an hour', async () => {
    const res = await fetch(`${server.baseUrl}/`);
    const cc = res.headers.get('cache-control') ?? '';
    assert.doesNotMatch(cc, /max-age=[1-9]/);
  });

  it('keeps /api on the same origin and returns JSON 404, never HTML, for unknown API paths', async () => {
    const health = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { status: string }).status, 'ok');

    const res = await fetch(`${server.baseUrl}/api/does-not-exist`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'NOT_FOUND');
  });

  it('accepts a public submission through the same origin the page is served from', async () => {
    const res = await postJson(`${server.baseUrl}/api/requests`, { requesterName: 'Alex', songTitle: 'Same Origin' });
    assert.equal(res.status, 201);
  });

  it('does not turn unsupported methods on page routes into the app shell', async () => {
    const res = await fetch(`${server.baseUrl}/dj`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  });

  it('cannot be tricked into reading files outside the web build (path traversal)', async () => {
    for (const p of ['/..%2Fsecret-outside-dist.txt', '/%2e%2e/secret-outside-dist.txt', '/assets/..%2F..%2Fsecret-outside-dist.txt']) {
      const res = await fetch(`${server.baseUrl}${p}`);
      const text = await res.text();
      assert.doesNotMatch(text, /TOP SECRET/, p);
    }
  });

  it('applies the security headers to the shell too', async () => {
    const res = await fetch(`${server.baseUrl}/`);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('without a web build (API-only development)', () => {
  it('returns a JSON 404 for page paths and still serves the API', async () => {
    const server = await startTestServer();
    try {
      const page = await fetch(`${server.baseUrl}/`);
      assert.equal(page.status, 404);
      assert.equal((await fetch(`${server.baseUrl}/api/health`)).status, 200);
    } finally {
      await server.close();
    }
  });
});
