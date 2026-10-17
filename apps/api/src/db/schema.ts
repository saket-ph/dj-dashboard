import type Database from 'better-sqlite3';

/**
 * Idempotent schema setup. CREATE ... IF NOT EXISTS never drops or rewrites an existing
 * queue (FR-051). Columns added after the first release are attached with ALTER TABLE
 * only when missing, which leaves every existing row in place.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS song_requests (
  id TEXT PRIMARY KEY,
  sequence_number INTEGER NOT NULL UNIQUE,
  requester_name TEXT NOT NULL
    CHECK (length(trim(requester_name)) BETWEEN 1 AND 80),
  song_title TEXT NOT NULL
    CHECK (length(trim(song_title)) BETWEEN 1 AND 160),
  artist_name TEXT
    CHECK (artist_name IS NULL OR length(trim(artist_name)) <= 160),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'played', 'skipped')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  youtube_video_id TEXT
    CHECK (youtube_video_id IS NULL OR length(youtube_video_id) = 11),
  youtube_title TEXT
    CHECK (youtube_title IS NULL OR length(youtube_title) <= 200)
);

CREATE INDEX IF NOT EXISTS idx_song_requests_status_sequence
  ON song_requests(status, sequence_number);

CREATE INDEX IF NOT EXISTS idx_song_requests_sequence
  ON song_requests(sequence_number);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS submission_keys (
  idempotency_key TEXT PRIMARY KEY,
  song_id TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  song_title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audience_likes (
  voter_id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audience_likes_song
  ON audience_likes(song_id);
`;

export function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  ensureYoutubeColumns(db);
  ensureLikeCount(db);
  collapsePendingDuplicates(db);
}

/** Queues created before the YouTube columns existed get them added, with NULL for every current row. */
function ensureYoutubeColumns(db: Database.Database): void {
  const present = new Set(
    (db.prepare('PRAGMA table_info(song_requests)').all() as { name: string }[]).map((column) => column.name),
  );
  if (!present.has('youtube_video_id')) {
    db.exec('ALTER TABLE song_requests ADD COLUMN youtube_video_id TEXT');
  }
  if (!present.has('youtube_title')) {
    db.exec('ALTER TABLE song_requests ADD COLUMN youtube_title TEXT');
  }
}

function ensureLikeCount(db: Database.Database): void {
  const present = new Set(
    (db.prepare('PRAGMA table_info(song_requests)').all() as { name: string }[]).map((column) => column.name),
  );
  if (!present.has('like_count')) {
    db.exec('ALTER TABLE song_requests ADD COLUMN like_count INTEGER NOT NULL DEFAULT 1');
  }
}

/**
 * Older queues stored one row per tap. Pending rows that share a title (ignoring case)
 * become one row whose like_count is the number of those taps. Played and skipped rows stay as they are.
 */
function collapsePendingDuplicates(db: Database.Database): void {
  const groups = db
    .prepare(
      `SELECT lower(trim(song_title)) AS title_key, SUM(like_count) AS total
         FROM song_requests
        WHERE status = 'pending'
        GROUP BY lower(trim(song_title))
       HAVING COUNT(*) > 1`,
    )
    .all() as { title_key: string; total: number }[];
  if (groups.length === 0) return;

  const rowsForTitle = db.prepare(
    `SELECT id, youtube_video_id, youtube_title
       FROM song_requests
      WHERE status = 'pending' AND lower(trim(song_title)) = ?
      ORDER BY sequence_number ASC`,
  );
  const copyVideo = db.prepare(
    'UPDATE song_requests SET youtube_video_id = ?, youtube_title = ? WHERE id = ? AND youtube_video_id IS NULL',
  );
  const setCount = db.prepare('UPDATE song_requests SET like_count = ? WHERE id = ?');
  const dropLikes = db.prepare('DELETE FROM audience_likes WHERE song_id = ?');
  const dropKeys = db.prepare('DELETE FROM submission_keys WHERE song_id = ?');
  const dropRow = db.prepare('DELETE FROM song_requests WHERE id = ?');

  const tx = db.transaction(() => {
    for (const group of groups) {
      const rows = rowsForTitle.all(group.title_key) as {
        id: string;
        youtube_video_id: string | null;
        youtube_title: string | null;
      }[];
      const keep = rows[0];
      if (!keep) continue;
      const video = rows.find((row) => row.youtube_video_id);
      if (video?.youtube_video_id) copyVideo.run(video.youtube_video_id, video.youtube_title, keep.id);
      setCount.run(group.total, keep.id);
      for (const extra of rows.slice(1)) {
        dropLikes.run(extra.id);
        dropKeys.run(extra.id);
        dropRow.run(extra.id);
      }
    }
  });
  tx();
}

export function hasRequestsTable(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'song_requests'")
    .get() as { present: number } | undefined;
  return row !== undefined;
}
