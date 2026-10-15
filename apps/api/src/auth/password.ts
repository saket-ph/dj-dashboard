import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hash format (no "$" so it is safe in .env files and host secret panels):
 *   scrypt:<N>:<r>:<p>:<saltBase64url>:<hashBase64url>
 */
const KEY_LENGTH = 64;
const DEFAULTS = { N: 16384, r: 8, p: 1 } as const;

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p } = DEFAULTS;
  const derived = await scryptAsync(password, salt, KEY_LENGTH, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64url'), derived.toString('base64url')].join(':');
}

/**
 * Verifies a password against a stored hash using a constant-time comparison.
 * Returns false (never throws) for any malformed hash or wrong password.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split(':');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts as [string, string, string, string, string, string];
    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (![N, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await scryptAsync(password, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
