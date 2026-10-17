export type RequestStatus = 'pending' | 'played' | 'skipped';

/** Public/DJ shape of a song request (camelCase API contract). */
export interface SongRequest {
  id: string;
  sequenceNumber: number;
  requesterName: string;
  songTitle: string;
  artistName: string | null;
  status: RequestStatus;
  createdAt: string;
  updatedAt: string;
  /** YouTube video id from a title search, or null when lookup is off, pending, or found nothing. */
  youtubeVideoId: string | null;
  /** Title YouTube returned for that video, so the DJ can see whether the match is right. */
  youtubeTitle: string | null;
  /** How many people asked for this song. Pending songs with the same title share one row. */
  likeCount: number;
  /** Total length in seconds when YouTube returned one, otherwise null. */
  durationSeconds: number | null;
}

export interface NewSongRequestInput {
  requesterName: string;
  songTitle: string;
  artistName: string | null;
  idempotencyKey: string | null;
}
