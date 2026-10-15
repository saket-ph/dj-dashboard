import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { encodeSessionCookie } from '../src/auth/session.js';
import {
  authHeaders,
  cookieFrom,
  loginAsDj,
  postJson,
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

describe('password verification (T2.01)', () => {
  it('accepts the correct password and rejects a wrong one', async () => {
    assert.equal(await verifyPassword(TEST_PASSWORD, TEST_PASSWORD_HASH), true);
    assert.equal(await verifyPassword('wrong password', TEST_PASSWORD_HASH), false);
    assert.equal(await verifyPassword('', TEST_PASSWORD_HASH), false);
  });

  it('produces salted hashes and never throws on a malformed stored hash', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    assert.notEqual(a, b);
    assert.ok(!a.includes('same password'));
    for (const bad of ['', 'not-a-hash', 'scrypt:1:1:1:aa', 'scrypt:x:y:z:aa:bb', 'bcrypt:1:1:1:aa:bb']) {
      assert.equal(await verifyPassword('anything', bad), false);
    }
  });
});

describe('POST /api/auth/login (T2.05, T-010, T-011)', () => {
  it('correct password sets an HttpOnly SameSite session cookie and returns a CSRF token', async () => {
    const s = await server();
    const res = await postJson(`${s.baseUrl}/api/auth/login`, { password: TEST_PASSWORD });
    assert.equal(res.status, 200);
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('dj_session='));
    assert.ok(setCookie, 'session cookie must be set');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\//i);
    assert.doesNotMatch(setCookie, /Secure/i, 'not production, so no Secure flag');
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['csrfToken']);
    assert.ok(!text.includes(TEST_PASSWORD) && !text.includes(TEST_PASSWORD_HASH));
    assert.equal(s.sessions.count(), 1);
  });

  it('sets the Secure flag in production (T5.02)', async () => {
    const s = await server({ env: { NODE_ENV: 'production' } });
    const res = await postJson(`${s.baseUrl}/api/auth/login`, { password: TEST_PASSWORD });
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('dj_session='));
    assert.match(setCookie ?? '', /Secure/i);
  });

  it('the cookie contains a random id, not the password or hash', async () => {
    const s = await server();
    const res = await postJson(`${s.baseUrl}/api/auth/login`, { password: TEST_PASSWORD });
    const cookie = decodeURIComponent(cookieFrom(res) ?? '');
    assert.ok(!cookie.includes(TEST_PASSWORD));
    assert.ok(cookie.length > 60);
  });

  it('rejects a wrong password with a generic 401, no cookie, and no session row', async () => {
    const s = await server();
    const res = await postJson(`${s.baseUrl}/api/auth/login`, { password: 'nope' });
    assert.equal(res.status, 401);
    assert.equal(cookieFrom(res), undefined);
    assert.equal(s.sessions.count(), 0);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'UNAUTHENTICATED');
    assert.equal(body.error.message, 'Incorrect password.');
  });

  it('treats missing or non-string passwords exactly like a wrong password', async () => {
    const s = await server();
    for (const body of [{}, { password: '' }, { password: 123 }, { password: null }, { password: 'x'.repeat(300) }]) {
      const res = await postJson(`${s.baseUrl}/api/auth/login`, body);
      assert.equal(res.status, 401);
      assert.equal(cookieFrom(res), undefined);
    }
    assert.equal(s.sessions.count(), 0);
  });

  it('never logs the attempted password or the stored hash (FR-028)', async () => {
    const s = await server();
    await postJson(`${s.baseUrl}/api/auth/login`, { password: 'SuperSecretAttempt123' });
    await postJson(`${s.baseUrl}/api/auth/login`, { password: TEST_PASSWORD });
    const logs = s.logger.lines.join('\n');
    assert.ok(!logs.includes('SuperSecretAttempt123'));
    assert.ok(!logs.includes(TEST_PASSWORD));
    assert.ok(!logs.includes(TEST_PASSWORD_HASH));
    assert.ok(!logs.includes(TEST_SESSION_SECRET));
  });
});

