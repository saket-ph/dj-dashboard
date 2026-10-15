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
}

export interface NewSongRequestInput {
  requesterName: string;
  songTitle: string;
  artistName: string | null;
  idempotencyKey: string | null;
}
