// Persistence failure and startup behavior: FR-050..FR-052, T-007, T-021, T-022.
//
// T-023 (redeploy data loss) is a documented hosting limit, not something this suite tests by
// deleting production disks. It is verified by README inspection (see "SQLite file and
// initialization" in README.md, and the deployment runbook). The tests below only cover the app-level half of it:
// a missing database file is recreated empty with a visible warning, and an existing file is
// never wiped on startup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { DatabaseInitError, initializeDatabase } from '../src/db/database.js';
import { createSongRequestRepository } from '../src/db/requestRepository.js';
import { createMemoryLogger } from '../src/logger.js';
import { makeTempDir } from './helpers.js';

const dirs: string[] = [];
function tmp(): string {
  const d = makeTempDir();
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const sample = { requesterName: 'Alex', songTitle: 'Song', artistName: null, idempotencyKey: null };

describe('database initialization (T1.04, T1.06, T1.07)', () => {
  it('creates the parent directory, the file, the table, and both indexes', () => {
    const file = path.join(tmp(), 'nested', 'dir', 'q.sqlite');
    const logger = createMemoryLogger();
    const { db, createdNew } = initializeDatabase(file, logger);
    assert.ok(createdNew);
    assert.ok(fs.existsSync(file));
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%song_requests%'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    assert.ok(names.includes('song_requests'));
    assert.ok(names.includes('idx_song_requests_status_sequence'));
    assert.ok(names.includes('idx_song_requests_sequence'));
    db.close();
  });

  it('refuses in-memory databases', () => {
    assert.throws(() => initializeDatabase(':memory:', createMemoryLogger()), DatabaseInitError);
  });

  it('logs that a new empty database was created and nothing was recovered (T-021)', () => {
    const file = path.join(tmp(), 'q.sqlite');
    const logger = createMemoryLogger();
    const { db } = initializeDatabase(file, logger);
    db.close();
    assert.equal(logger.lines.filter((l) => /new empty database/i.test(l) && /NOT recovered/i.test(l)).length, 1);
  });

  it('does not clear an existing valid database on startup (T-022)', () => {
    const file = path.join(tmp(), 'q.sqlite');
    const first = initializeDatabase(file, createMemoryLogger());
    const created = createSongRequestRepository(first.db).create(sample);
    first.db.close();

    const logger = createMemoryLogger();
    const second = initializeDatabase(file, logger);
    assert.equal(second.createdNew, false);
    assert.equal(logger.lines.length, 0, 'must not log a new-database or recovery claim');
    const rows = createSongRequestRepository(second.db).list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, created.request.id);
    second.db.close();
  });

  it('after the file is deleted, starts empty and says so (T-021, T-023)', () => {
    const file = path.join(tmp(), 'q.sqlite');
    const first = initializeDatabase(file, createMemoryLogger());
    createSongRequestRepository(first.db).create(sample);
    first.db.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });

    const logger = createMemoryLogger();
    const second = initializeDatabase(file, logger);
    assert.ok(second.createdNew);
    assert.equal(createSongRequestRepository(second.db).count(), 0);
    assert.equal(logger.lines.length, 1);
    second.db.close();
  });

  it('fails safely and leaves a non-database file untouched', () => {
    const file = path.join(tmp(), 'q.sqlite');
    fs.writeFileSync(file, 'this is definitely not a sqlite database file, just text '.repeat(10));
    const before = fs.readFileSync(file);
    assert.throws(() => initializeDatabase(file, createMemoryLogger()), (err: Error) => {
      assert.ok(err instanceof DatabaseInitError);
      assert.ok(!err.message.includes(file), 'must not leak the file path');
      return true;
    });
    assert.deepEqual(fs.readFileSync(file), before);
  });

  it('enforces status and length constraints in the database itself', () => {
    const file = path.join(tmp(), 'q.sqlite');
    const { db } = initializeDatabase(file, createMemoryLogger());
    const insert = db.prepare(
      "INSERT INTO song_requests (id, sequence_number, requester_name, song_title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'x', 'x')",
    );
    assert.throws(() => insert.run('a', 1, 'Alex', 'Song', 'bogus'));
    assert.throws(() => insert.run('b', 2, '   ', 'Song', 'pending'));
    assert.throws(() => insert.run('c', 3, 'Alex', 'x'.repeat(161), 'pending'));
    insert.run('d', 4, 'Alex', 'Song', 'pending');
    assert.throws(() => insert.run('e', 4, 'Alex', 'Song', 'pending'), /UNIQUE/i, 'sequence_number must be unique');
    db.close();
  });
});

describe('request repository (T1.05, T1.10)', () => {
  it('assigns sequence 1 then 2 with unique ids and UTC timestamps', () => {
    const { db } = initializeDatabase(path.join(tmp(), 'q.sqlite'), createMemoryLogger());
    const repo = createSongRequestRepository(db);
    const a = repo.create(sample).request;
    const b = repo.create({ ...sample, songTitle: 'Other' }).request;
    assert.equal(a.sequenceNumber, 1);
    assert.equal(b.sequenceNumber, 2);
    assert.notEqual(a.id, b.id);
    assert.equal(a.status, 'pending');
    assert.match(a.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    db.close();
  });

  it('rolls back completely when the insert fails, consuming no visible sequence', () => {
    const { db } = initializeDatabase(path.join(tmp(), 'q.sqlite'), createMemoryLogger());
    const repo = createSongRequestRepository(db);
    repo.create(sample);
    // Violates the CHECK constraint (name longer than 80 chars) after the sequence was computed.
    assert.throws(() => repo.create({ ...sample, requesterName: 'x'.repeat(81) }));
    assert.equal(repo.count(), 1);
    const next = repo.create({ ...sample, songTitle: 'After failure' }).request;
    assert.equal(next.sequenceNumber, 2, 'failed insert must not leave a gap or a visible row');
    db.close();
  });

  it('lists in sequence order and keeps sequence when status changes (T-013, T-014)', () => {
    const { db } = initializeDatabase(path.join(tmp(), 'q.sqlite'), createMemoryLogger());
    const repo = createSongRequestRepository(db);
    const r1 = repo.create(sample).request;
    const r2 = repo.create({ ...sample, songTitle: 'Two' }).request;
    const updated = repo.updateStatus(r1.id, 'played');
    assert.equal(updated?.status, 'played');
    assert.equal(updated?.sequenceNumber, 1);
    assert.deepEqual(
      repo.list().map((r) => [r.id, r.sequenceNumber, r.status]),
      [
        [r1.id, 1, 'played'],
        [r2.id, 2, 'pending'],
      ],
    );
    assert.equal(repo.updateStatus('does-not-exist', 'skipped'), undefined);
    db.close();
  });

  it('is safe against SQL injection payloads (parameterized queries)', () => {
    const { db } = initializeDatabase(path.join(tmp(), 'q.sqlite'), createMemoryLogger());
    const repo = createSongRequestRepository(db);
    const evil = "Robert'); DROP TABLE song_requests;--";
    repo.create({ ...sample, requesterName: evil });
    assert.equal(repo.list()[0]?.requesterName, evil);
    assert.equal(repo.count(), 1, 'the table must still exist and hold exactly the one row');
    db.close();
  });
});