describe('sessions (T2.03, T2.07, T2.08)', () => {
  it('GET /api/auth/session reports unauthenticated without a cookie', async () => {
    const s = await server();
    const res = await fetch(`${s.baseUrl}/api/auth/session`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { authenticated: false });
  });

  it('GET /api/auth/session returns the CSRF token (and no session id) when logged in', async () => {
    const s = await server();
    const login = await loginAsDj(s.baseUrl);
    const res = await fetch(`${s.baseUrl}/api/auth/session`, { headers: authHeaders(login, false) });
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body, { authenticated: true, csrfToken: login.csrfToken });
  });

  it('rejects an expired session (FR-031)', async () => {
    const s = await server({ env: { SESSION_TTL_HOURS: '1' } });
    const login = await loginAsDj(s.baseUrl);
    const ok = await fetch(`${s.baseUrl}/api/dj/requests`, { headers: authHeaders(login, false) });
    assert.equal(ok.status, 200);
    s.clock.advance(61 * 60_000);
    const expired = await fetch(`${s.baseUrl}/api/dj/requests`, { headers: authHeaders(login, false) });
    assert.equal(expired.status, 401);
    const probe = await fetch(`${s.baseUrl}/api/auth/session`, { headers: authHeaders(login, false) });
    assert.deepEqual(await probe.json(), { authenticated: false });
  });

  it('rejects forged, tampered, and unknown session cookies', async () => {
    const s = await server();
    const login = await loginAsDj(s.baseUrl);
    const value = decodeURIComponent(login.cookie.split('=').slice(1).join('='));
    const id = value.slice(0, value.lastIndexOf('.'));
    const forged = [
      'dj_session=garbage',
      `dj_session=${id}.AAAA`,
      `dj_session=${encodeURIComponent(id)}`,
      `dj_session=${encodeURIComponent(encodeSessionCookie('unknown-id', TEST_SESSION_SECRET))}`,
      `dj_session=${encodeURIComponent(encodeSessionCookie(id, 'a-different-secret-entirely'))}`,
    ];
    for (const cookie of forged) {
      const res = await fetch(`${s.baseUrl}/api/dj/requests`, { headers: { cookie } });
      assert.equal(res.status, 401, cookie);
    }
  });

  it('deletes expired sessions when someone logs in', async () => {
    const s = await server({ env: { SESSION_TTL_HOURS: '1' } });
    await loginAsDj(s.baseUrl);
    await loginAsDj(s.baseUrl);
    assert.equal(s.sessions.count(), 2);
    s.clock.advance(2 * 3_600_000);
    await loginAsDj(s.baseUrl);
    assert.equal(s.sessions.count(), 1);
  });
});

describe('POST /api/auth/logout (T2.06, T-010)', () => {
  it('invalidates the session and clears the cookie', async () => {
    const s = await server();
    const login = await loginAsDj(s.baseUrl);
    const res = await postJson(`${s.baseUrl}/api/auth/logout`, {}, authHeaders(login));
    assert.equal(res.status, 200);
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith('dj_session='));
    assert.match(cleared ?? '', /dj_session=;/);
    assert.equal(s.sessions.count(), 0);

    // The old cookie can no longer read the queue.
    const after = await fetch(`${s.baseUrl}/api/dj/requests`, { headers: authHeaders(login, false) });
    assert.equal(after.status, 401);
  });

  it('requires a session and a CSRF token', async () => {
    const s = await server();
    const anon = await postJson(`${s.baseUrl}/api/auth/logout`, {});
    assert.equal(anon.status, 401);

    const login = await loginAsDj(s.baseUrl);
    const noCsrf = await postJson(`${s.baseUrl}/api/auth/logout`, {}, authHeaders(login, false));
    assert.equal(noCsrf.status, 403);
    const wrong = await postJson(`${s.baseUrl}/api/auth/logout`, {}, { ...authHeaders(login), 'x-csrf-token': 'wrong' });
    assert.equal(wrong.status, 403);
    assert.equal(s.sessions.count(), 1, 'a rejected logout must not delete the session');
    const stillIn = await fetch(`${s.baseUrl}/api/dj/requests`, { headers: authHeaders(login, false) });
    assert.equal(stillIn.status, 200);
  });
});
