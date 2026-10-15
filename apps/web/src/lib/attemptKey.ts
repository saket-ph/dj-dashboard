/**
 * Idempotency keys for audience submissions (FR-012).
 *
 * One key identifies one *attempt*: the same key is reused when the user retries the exact same
 * content after a lost response or a 5xx, so the server can return the original request instead
 * of creating a duplicate. A new key is used after a success and whenever the content changes.
 */
export interface SubmissionPayload {
  requesterName: string;
  songTitle: string;
  artistName: string;
}

export interface AttemptKeys {
  /** Key for sending `payload` now. Stable across retries of identical content. */
  keyFor(payload: SubmissionPayload): string;
  /** Call after a confirmed success so the next submission starts a fresh attempt. */
  succeeded(): void;
}

/** 128 random bits as hex. Uses getRandomValues, which (unlike randomUUID) also works on plain-http pages. */
export function randomKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fingerprint(p: SubmissionPayload): string {
  // Trim like the server does, so whitespace-only edits do not look like a different request.
  return JSON.stringify([p.requesterName.trim(), p.songTitle.trim(), p.artistName.trim()]);
}

export function createAttemptKeys(generate: () => string = randomKey): AttemptKeys {
  let currentKey: string | null = null;
  let currentFingerprint: string | null = null;

  return {
    keyFor(payload) {
      const fp = fingerprint(payload);
      if (currentKey === null || currentFingerprint !== fp) {
        currentKey = generate();
        currentFingerprint = fp;
      }
      return currentKey;
    },
    succeeded() {
      currentKey = null;
      currentFingerprint = null;
    },
  };
}
