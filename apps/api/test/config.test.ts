import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { audienceUrl, ConfigError, deploymentWarnings, loadConfig, normalizePublicBaseUrl } from '../src/config.js';

const valid = {
  PUBLIC_BASE_URL: 'https://dj.example.test',
  DJ_PASSWORD_HASH: 'scrypt:1:1:1:aa:bb',
  SESSION_SECRET: '0123456789abcdef0123',
};

describe('config (T1.03)', () => {
  it('loads a valid environment with defaults', () => {
    const c = loadConfig(valid);
    assert.equal(c.port, 3000);
    assert.equal(c.sessionTtlHours, 12);
    assert.equal(c.eventTitle, 'DJ Night');
    assert.equal(c.youtubeApiKey, null);
    assert.equal(loadConfig({ ...valid, YOUTUBE_API_KEY: '  abc  ' }).youtubeApiKey, 'abc');
    assert.match(c.databasePath, /dj-requests\.sqlite$/);
  });

  it('refuses to start without SESSION_SECRET or DJ_PASSWORD_HASH', () => {
    assert.throws(() => loadConfig({ ...valid, SESSION_SECRET: '' }), /SESSION_SECRET/);
    assert.throws(() => loadConfig({ ...valid, DJ_PASSWORD_HASH: undefined }), /DJ_PASSWORD_HASH/);
    assert.throws(() => loadConfig({ ...valid, PUBLIC_BASE_URL: undefined }), /PUBLIC_BASE_URL/);
  });

  it('rejects a non-absolute or non-http PUBLIC_BASE_URL', () => {
    assert.throws(() => loadConfig({ ...valid, PUBLIC_BASE_URL: 'dj.example.test' }), ConfigError);
    assert.throws(() => loadConfig({ ...valid, PUBLIC_BASE_URL: 'ftp://dj.example.test' }), ConfigError);
  });

  it('listens on all interfaces unless HOST is set', () => {
    assert.equal(loadConfig(valid).host, null);
    assert.equal(loadConfig({ ...valid, HOST: ' 127.0.0.1 ' }).host, '127.0.0.1');
    assert.equal(loadConfig({ ...valid, HOST: '  ' }).host, null);
  });

  it('rejects in-memory database paths', () => {
    assert.throws(() => loadConfig({ ...valid, DATABASE_PATH: ':memory:' }), /in-memory/);
  });

  it('does not put secret values in error messages', () => {
    try {
      loadConfig({ ...valid, SESSION_SECRET: 'short' });
      assert.fail('should throw');
    } catch (err) {
      assert.ok(!(err as Error).message.includes('short'));
    }
  });

  it('never points the audience URL at the DJ dashboard', () => {
    assert.throws(() => normalizePublicBaseUrl('https://dj.example.test/dj'), /audience page/);
    assert.equal(audienceUrl('https://dj.example.test'), 'https://dj.example.test/');
    assert.equal(audienceUrl(normalizePublicBaseUrl('https://dj.example.test/')), 'https://dj.example.test/');
  });
});

describe('deployment warnings (T5.02)', () => {
  const prod = { ...valid, NODE_ENV: 'production' };

  it('stays quiet outside production', () => {
    assert.deepEqual(deploymentWarnings(loadConfig({ ...valid, PUBLIC_BASE_URL: 'http://dj.example.test' })), []);
  });

  it('warns that login cannot work over plain HTTP in production', () => {
    const w = deploymentWarnings(loadConfig({ ...prod, PUBLIC_BASE_URL: 'http://dj.example.test' }));
    assert.ok(w.some((m) => /not HTTPS/.test(m) && /Secure/.test(m)));
  });

  it('allows production over localhost HTTP without a cookie warning (local smoke test)', () => {
    const w = deploymentWarnings(loadConfig({ ...prod, PUBLIC_BASE_URL: 'http://localhost:3000' }));
    assert.ok(w.every((m) => !/not HTTPS/.test(m)));
  });

  it('warns when HTTPS is used without TRUST_PROXY, because all visitors would share one rate-limit bucket', () => {
    const w = deploymentWarnings(loadConfig({ ...prod, PUBLIC_BASE_URL: 'https://dj.example.test' }));
    assert.ok(w.some((m) => /TRUST_PROXY/.test(m)));
  });

  it('warns in production when no YouTube key is set, and stays quiet when one is', () => {
    const missing = deploymentWarnings(loadConfig({ ...prod, PUBLIC_BASE_URL: 'https://dj.example.test', TRUST_PROXY: 'true' }));
    assert.deepEqual(missing, [
      'YOUTUBE_API_KEY is not set, so new song requests will not get a YouTube link. Requests themselves are still saved.',
    ]);
    const set = deploymentWarnings(
      loadConfig({ ...prod, PUBLIC_BASE_URL: 'https://dj.example.test', TRUST_PROXY: 'true', YOUTUBE_API_KEY: 'super-secret-yt' }),
    );
    assert.deepEqual(set, []);
    assert.ok(!missing.join(' ').includes('super-secret-yt'));
  });

  it('is clean for the recommended production setup', () => {
    assert.deepEqual(
      deploymentWarnings(
        loadConfig({
          ...prod,
          PUBLIC_BASE_URL: 'https://dj.example.test',
          TRUST_PROXY: 'true',
          YOUTUBE_API_KEY: 'yt-test-key',
        }),
      ),
      [],
    );
  });

  it('warns about TRUST_PROXY with plain HTTP (spoofable client address)', () => {
    const w = deploymentWarnings(loadConfig({ ...prod, PUBLIC_BASE_URL: 'http://dj.example.test', TRUST_PROXY: 'true' }));
    assert.ok(w.some((m) => /spoof/.test(m)));
  });

  it('never includes secret values in a warning', () => {
    const all = deploymentWarnings(
      loadConfig({ ...prod, PUBLIC_BASE_URL: 'http://dj.example.test', TRUST_PROXY: 'true' }),
    ).join(' ');
    assert.ok(!all.includes(valid.SESSION_SECRET) && !all.includes(valid.DJ_PASSWORD_HASH));
  });
});
