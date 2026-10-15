import { vi } from 'vitest';
import type { SongRequest } from '../lib/types';

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function apiError(status: number, code: string, message = 'Server message.'): Response {
  return json(status, { error: { code, message } });
}

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** Replaces global fetch with a handler and returns the spy so tests can inspect calls. */
export function installFetch(handler: Handler) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

export function callsTo(fn: ReturnType<typeof installFetch>, url: string, method?: string) {
  return fn.mock.calls.filter(([input, init]) => {
    if (String(input) !== url) return false;
    return method ? ((init as RequestInit | undefined)?.method ?? 'GET') === method : true;
  });
}

export function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers as Record<string, string> | undefined;
  if (!h) return undefined;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}

export function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

export function makeRequest(n: number, overrides: Partial<SongRequest> = {}): SongRequest {
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

/** A controllable stand-in for the browser EventSource. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset(): void {
    FakeEventSource.instances = [];
  }
  static get last(): FakeEventSource {
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (!es) throw new Error('no EventSource was created');
    return es;
  }

  readyState = 0;
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

/** A promise you resolve by hand, to hold a request "in flight". */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
