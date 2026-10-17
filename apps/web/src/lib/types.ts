export type RequestStatus = 'pending' | 'played' | 'skipped';

export interface SongRequest {
  id: string;
  sequenceNumber: number;
  requesterName: string;
  songTitle: string;
  artistName: string | null;
  status: RequestStatus;
  createdAt: string;
  updatedAt: string;
  /** Present once a YouTube search has been stored. Absent on older snapshots. */
  youtubeVideoId?: string | null;
  youtubeTitle?: string | null;
  /** People who asked for this song. Pending songs with the same title share one row. */
  likeCount?: number;
}
