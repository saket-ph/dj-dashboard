import type { SongRequest } from './types';

/**
 * Pure helpers for the dashboard's local copy of the queue.
 *
 * The local list is only a view: SQLite is authoritative. Anything received over SSE is a
 * hint, and a snapshot/reload always replaces local state (FR-048, NFR-009).
 */

function bySequence(a: SongRequest, b: SongRequest): number {
  return a.sequenceNumber - b.sequenceNumber;
}

/** Sorts by sequence ascending and removes duplicate ids (keeping the most recently updated). */
export function normalizeQueue(list: readonly SongRequest[]): SongRequest[] {
  const byId = new Map<string, SongRequest>();
  for (const item of list) {
    const existing = byId.get(item.id);
    if (!existing || item.updatedAt >= existing.updatedAt) byId.set(item.id, item);
  }
  return [...byId.values()].sort(bySequence);
}

/** Replaces the whole local queue with an authoritative snapshot. */
export function applySnapshot(snapshot: readonly SongRequest[]): SongRequest[] {
  return normalizeQueue(snapshot);
}

/**
 * Merges the result of a GET reload into local state (union by id, newer `updatedAt` wins).
 *
 * Unlike a stream snapshot, a GET response can be older than an SSE event that arrived while
 * the request was in flight, so rows are never dropped here. Deletes are applied separately
 * (`removeRequests` plus `request.deleted`). The next stream snapshot is a strict replace.
 */
export function mergeReload(local: readonly SongRequest[], fetched: readonly SongRequest[]): SongRequest[] {
  return normalizeQueue([...local, ...fetched]);
}

/**
 * Inserts or updates one request by id. Never creates a duplicate, and never lets an older
 * update overwrite a newer copy (e.g. a late SSE event after a PATCH response).
 */
/** Drops the given ids. Other rows keep their sequence numbers and order. */
export function removeRequests(list: readonly SongRequest[], ids: readonly string[]): SongRequest[] {
  if (ids.length === 0) return normalizeQueue(list);
  const drop = new Set(ids);
  return normalizeQueue(list.filter((item) => !drop.has(item.id)));
}

export function upsertRequest(list: readonly SongRequest[], incoming: SongRequest): SongRequest[] {
  const existing = list.find((r) => r.id === incoming.id);
  if (existing && existing.updatedAt > incoming.updatedAt) return normalizeQueue(list);
  return normalizeQueue([...list.filter((r) => r.id !== incoming.id), incoming]);
}

export interface SplitQueue {
  pending: SongRequest[];
  /** Played and skipped, still ordered by sequence (not by update time). */
  history: SongRequest[];
}

function byPopularity(a: SongRequest, b: SongRequest): number {
  const byLikes = (b.likeCount ?? 1) - (a.likeCount ?? 1);
  return byLikes !== 0 ? byLikes : a.sequenceNumber - b.sequenceNumber;
}

export function splitQueue(list: readonly SongRequest[]): SplitQueue {
  const sorted = normalizeQueue(list);
  return {
    pending: sorted.filter((r) => r.status === 'pending').sort(byPopularity),
    history: sorted.filter((r) => r.status !== 'pending'),
  };
}
