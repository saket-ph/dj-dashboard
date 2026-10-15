import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  describeActionError,
  describeLoadError,
  describeLoginError,
  describeSubmitError,
  SESSION_EXPIRED_MESSAGE,
} from './messages';

const CODES = [
  'NETWORK',
  'VALIDATION_ERROR',
  'RATE_LIMITED',
  'CONFLICT',
  'SERVICE_UNAVAILABLE',
  'PERSISTENCE_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INTERNAL_ERROR',
  'SOMETHING_NEW',
];

const LEAKS = /SQLITE|SQL|stack|at \w+\.\w+ \(|node_modules|better-sqlite3|ENOENT|SESSION_SECRET|DJ_PASSWORD|scrypt|\.ts:\d+/i;

const describers = {
  submit: describeSubmitError,
  login: describeLoginError,
  action: describeActionError,
  load: describeLoadError,
};

describe('user-facing failure messages (FR-010, FR-061)', () => {
  for (const [name, fn] of Object.entries(describers)) {
    it(`${name}: every error code yields a non-empty message that never echoes internals`, () => {
      for (const code of CODES) {
        // The server message here simulates a leak; only VALIDATION_ERROR is allowed to pass one through.
        const leaky = 'SQLITE_ERROR: no such table at Object.fn (C:\\app\\node_modules\\x.ts:12)';
        const text = fn(new ApiError(500, code, leaky));
        expect(text.length, `${name}/${code}`).toBeGreaterThan(10);
        if (!(name === 'submit' && code === 'VALIDATION_ERROR')) {
          expect(text, `${name}/${code}`).not.toMatch(LEAKS);
        }
      }
    });

    it(`${name}: non-ApiError values (bugs, thrown strings) still give a safe message`, () => {
      for (const value of [new Error('boom: SQLITE_BUSY'), 'string', null, undefined, 42]) {
        const text = fn(value);
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toMatch(/SQLITE_BUSY|boom/);
      }
    });
  }

  it('a failed submission is never described as saved or successful', () => {
    for (const code of CODES) {
      const text = describeSubmitError(new ApiError(500, code, 'x'));
      expect(text).not.toMatch(/in the queue|success|saved!|sent!/i);
    }
    // And it tells the audience member honestly when nothing was stored.
    expect(describeSubmitError(new ApiError(500, 'PERSISTENCE_ERROR', 'x'))).toMatch(/NOT saved/);
  });

  it('login does not reveal whether the account or password hash exists beyond "incorrect"', () => {
    expect(describeLoginError(new ApiError(401, 'UNAUTHENTICATED', 'x'))).toBe('Incorrect password.');
    expect(describeLoginError(new ApiError(429, 'RATE_LIMITED', 'x'))).toMatch(/wait/i);
  });

  it('network failures say the data was not changed, so retries are safe to reason about', () => {
    expect(describeSubmitError(new ApiError(0, 'NETWORK', 'x'))).toMatch(/still filled in/i);
    expect(describeActionError(new ApiError(0, 'NETWORK', 'x'))).toMatch(/not updated/i);
  });

  it('exposes a plain session-expired notice', () => {
    expect(SESSION_EXPIRED_MESSAGE).toMatch(/log in again/i);
  });
});
