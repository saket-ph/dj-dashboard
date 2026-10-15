import { describe, expect, it } from 'vitest';
import { createSubmitLock } from './submitLock';

describe('createSubmitLock (T-006)', () => {
  it('allows one in-flight submission and ignores overlapping attempts', () => {
    const lock = createSubmitLock();
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(false);
    expect(lock.tryAcquire()).toBe(false);
    expect(lock.locked).toBe(true);
  });

  it('allows a new attempt after release', () => {
    const lock = createSubmitLock();
    lock.tryAcquire();
    lock.release();
    expect(lock.locked).toBe(false);
    expect(lock.tryAcquire()).toBe(true);
  });
});
