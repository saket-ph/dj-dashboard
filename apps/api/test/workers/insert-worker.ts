import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { createSongRequestRepository } from '../../src/db/requestRepository.js';

/**
 * Each worker opens its OWN connection to the same SQLite file and inserts requests, so the
 * test exercises real write contention (BEGIN IMMEDIATE + busy_timeout), not just one connection.
 */
const { dbPath, count, label } = workerData as { dbPath: string; count: number; label: string };

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
const repo = createSongRequestRepository(db);

const sequences: number[] = [];
const errors: string[] = [];
for (let i = 0; i < count; i++) {
  try {
    const { request } = repo.create({
      requesterName: `${label}`,
      songTitle: `Song ${label}-${i}`,
      artistName: null,
      idempotencyKey: null,
    });
    sequences.push(request.sequenceNumber);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
}
db.close();
parentPort?.postMessage({ sequences, errors });
