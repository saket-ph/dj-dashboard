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
}
