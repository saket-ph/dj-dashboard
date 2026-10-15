/**
 * In-flight guard for submissions (FR-011). `tryAcquire` returns false while a previous
 * submission is still pending, so rapid double-clicks cannot start a second request even
 * before React re-renders the disabled button.
 */
export interface SubmitLock {
  tryAcquire(): boolean;
  release(): void;
  readonly locked: boolean;
}

export function createSubmitLock(): SubmitLock {
  let locked = false;
  return {
    tryAcquire() {
      if (locked) return false;
      locked = true;
      return true;
    },
    release() {
      locked = false;
    },
    get locked() {
      return locked;
    },
  };
}
