import { describe, expect, it } from 'vitest';
import { applySnapshot, mergeReload, normalizeQueue, splitQueue, upsertRequest } from './queue';
import type { SongRequest } from './types';

function req(n: number, overrides: Partial<SongRequest> = {}): SongRequest {
  return {
    id: `id-${n}`,
    sequenceNumber: n,
    requesterName: `Guest ${n}`,
    songTitle: `Song ${n}`,
    artistName: null,
    status: 'pending',
    createdAt: `2026-10-14T12:00:0${n}.000Z`,
    updatedAt: `2026-10-14T12:00:0${n}.000Z`,
    ...overrides,
  };
}

describe('queue helpers (T-009, T3.04, T3.06)', () => {
  it('sorts by sequence ascending regardless of arrival order', () => {
    const out = normalizeQueue([req(3), req(1), req(2)]);
    expect(out.map((r) => r.sequenceNumber)).toEqual([1, 2, 3]);
  });

  it('upsert adds a new request in the right position', () => {
    const out = upsertRequest([req(1), req(3)], req(2));
    expect(out.map((r) => r.sequenceNumber)).toEqual([1, 2, 3]);
  });

  it('upsert never creates a duplicate entry for the same id', () => {
    let list = [req(1), req(2)];
    for (let i = 0; i < 5; i++) list = upsertRequest(list, req(2));
    expect(list).toHaveLength(2);
    expect(new Set(list.map((r) => r.id)).size).toBe(2);
  });

  it('upsert applies a newer status and ignores an older stale copy', () => {
    const base = [req(1)];
    const played = req(1, { status: 'played', updatedAt: '2026-10-14T12:05:00.000Z' });
    const afterPlayed = upsertRequest(base, played);
    expect(afterPlayed[0]?.status).toBe('played');
    const stale = req(1, { status: 'pending', updatedAt: '2026-10-14T12:00:01.000Z' });
    expect(upsertRequest(afterPlayed, stale)[0]?.status).toBe('played');
  });

  it('a snapshot fully replaces local state, dropping rows that no longer exist', () => {
    const local = [req(1), req(2), req(9)];
    const snapshot = [req(2), req(1)];
    expect(applySnapshot(snapshot).map((r) => r.id)).toEqual(['id-1', 'id-2']);
    expect(local).toHaveLength(3);
  });

  it('a snapshot with duplicate ids collapses to one entry per id', () => {
    const out = applySnapshot([req(1), req(1), req(2)]);
    expect(out).toHaveLength(2);
  });

  it('keeps the sequence of a request when its status changes (FR-021)', () => {
    const out = upsertRequest([req(1), req(2), req(3)], req(2, { status: 'played', updatedAt: '2026-10-14T13:00:00.000Z' }));
    expect(out.map((r) => [r.sequenceNumber, r.status])).toEqual([
      [1, 'pending'],
      [2, 'played'],
      [3, 'pending'],
    ]);
  });

  it('a reload merge keeps a row an event delivered while the GET was in flight', () => {
    const local = [req(1), req(2)]; // row 2 arrived via SSE
    const fetched = [req(1)]; // GET was answered before row 2 committed
    expect(mergeReload(local, fetched).map((r) => r.id)).toEqual(['id-1', 'id-2']);
  });

  it('a reload merge picks up rows and newer statuses that were missed', () => {
    const local = [req(1)];
    const fetched = [req(1, { status: 'played', updatedAt: '2026-10-14T13:00:00.000Z' }), req(2), req(3)];
    const out = mergeReload(local, fetched);
    expect(out.map((r) => [r.sequenceNumber, r.status])).toEqual([
      [1, 'played'],
      [2, 'pending'],
      [3, 'pending'],
    ]);
  });

  it('a reload merge never downgrades a newer local status', () => {
    const local = [req(1, { status: 'played', updatedAt: '2026-10-14T13:00:00.000Z' })];
    const fetched = [req(1)];
    expect(mergeReload(local, fetched)[0]?.status).toBe('played');
  });

  it('splits pending from history, both ordered by sequence', () => {
    const { pending, history } = splitQueue([
      req(4, { status: 'skipped' }),
      req(1),
      req(3, { status: 'played' }),
      req(2),
    ]);
    expect(pending.map((r) => r.sequenceNumber)).toEqual([1, 2]);
    expect(history.map((r) => r.sequenceNumber)).toEqual([3, 4]);
  });
});
