import type Database from 'better-sqlite3';

/**
 * Idempotent schema setup. Every statement is CREATE ... IF NOT EXISTS, so running it
 * against an existing database never drops, truncates, or rewrites rows (FR-051).
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
  idempotency_key TEXT UNIQUE
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
`;

export function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}

export function hasRequestsTable(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'song_requests'")
    .get() as { present: number } | undefined;
  return row !== undefined;
}
