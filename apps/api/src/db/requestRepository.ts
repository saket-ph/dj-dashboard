import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { NewSongRequestInput, RequestStatus, SongRequest } from '../types.js';

/**
 * Data-access boundary for song requests (FR-045, FR-055).
 * All SQL for `song_requests` lives here and every statement is parameterized (FR-057).
 * Route handlers depend on this interface only, so the storage engine can change later.
 */
export interface SongRequestRepository {
  /**
   * Allocates the next sequence number and inserts the row in ONE write transaction.
   * Resolves only after commit. If an idempotency key already exists, returns the stored
   * row with `replayed: true` (and `payloadMatches` telling whether the payload is identical)
   * without inserting anything.
   */
  create(input: NewSongRequestInput): CreateResult;
  /** All requests ordered by sequence_number ASC. */
  list(): SongRequest[];
  getById(id: string): SongRequest | undefined;
  /** Updates status and updated_at only. Sequence and identity never change. */
  updateStatus(id: string, status: Exclude<RequestStatus, 'pending'>): SongRequest | undefined;
  count(): number;
  /** Cheap liveness probe for /api/health. Throws if the database is unusable. */
  ping(): void;
}

export interface CreateResult {
  request: SongRequest;
  /** True when an existing row was returned because the idempotency key was reused. */
  replayed: boolean;
  /** Only meaningful when replayed; false means the key was reused with a different payload. */
  payloadMatches: boolean;
}

interface RequestRow {
  id: string;
  sequence_number: number;
  requester_name: string;
  song_title: string;
  artist_name: string | null;
  status: RequestStatus;
  created_at: string;
  updated_at: string;
  idempotency_key: string | null;
}

function toSongRequest(row: RequestRow): SongRequest {
  return {
    id: row.id,
    sequenceNumber: row.sequence_number,
    requesterName: row.requester_name,
    songTitle: row.song_title,
    artistName: row.artist_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS =
  'id, sequence_number, requester_name, song_title, artist_name, status, created_at, updated_at, idempotency_key';

export function createSongRequestRepository(db: Database.Database): SongRequestRepository {
  const selectByKey = db.prepare(`SELECT ${COLUMNS} FROM song_requests WHERE idempotency_key = ?`);
  const selectMax = db.prepare('SELECT COALESCE(MAX(sequence_number), 0) AS max_seq FROM song_requests');
  const insertRow = db.prepare(
    `INSERT INTO song_requests
       (id, sequence_number, requester_name, song_title, artist_name, status, created_at, updated_at, idempotency_key)
     VALUES (@id, @sequence_number, @requester_name, @song_title, @artist_name, 'pending', @created_at, @created_at, @idempotency_key)`,
  );
  const selectAll = db.prepare(`SELECT ${COLUMNS} FROM song_requests ORDER BY sequence_number ASC`);
  const selectOne = db.prepare(`SELECT ${COLUMNS} FROM song_requests WHERE id = ?`);
  const updateStatusStmt = db.prepare('UPDATE song_requests SET status = ?, updated_at = ? WHERE id = ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM song_requests');

  /**
   * "Arrival order" is the order in which successful commits were serialized by SQLite's
   * single writer lock (BEGIN IMMEDIATE), not a measurement of who tapped first on a phone.
   * Sequence allocation (MAX + 1) and the insert share one write transaction, so two
   * concurrent submissions can never claim the same sequence number; UNIQUE is the backstop.
   */
  const createTx = db.transaction((input: NewSongRequestInput): CreateResult => {
    if (input.idempotencyKey !== null) {
      const existing = selectByKey.get(input.idempotencyKey) as RequestRow | undefined;
      if (existing) {
        const payloadMatches =
          existing.requester_name === input.requesterName &&
          existing.song_title === input.songTitle &&
          existing.artist_name === input.artistName;
        return { request: toSongRequest(existing), replayed: true, payloadMatches };
      }
    }

    const { max_seq } = selectMax.get() as { max_seq: number };
    const now = new Date().toISOString();
    const row: RequestRow = {
      id: randomUUID(),
      sequence_number: max_seq + 1,
      requester_name: input.requesterName,
      song_title: input.songTitle,
      artist_name: input.artistName,
      status: 'pending',
      created_at: now,
      updated_at: now,
      idempotency_key: input.idempotencyKey,
    };
    insertRow.run({
      id: row.id,
      sequence_number: row.sequence_number,
      requester_name: row.requester_name,
      song_title: row.song_title,
      artist_name: row.artist_name,
      created_at: row.created_at,
      idempotency_key: row.idempotency_key,
    });
    return { request: toSongRequest(row), replayed: false, payloadMatches: true };
  });

  return {
    create: (input) => createTx.immediate(input),
    list: () => (selectAll.all() as RequestRow[]).map(toSongRequest),
    getById: (id) => {
      const row = selectOne.get(id) as RequestRow | undefined;
      return row ? toSongRequest(row) : undefined;
    },
    updateStatus: (id, status) => {
      const tx = db.transaction(() => {
        const result = updateStatusStmt.run(status, new Date().toISOString(), id);
        if (result.changes === 0) return undefined;
        return toSongRequest(selectOne.get(id) as RequestRow);
      });
      return tx.immediate();
    },
    count: () => (countStmt.get() as { n: number }).n,
    ping: () => {
      db.prepare('SELECT 1').get();
    },
  };
}
