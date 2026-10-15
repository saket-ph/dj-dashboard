import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS, validateSongRequest } from '../src/validation.js';

describe('validateSongRequest (T1.09)', () => {
  it('accepts a valid request and trims whitespace', () => {
    const r = validateSongRequest({ requesterName: '  Alex ', songTitle: ' Song ', artistName: ' Band ' });
    assert.ok(r.ok);
    assert.deepEqual(r.value, { requesterName: 'Alex', songTitle: 'Song', artistName: 'Band', idempotencyKey: null });
  });

  it('rejects a missing or blank requester name (T-002)', () => {
    for (const body of [{ songTitle: 'S' }, { requesterName: '   ', songTitle: 'S' }]) {
      const r = validateSongRequest(body);
      assert.ok(!r.ok);
      assert.match(r.message, /name/i);
    }
  });

  it('rejects a missing or blank song title (T-003)', () => {
    for (const body of [{ requesterName: 'A' }, { requesterName: 'A', songTitle: '  ' }]) {
      const r = validateSongRequest(body);
      assert.ok(!r.ok);
      assert.match(r.message, /song title/i);
    }
  });

  it('normalizes omitted, null, and blank artist to null (T-004)', () => {
    for (const artistName of [undefined, null, '', '   ']) {
      const r = validateSongRequest({ requesterName: 'A', songTitle: 'S', artistName });
      assert.ok(r.ok);
      assert.equal(r.value.artistName, null);
    }
  });

  it('rejects over-long fields (T-005)', () => {
    assert.ok(!validateSongRequest({ requesterName: 'a'.repeat(LIMITS.requesterName + 1), songTitle: 'S' }).ok);
    assert.ok(!validateSongRequest({ requesterName: 'A', songTitle: 's'.repeat(LIMITS.songTitle + 1) }).ok);
    assert.ok(
      !validateSongRequest({ requesterName: 'A', songTitle: 'S', artistName: 'x'.repeat(LIMITS.artistName + 1) }).ok,
    );
    // Exactly at the limit is fine.
    assert.ok(validateSongRequest({ requesterName: 'a'.repeat(LIMITS.requesterName), songTitle: 'S' }).ok);
  });

  it('rejects non-string types and non-object bodies', () => {
    assert.ok(!validateSongRequest({ requesterName: 5, songTitle: 'S' }).ok);
    assert.ok(!validateSongRequest({ requesterName: 'A', songTitle: { x: 1 } }).ok);
    assert.ok(!validateSongRequest({ requesterName: 'A', songTitle: 'S', artistName: 7 }).ok);
    assert.ok(!validateSongRequest(null).ok);
    assert.ok(!validateSongRequest('nope').ok);
    assert.ok(!validateSongRequest(undefined).ok);
  });

  it('ignores unknown fields so no extra personal data is collected', () => {
    const r = validateSongRequest({ requesterName: 'A', songTitle: 'S', phone: '123', email: 'a@b.c' });
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.value).sort(), ['artistName', 'idempotencyKey', 'requesterName', 'songTitle']);
  });
});
