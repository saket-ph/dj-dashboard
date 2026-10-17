import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createApp, type AppDeps } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { initializeDatabase } from '../src/db/database.js';
import { createSongRequestRepository, type SongRequestRepository } from '../src/db/requestRepository.js';
import { createSessionRepository, type SessionRepository } from '../src/db/sessionRepository.js';
import { createMemoryLogger, type Logger } from '../src/logger.js';

export const TEST_PASSWORD = 'correct horse battery staple';
export const TEST_SESSION_SECRET = 'test-session-secret-0123456789abcdef';
// Hashed once per test process; scrypt is deliberately slow.
export const TEST_PASSWORD_HASH = await hashPassword(TEST_PASSWORD);

export interface TestClock {
  now(): Date;
  advance(ms: number): void;
}

export function createTestClock(start = new Date('2026-10-14T12:00:00.000Z')): TestClock {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
  };
}

export interface TestServer {
  baseUrl: string;
  config: AppConfig;
  db: Database.Database;
  repo: SongRequestRepository;
  sessions: SessionRepository;
  logger: Logger & { lines: string[] };
  clock: TestClock;
  dbPath: string;
  dir: string;
  /** Resolves when every YouTube lookup started so far has finished. */
  whenYoutubeIdle(): Promise<void>;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Reuse an existing directory/database file (for restart tests). */
  dir?: string;
  env?: Record<string, string>;
  /** Wrap or replace the repository (for failure injection). */
  wrapRepo?: (repo: SongRequestRepository) => SongRequestRepository;
  /** Extra app dependencies (rate limiters, SSE hooks, ...). */
  appDeps?: (base: { repo: SongRequestRepository; sessions: SessionRepository; clock: TestClock }) => Partial<AppDeps>;
  /** Keep the temp directory on close (so a restart can reuse it). */
  keepFiles?: boolean;
  /** Serve this directory as the built web app (single-origin mode). */
  webDistDir?: string;
}

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dj-test-'));
}

export function testConfig(dbPath: string, env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'https://dj.example.test',
    EVENT_TITLE: 'Test Night',
    DJ_PASSWORD_HASH: TEST_PASSWORD_HASH,
    SESSION_SECRET: TEST_SESSION_SECRET,
    DATABASE_PATH: dbPath,
    // Generous by default so unrelated tests never trip the limiters; rate-limit tests override.
    SUBMISSION_RATE_LIMIT_MAX: '100000',
    LOGIN_RATE_LIMIT_MAX: '100000',
    ...env,
  });
}

export async function startTestServer(options: StartOptions = {}): Promise<TestServer> {
  const dir = options.dir ?? makeTempDir();
  const dbPath = path.join(dir, 'data', 'test.sqlite');
  const config = testConfig(dbPath, options.env);
  if (options.webDistDir) config.webDistDir = options.webDistDir;
  const logger = createMemoryLogger();
  const clock = createTestClock();
  const { db } = initializeDatabase(config.databasePath, logger);
  const baseRepo = createSongRequestRepository(db);
  const repo = options.wrapRepo ? options.wrapRepo(baseRepo) : baseRepo;
  const sessions = createSessionRepository(db);
  const extra = options.appDeps?.({ repo, sessions, clock }) ?? {};
  const app = createApp({ config, repo, sessions, logger, clock: () => clock.now(), ...extra });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const whenYoutubeIdle = (): Promise<void> => {
    const wait = app.locals.whenYoutubeIdle as (() => Promise<void>) | undefined;
    return wait ? wait() : Promise.resolve();
  };

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    whenYoutubeIdle,
    config,
    db,
    repo,
    sessions,
    logger,
    clock,
    dbPath,
    dir,
    close: async () => {
      await whenYoutubeIdle();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      if (db.open) db.close();
      if (!options.keepFiles) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function countRows(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM song_requests').get() as { n: number }).n;
}

/** Extracts "name=value" from the Set-Cookie header of a response. */
export function cookieFrom(res: Response): string | undefined {
  const raw = res.headers.getSetCookie();
  const hit = raw.find((c) => c.startsWith('dj_session='));
  return hit?.split(';')[0];
}

export interface DjLogin {
  cookie: string;
  csrfToken: string;
}

export async function loginAsDj(baseUrl: string, password = TEST_PASSWORD): Promise<DjLogin> {
  const res = await postJson(`${baseUrl}/api/auth/login`, { password });
  if (res.status !== 200) throw new Error(`login failed with ${res.status}`);
  const cookie = cookieFrom(res);
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  if (!cookie) throw new Error('no session cookie');
  return { cookie, csrfToken };
}

export function authHeaders(login: DjLogin, withCsrf = true): Record<string, string> {
  const h: Record<string, string> = { cookie: login.cookie };
  if (withCsrf) h['x-csrf-token'] = login.csrfToken;
  return h;
}

export async function patchStatus(
  baseUrl: string,
  id: string,
  status: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/dj/requests/${id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ status }),
  });
}

export async function seedRequests(baseUrl: string, n: number): Promise<{ id: string; sequenceNumber: number }[]> {
  const out: { id: string; sequenceNumber: number }[] = [];
  for (let i = 1; i <= n; i++) {
    const res = await postJson(`${baseUrl}/api/requests`, { requesterName: `Guest ${i}`, songTitle: `Song ${i}` });
    const body = (await res.json()) as { request: { id: string; sequenceNumber: number } };
    out.push(body.request);
  }
  return out;
}

export interface SseEvent {
  event: string;
  data: unknown;
}

export interface SseClient {
  status: number;
  headers: Headers;
  events: SseEvent[];
  comments: string[];
  /** Resolves true once the server ended the stream. */
  closed: Promise<boolean>;
  waitFor(predicate: (events: SseEvent[]) => boolean, timeoutMs?: number): Promise<void>;
  /** Resolves after `ms`, then returns a copy of all events seen so far. */
  settle(ms: number): Promise<SseEvent[]>;
  abort(): void;
}

/** Minimal Server-Sent Events client built on fetch streaming (no EventSource in Node tests). */
export async function openStream(baseUrl: string, headers: Record<string, string> = {}): Promise<SseClient> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/dj/requests/stream`, {
    headers: { accept: 'text/event-stream', ...headers },
    signal: controller.signal,
  });
  const events: SseEvent[] = [];
  const comments: string[] = [];
  const waiters: Array<() => void> = [];
  let resolveClosed: (v: boolean) => void = () => {};
  const closed = new Promise<boolean>((resolve) => {
    resolveClosed = resolve;
  });

  if (res.status === 200 && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let event = 'message';
            const dataLines: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) comments.push(line.slice(1).trim());
              else if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
            }
            if (dataLines.length > 0) events.push({ event, data: JSON.parse(dataLines.join('\n')) });
            for (const w of waiters.splice(0)) w();
          }
        }
        resolveClosed(true);
      } catch {
        resolveClosed(false);
      }
    })();
  } else {
    resolveClosed(false);
  }

  return {
    status: res.status,
    headers: res.headers,
    events,
    comments,
    closed,
    async waitFor(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(events)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out waiting for SSE condition; saw ${JSON.stringify(events.map((e) => e.event))}`);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Math.min(remaining, 50));
          waiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    },
    async settle(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return [...events];
    },
    abort() {
      controller.abort();
    },
  };
}
