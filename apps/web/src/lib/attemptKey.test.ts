import { describe, expect, it } from 'vitest';
import { createAttemptKeys, randomKey } from './attemptKey';

const payload = { requesterName: 'Alex', songTitle: 'Song', artistName: 'Band' };

function counter() {
  let n = 0;
  return () => `key-${++n}`;
}

describe('attempt keys (FR-012, T4.03)', () => {
  it('reuses the same key when the identical content is retried', () => {
    const keys = createAttemptKeys(counter());
    const first = keys.keyFor(payload);
    expect(keys.keyFor({ ...payload })).toBe(first);
    expect(keys.keyFor({ ...payload })).toBe(first);
  });

  it('issues a new key as soon as any field is edited', () => {
    const keys = createAttemptKeys(counter());
    const first = keys.keyFor(payload);
    const edited = keys.keyFor({ ...payload, songTitle: 'Other song' });
    expect(edited).not.toBe(first);
    // And that edited attempt is itself stable for retries.
    expect(keys.keyFor({ ...payload, songTitle: 'Other song' })).toBe(edited);
  });

  it('issues a new key after a confirmed success, even for identical content', () => {
    const keys = createAttemptKeys(counter());
    const first = keys.keyFor(payload);
    keys.succeeded();
    expect(keys.keyFor(payload)).not.toBe(first);
  });

  it('ignores whitespace-only edits (the server trims too)', () => {
    const keys = createAttemptKeys(counter());
    const first = keys.keyFor(payload);
    expect(keys.keyFor({ ...payload, requesterName: '  Alex ' })).toBe(first);
  });

  it('generates distinct 128-bit hex keys by default', () => {
    const seen = new Set(Array.from({ length: 200 }, () => randomKey()));
    expect(seen.size).toBe(200);
    for (const k of seen) expect(k).toMatch(/^[0-9a-f]{32}$/);
  });
});
