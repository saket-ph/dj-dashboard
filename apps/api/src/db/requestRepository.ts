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
  /**
   * Pending songs only, one row per title, most liked first.
   * `liked` is true when this browser's voter id currently cheers for that song.
   */
  popularSongs(voterId: string | null): PopularSong[];
  /**
   * Adds, removes, or moves this voter's single cheer.
   * A second song is refused until `move` is true. Played and skipped songs cannot be cheered.
   */
  cheer(voterId: string, songId: string, move: boolean): CheerOutcome;
  getById(id: string): SongRequest | undefined;
  /** Updates status and updated_at only. Sequence and identity never change. */
  updateStatus(id: string, status: Exclude<RequestStatus, 'pending'>): SongRequest | undefined;
  /**
   * Moves played or skipped songs back to pending. The like count is left unchanged.
   * Ids that are missing or already pending are skipped.
   */
  restoreToQueue(ids: readonly string[]): SongRequest[];
  count(): number;
  /** Cheap liveness probe for /api/health. Throws if the database is unusable. */
  ping(): void;
  /**
   * Records a YouTube match on a row that does not have one yet.
   * Does not change status, sequence, or updated_at. Returns undefined when the id is
   * invalid, the row is gone, or a match was already stored.
   */
  setYoutube(id: string, videoId: string, title: string | null, durationSeconds?: number | null): SongRequest | undefined;
  /** Songs that already have a YouTube video but no stored length. */
  missingDurations(): { id: string; videoId: string }[];
  /** Stores a length without changing status or updated_at. */
  setDuration(id: string, durationSeconds: number): SongRequest | undefined;
  /** Deletes the given rows. Unknown ids are ignored. Returns the ids that were actually removed. */
  deleteByIds(ids: readonly string[]): string[];
  /** Deletes every song request. Sessions are untouched. Returns the ids that were removed. */
  deleteAll(): string[];
}

export interface PopularSong {
  id: string;
  songTitle: string;
  count: number;
  liked: boolean;
  durationSeconds: number | null;
}

export type CheerOutcome =
  | { status: 'missing' }
  | { status: 'liked' | 'unliked'; songTitle: string; songs: SongRequest[] }
  | { status: 'conflict'; currentTitle: string; nextTitle: string };

export interface CreateResult {
  request: SongRequest;
  /** True when an existing row was returned because the idempotency key was reused. */
  replayed: boolean;
  /** Only meaningful when replayed; false means the key was reused with a different payload. */
  payloadMatches: boolean;
  /** True when a pending song with the same title had its count increased instead of a new row. */
  merged: boolean;
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
  youtube_video_id: string | null;
  youtube_title: string | null;
  like_count: number;
  duration_seconds: number | null;
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
    youtubeVideoId: row.youtube_video_id,
    youtubeTitle: row.youtube_title,
    likeCount: row.like_count,
    durationSeconds: row.duration_seconds,
  };
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const COLUMNS =
  'id, sequence_number, requester_name, song_title, artist_name, status, created_at, updated_at, idempotency_key, youtube_video_id, youtube_title, like_count, duration_seconds';

