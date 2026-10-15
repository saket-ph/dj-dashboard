import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import jsQRModule from 'jsqr';
import { PNG } from 'pngjs';
import { audienceUrl } from '../src/config.js';
import { generateAudienceQr } from '../src/qr.js';
import { makeTempDir } from './helpers.js';

// jsqr ships CommonJS; under NodeNext the callable is on `.default`.
type JsQr = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
const jsQR = ((jsQRModule as unknown as { default?: JsQr }).default ?? (jsQRModule as unknown as JsQr)) as JsQr;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function decode(pngPath: string): string | null {
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return result?.data ?? null;
}

describe('static audience QR code (T1.20, T-019)', () => {
  it('decodes to exactly the configured audience URL and not /dj', async () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const out = await generateAudienceQr('https://dj.example.test', dir);
    const payload = decode(out.pngPath);
    assert.equal(payload, 'https://dj.example.test/');
    assert.equal(payload, audienceUrl('https://dj.example.test'));
    assert.equal(new URL(payload).pathname, '/', 'must open the audience page, not /dj');
    assert.ok(fs.readFileSync(out.svgPath, 'utf8').includes('<svg'));
  });

  it('is deterministic: the same URL always yields the same payload (stable across restarts)', async () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const a = decode((await generateAudienceQr('https://dj.example.test', path.join(dir, 'a'))).pngPath);
    const b = decode((await generateAudienceQr('https://dj.example.test', path.join(dir, 'b'))).pngPath);
    assert.equal(a, b);
  });

  it('contains no token, request id, or session data', async () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const payload = decode((await generateAudienceQr('https://dj.example.test/', dir)).pngPath);
    assert.equal(payload, 'https://dj.example.test/');
    assert.ok(!/[?#]/.test(payload ?? ''));
  });
});
