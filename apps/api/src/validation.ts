import { z } from 'zod';
import type { NewSongRequestInput } from './types.js';

export const LIMITS = {
  requesterName: 80,
  songTitle: 160,
  artistName: 160,
  idempotencyKey: 128,
} as const;

const requesterName = z
  .string({ error: 'Please provide your name.' })
  .trim()
  .min(1, 'Please provide your name.')
  .max(LIMITS.requesterName, `Your name must be ${LIMITS.requesterName} characters or fewer.`);

const songTitle = z
  .string({ error: 'Please provide a song title.' })
  .trim()
  .min(1, 'Please provide a song title.')
  .max(LIMITS.songTitle, `The song title must be ${LIMITS.songTitle} characters or fewer.`);

const artistName = z
  .string({ error: 'The artist name must be text.' })
  .trim()
  .max(LIMITS.artistName, `The artist name must be ${LIMITS.artistName} characters or fewer.`)
  .nullish()
  // Blank optional artist is normalized to NULL (documented decision).
  .transform((v) => (v ? v : null));

const idempotencyKey = z
  .string({ error: 'The request key must be text.' })
  .trim()
  .min(1, 'The request key must not be empty.')
  .max(LIMITS.idempotencyKey, 'The request key is too long.')
  .nullish()
  .transform((v) => (v ? v : null));

const songRequestSchema = z.object(
  { requesterName, songTitle, artistName, idempotencyKey },
  { error: 'Please send a valid request.' },
);

export type ValidationResult =
  | { ok: true; value: NewSongRequestInput }
  | { ok: false; message: string };

/**
 * Server-side validation and normalization of audience input (FR-007, FR-056).
 * Pure: never touches the database. Client-side checks are hints only.
 */
export function validateSongRequest(body: unknown): ValidationResult {
  const parsed = songRequestSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, message: first?.message ?? 'Please check your request and try again.' };
  }
  const { requesterName: name, songTitle: title, artistName: artist, idempotencyKey: key } = parsed.data;
  return {
    ok: true,
    value: { requesterName: name, songTitle: title, artistName: artist, idempotencyKey: key },
  };
}