export function createSongRequestRepository(db: Database.Database): SongRequestRepository {
  const selectByKey = db.prepare(`SELECT ${COLUMNS} FROM song_requests WHERE idempotency_key = ?`);
  const selectMax = db.prepare('SELECT COALESCE(MAX(sequence_number), 0) AS max_seq FROM song_requests');
  const insertRow = db.prepare(
    `INSERT INTO song_requests
       (id, sequence_number, requester_name, song_title, artist_name, status, created_at, updated_at, idempotency_key)
     VALUES (@id, @sequence_number, @requester_name, @song_title, @artist_name, 'pending', @created_at, @created_at, @idempotency_key)`,
  );
  const selectAll = db.prepare(`SELECT ${COLUMNS} FROM song_requests ORDER BY sequence_number ASC`);
  const selectPendingByTitle = db.prepare(
    `SELECT ${COLUMNS} FROM song_requests WHERE status = 'pending' AND song_title = ? COLLATE NOCASE LIMIT 1`,
  );
  const bumpCount = db.prepare('UPDATE song_requests SET like_count = like_count + 1, updated_at = ? WHERE id = ?');
  const selectSubmission = db.prepare(
    'SELECT song_id, requester_name, song_title FROM submission_keys WHERE idempotency_key = ?',
  );
  const insertSubmission = db.prepare(
    'INSERT INTO submission_keys (idempotency_key, song_id, requester_name, song_title) VALUES (?, ?, ?, ?)',
  );
  const popularSongsStmt = db.prepare(
    `SELECT id, song_title, like_count, duration_seconds,
            EXISTS(SELECT 1 FROM audience_likes WHERE song_id = song_requests.id AND voter_id = ?) AS liked
       FROM song_requests
      WHERE status = 'pending'
      ORDER BY like_count DESC, sequence_number ASC`,
  );
  const selectOne = db.prepare(`SELECT ${COLUMNS} FROM song_requests WHERE id = ?`);
  const selectLike = db.prepare('SELECT song_id FROM audience_likes WHERE voter_id = ?');
  const insertLike = db.prepare('INSERT INTO audience_likes (voter_id, song_id, created_at) VALUES (?, ?, ?)');
  const deleteLike = db.prepare('DELETE FROM audience_likes WHERE voter_id = ?');
  const moveLike = db.prepare('UPDATE audience_likes SET song_id = ?, created_at = ? WHERE voter_id = ?');
  const bumpDown = db.prepare(
    'UPDATE song_requests SET like_count = like_count - 1, updated_at = ? WHERE id = ? AND like_count > 1',
  );
  const clearLikesForSong = db.prepare('DELETE FROM audience_likes WHERE song_id = ?');
  const updateStatusStmt = db.prepare('UPDATE song_requests SET status = ?, updated_at = ? WHERE id = ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM song_requests');
  const setYoutubeStmt = db.prepare(
    `UPDATE song_requests
        SET youtube_video_id = ?, youtube_title = ?, duration_seconds = ?
      WHERE id = ? AND youtube_video_id IS NULL`,
  );

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
        return { request: toSongRequest(existing), replayed: true, payloadMatches, merged: false };
      }
      const keyed = selectSubmission.get(input.idempotencyKey) as
        | { song_id: string; requester_name: string; song_title: string }
        | undefined;
      if (keyed) {
        const stored = selectOne.get(keyed.song_id) as RequestRow | undefined;
        if (stored) {
          return {
            request: toSongRequest(stored),
            replayed: true,
            payloadMatches: keyed.requester_name === input.requesterName && keyed.song_title === input.songTitle,
            merged: false,
          };
        }
      }
    }

    const now = new Date().toISOString();
    const pending = selectPendingByTitle.get(input.songTitle) as RequestRow | undefined;
    if (pending) {
      bumpCount.run(now, pending.id);
      if (input.idempotencyKey !== null) {
        insertSubmission.run(input.idempotencyKey, pending.id, input.requesterName, input.songTitle);
      }
      return {
        request: toSongRequest(selectOne.get(pending.id) as RequestRow),
        replayed: false,
        payloadMatches: true,
        merged: true,
      };
    }

    const { max_seq } = selectMax.get() as { max_seq: number };
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
      youtube_video_id: null,
      youtube_title: null,
      like_count: 1,
      duration_seconds: null,
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
    if (input.idempotencyKey !== null) {
      insertSubmission.run(input.idempotencyKey, row.id, input.requesterName, input.songTitle);
    }
    return { request: toSongRequest(row), replayed: false, payloadMatches: true, merged: false };
  });

  return {
    create: (input) => createTx.immediate(input),
    list: () => (selectAll.all() as RequestRow[]).map(toSongRequest),
    popularSongs: (voterId) =>
      (
        popularSongsStmt.all(voterId ?? '') as {
          id: string;
          song_title: string;
          like_count: number;
          duration_seconds: number | null;
          liked: number;
        }[]
      ).map((row) => ({
        id: row.id,
        songTitle: row.song_title,
        count: row.like_count,
        liked: row.liked === 1,
        durationSeconds: row.duration_seconds,
      })),
    cheer: (voterId, songId, move) => {
      const tx = db.transaction((): CheerOutcome => {
        const target = selectOne.get(songId) as RequestRow | undefined;
        if (!target || target.status !== 'pending') return { status: 'missing' };
        const now = new Date().toISOString();
        const current = selectLike.get(voterId) as { song_id: string } | undefined;

        const changed = (id: string): SongRequest => toSongRequest(selectOne.get(id) as RequestRow);

        if (!current) {
          bumpCount.run(now, target.id);
          insertLike.run(voterId, target.id, now);
          return { status: 'liked', songTitle: target.song_title, songs: [changed(target.id)] };
        }
        if (current.song_id === target.id) {
          bumpDown.run(now, target.id);
          deleteLike.run(voterId);
          return { status: 'unliked', songTitle: target.song_title, songs: [changed(target.id)] };
        }

        const previous = selectOne.get(current.song_id) as RequestRow | undefined;
        if (!previous || previous.status !== 'pending') {
          deleteLike.run(voterId);
          bumpCount.run(now, target.id);
          insertLike.run(voterId, target.id, now);
          return { status: 'liked', songTitle: target.song_title, songs: [changed(target.id)] };
        }
        if (!move) {
          return { status: 'conflict', currentTitle: previous.song_title, nextTitle: target.song_title };
        }
        bumpDown.run(now, previous.id);
        bumpCount.run(now, target.id);
        moveLike.run(target.id, now, voterId);
        return {
          status: 'liked',
          songTitle: target.song_title,
          songs: [changed(previous.id), changed(target.id)],
        };
      });
      return tx.immediate();
    },
    getById: (id) => {
      const row = selectOne.get(id) as RequestRow | undefined;
      return row ? toSongRequest(row) : undefined;
    },
    updateStatus: (id, status) => {
      const tx = db.transaction(() => {
        const result = updateStatusStmt.run(status, new Date().toISOString(), id);
        if (result.changes === 0) return undefined;
        clearLikesForSong.run(id);
        return toSongRequest(selectOne.get(id) as RequestRow);
      });
      return tx.immediate();
    },
    restoreToQueue: (ids) => {
      if (ids.length === 0) return [];
      const tx = db.transaction(() => {
        const restored: SongRequest[] = [];
        const now = new Date().toISOString();
        const restoreStmt = db.prepare(
          `UPDATE song_requests SET status = 'pending', updated_at = ? WHERE id = ? AND status != 'pending'`,
        );
        for (const id of ids) {
          const result = restoreStmt.run(now, id);
          if (result.changes === 0) continue;
          restored.push(toSongRequest(selectOne.get(id) as RequestRow));
        }
        return restored;
      });
      return tx.immediate();
    },
    count: () => (countStmt.get() as { n: number }).n,
    ping: () => {
      db.prepare('SELECT 1').get();
    },
    setYoutube: (id, videoId, title, durationSeconds = null) => {
      if (!VIDEO_ID.test(videoId)) return undefined;
      const storedTitle = title?.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
      const storedDuration =
        typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
          ? Math.round(durationSeconds)
          : null;
      const tx = db.transaction(() => {
        const result = setYoutubeStmt.run(videoId, storedTitle, storedDuration, id);
        if (result.changes === 0) return undefined;
        return toSongRequest(selectOne.get(id) as RequestRow);
      });
      return tx.immediate();
    },
    missingDurations: () =>
      (
        db
          .prepare(
            `SELECT id, youtube_video_id AS videoId
               FROM song_requests
              WHERE youtube_video_id IS NOT NULL AND duration_seconds IS NULL
              LIMIT 50`,
          )
          .all() as { id: string; videoId: string }[]
      ),
    setDuration: (id, durationSeconds) => {
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return undefined;
      const tx = db.transaction(() => {
        const result = db
          .prepare('UPDATE song_requests SET duration_seconds = ? WHERE id = ? AND duration_seconds IS NULL')
          .run(Math.round(durationSeconds), id);
        if (result.changes === 0) return undefined;
        return toSongRequest(selectOne.get(id) as RequestRow);
      });
      return tx.immediate();
    },
    deleteByIds: (ids) => {
      if (ids.length === 0) return [];
      const tx = db.transaction(() => {
        const placeholders = ids.map(() => '?').join(', ');
        const found = db.prepare(`SELECT id FROM song_requests WHERE id IN (${placeholders})`).all(...ids) as { id: string }[];
        if (found.length === 0) return [];
        const remove = found.map((row) => row.id);
        const removePlaceholders = remove.map(() => '?').join(', ');
        db.prepare(`DELETE FROM audience_likes WHERE song_id IN (${removePlaceholders})`).run(...remove);
        db.prepare(`DELETE FROM submission_keys WHERE song_id IN (${removePlaceholders})`).run(...remove);
        db.prepare(`DELETE FROM song_requests WHERE id IN (${removePlaceholders})`).run(...remove);
        return remove;
      });
      return tx.immediate();
    },
    deleteAll: () => {
      const tx = db.transaction(() => {
        const found = db.prepare('SELECT id FROM song_requests').all() as { id: string }[];
        db.prepare('DELETE FROM audience_likes').run();
        db.prepare('DELETE FROM submission_keys').run();
        db.prepare('DELETE FROM song_requests').run();
        return found.map((row) => row.id);
      });
      return tx.immediate();
    },
  };
}
