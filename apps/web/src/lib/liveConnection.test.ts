import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLiveConnection, type ConnectionState, type EventSourceLike } from './liveConnection';
import type { SongRequest } from './types';

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readyState = 0; // CONNECTING
  closed = false;
  private listeners = new Map<string, Array<(e: { data?: string }) => void>>();

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (e: { data?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data: data === undefined ? undefined : JSON.stringify(data) });
  }
}

function req(n: number): SongRequest {
  return {
    id: `id-${n}`,
    sequenceNumber: n,
    requesterName: `G${n}`,
    songTitle: `S${n}`,
    artistName: null,
    status: 'pending',
    createdAt: '2026-10-14T12:00:00.000Z',
    updatedAt: '2026-10-14T12:00:00.000Z',
  };
}

function setup(overrides: Partial<Parameters<typeof startLiveConnection>[0]> = {}) {
  const states: ConnectionState[] = [];
  const snapshots: SongRequest[][] = [];
  const upserts: SongRequest[] = [];
  const reload = vi.fn();
  const conn = startLiveConnection({
    url: '/api/dj/requests/stream',
    onState: (s) => states.push(s),
    onSnapshot: (r) => snapshots.push(r),
    onUpsert: (r) => upserts.push(r),
    onReload: reload,
    createEventSource: (url) => new FakeEventSource(url),
    ...overrides,
  });
  const current = () => FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
  return { conn, states, snapshots, upserts, reload, current };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('live connection (T3.04–T3.06, T-018)', () => {
  it('becomes connected on snapshot and replaces local state with it', () => {
    const { states, snapshots, current } = setup();
    current().emit('snapshot', { requests: [req(2), req(1)] });
    expect(states).toEqual(['connected']);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toHaveLength(2);
  });

  it('forwards created and updated events as upserts', () => {
    const { upserts, current } = setup();
    current().emit('snapshot', { requests: [] });
    current().emit('request.created', req(1));
    current().emit('request.updated', { ...req(1), status: 'played' });
    expect(upserts.map((r) => [r.id, r.status])).toEqual([
      ['id-1', 'pending'],
      ['id-1', 'played'],
    ]);
  });

  it('forwards deleted ids and ignores an empty or malformed delete', () => {
    const deleted: string[][] = [];
    const { current } = setup({ onDeleted: (ids) => deleted.push(ids) });
    current().emit('snapshot', { requests: [] });
    current().emit('request.deleted', { ids: ['id-1', 'id-2'] });
    current().emit('request.deleted', { ids: [] });
    current().emit('request.deleted', { nope: true });
    expect(deleted).toEqual([['id-1', 'id-2']]);
  });

  it('ignores malformed event payloads without throwing', () => {
    const { upserts, snapshots, current } = setup();
    const es = current();
    expect(() => {
      es.emit('snapshot', 'not-an-object');
      es.emit('request.created', { nope: true });
      es.emit('request.created');
    }).not.toThrow();
    expect(upserts).toHaveLength(0);
    expect(snapshots).toHaveLength(0);
  });

  it('shows reconnecting, reloads immediately, then offline after repeated failures', () => {
    const { states, reload, current } = setup({ maxFailuresBeforeOffline: 3 });
    current().emit('snapshot', { requests: [] });
    const es = current();
    es.emit('error');
    expect(states).toEqual(['connected', 'reconnecting']);
    expect(reload).toHaveBeenCalledTimes(1);
    es.emit('error');
    es.emit('error');
    expect(states[states.length - 1]).toBe('offline');
  });

  it('polls the queue while the stream is down and stops once it is back', () => {
    const { reload, current } = setup({ pollMs: 1000 });
    current().emit('snapshot', { requests: [] });
    current().emit('error');
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(reload).toHaveBeenCalledTimes(4);

    current().emit('open');
    const before = reload.mock.calls.length;
    vi.advanceTimersByTime(5000);
    expect(reload).toHaveBeenCalledTimes(before);
  });

  it('after reconnecting, the next snapshot replaces state and status returns to connected', () => {
    const { states, snapshots, current } = setup();
    current().emit('snapshot', { requests: [req(1)] });
    current().emit('error');
    current().emit('open');
    current().emit('snapshot', { requests: [req(1), req(2), req(3)] });
    expect(states[states.length - 1]).toBe('connected');
    expect(snapshots[snapshots.length - 1]).toHaveLength(3);
  });

  it('re-opens a stream the browser closed, with exponential backoff', () => {
    const { current } = setup({ reconnectBaseMs: 1000, reconnectMaxMs: 4000 });
    const first = current();
    first.readyState = 2;
    first.emit('error');
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    const second = current();
    second.readyState = 2;
    second.emit('error');
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('events from a replaced stream are ignored', () => {
    const { upserts, current } = setup({ reconnectBaseMs: 10 });
    const old = current();
    old.readyState = 2;
    old.emit('error');
    vi.advanceTimersByTime(10);
    expect(current()).not.toBe(old);
    old.emit('request.created', req(9));
    expect(upserts).toHaveLength(0);
  });

  it('treats prolonged silence as a dead connection even when the browser reports no error', () => {
    const { states, reload, current } = setup({ staleAfterMs: 40_000, reconnectBaseMs: 1000 });
    const first = current();
    first.emit('snapshot', { requests: [] });
    expect(states).toEqual(['connected']);

    vi.advanceTimersByTime(39_999);
    expect(states).toEqual(['connected']);
    vi.advanceTimersByTime(1);
    expect(states).toEqual(['connected', 'reconnecting']);
    expect(reload).toHaveBeenCalled();
    expect(first.closed).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('heartbeats keep a quiet but healthy connection alive indefinitely', () => {
    const { states, reload, current } = setup({ staleAfterMs: 40_000 });
    const es = current();
    es.emit('snapshot', { requests: [] });
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(15_000);
      es.emit('heartbeat', {});
    }
    expect(states).toEqual(['connected']);
    expect(reload).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('replaces a stream the browser keeps retrying if it never recovers', () => {
    const { states, current } = setup({ staleAfterMs: 20_000, reconnectBaseMs: 500 });
    const es = current();
    es.emit('snapshot', { requests: [] });
    es.emit('error'); // browser says it is retrying (readyState stays CONNECTING)
    expect(states).toEqual(['connected', 'reconnecting']);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(20_000);
    expect(es.closed).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2);
  });
  it('stop() closes the stream and cancels timers and polling', () => {
    const { conn, reload, current } = setup({ pollMs: 500 });
    const es = current();
    es.emit('error');
    const calls = reload.mock.calls.length;
    conn.stop();
    expect(es.closed).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(reload).toHaveBeenCalledTimes(calls);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
