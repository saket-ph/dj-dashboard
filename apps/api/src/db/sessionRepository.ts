import type Database from 'better-sqlite3';

export interface SessionRecord {
  id: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

/** Data-access boundary for DJ sessions. Parameterized SQL only; never stores the password. */
export interface SessionRepository {
  create(session: SessionRecord): void;
  /** Returns the session only if it exists and has not expired at `nowIso`. */
  getValid(id: string, nowIso: string): SessionRecord | undefined;
  delete(id: string): void;
  deleteExpired(nowIso: string): number;
  count(): number;
}

interface SessionRow {
  id: string;
  csrf_token: string;
  created_at: string;
  expires_at: string;
}

export function createSessionRepository(db: Database.Database): SessionRepository {
  const insert = db.prepare(
    'INSERT INTO sessions (id, csrf_token, created_at, expires_at) VALUES (@id, @csrf_token, @created_at, @expires_at)',
  );
  const select = db.prepare('SELECT id, csrf_token, created_at, expires_at FROM sessions WHERE id = ?');
  const remove = db.prepare('DELETE FROM sessions WHERE id = ?');
  const removeExpired = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM sessions');

  return {
    create: (s) => {
      insert.run({ id: s.id, csrf_token: s.csrfToken, created_at: s.createdAt, expires_at: s.expiresAt });
    },
    getValid: (id, nowIso) => {
      const row = select.get(id) as SessionRow | undefined;
      if (!row || row.expires_at <= nowIso) return undefined;
      return { id: row.id, csrfToken: row.csrf_token, createdAt: row.created_at, expiresAt: row.expires_at };
    },
    delete: (id) => {
      remove.run(id);
    },
    deleteExpired: (nowIso) => removeExpired.run(nowIso).changes,
    count: () => (countStmt.get() as { n: number }).n,
  };
}
