import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from '../logger.js';
import { applySchema, hasRequestsTable } from './schema.js';

export class DatabaseInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseInitError';
  }
}

export interface InitializedDatabase {
  db: Database.Database;
  /** True when this call created a brand-new, empty queue (file or schema was absent). */
  createdNew: boolean;
}

/**
 * Opens (and if needed creates) the SQLite file.
 *
 * - Refuses in-memory databases.
 * - Creates the parent directory.
 * - Applies the idempotent schema; never deletes or recreates a database that already exists.
 * - If the file exists but is not a usable SQLite database, fails with a safe message and
 *   leaves the file untouched.
 */
export function initializeDatabase(databasePath: string, logger: Logger): InitializedDatabase {
  if (!databasePath || databasePath === ':memory:' || databasePath.startsWith('file::memory:')) {
    throw new DatabaseInitError('DATABASE_PATH must be a file path; in-memory databases are not allowed.');
  }

  const existedBefore = fs.existsSync(databasePath);

  try {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  } catch {
    throw new DatabaseInitError(
      'Could not create the database directory. Check DATABASE_PATH and filesystem permissions.',
    );
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(databasePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
  } catch {
    // Release the file handle if the file opened but is not a usable database.
    if (db?.open) db.close();
    throw new DatabaseInitError(
      'Could not open the database file. Check that DATABASE_PATH is writable and is a valid SQLite database.',
    );
  }

  try {
    const hadSchema = hasRequestsTable(db);
    applySchema(db);
    const createdNew = !existedBefore || !hadSchema;
    if (createdNew) {
      logger.warn(
        'A new empty database was created. Any earlier requests were NOT recovered; the queue starts empty.',
      );
    }
    return { db, createdNew };
  } catch {
    db.close();
    throw new DatabaseInitError('Could not apply the database schema. The existing file was left untouched.');
  }
}
