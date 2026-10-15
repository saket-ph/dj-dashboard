/**
 * Representative load test for a RUNNING server (local or deployed). T5.07, NFR-001..003, PRD §17.1.
 *
 *   npm run load-test -- --password "<dj password>" [--base-url http://localhost:3000] [--db ./data/x.sqlite]
 *
 * It simulates up to 100 audience submissions in two shapes (the PRD asks for both):
 *   1. ordinary usage: submissions spread over several seconds
 *   2. a burst: many submissions inside a couple of seconds
 * plus a few "lost response" retries that reuse an idempotency key, a DJ dashboard stream
 * (freshness), and a DJ dashboard poll (list latency).
 *
 * WARNING: this WRITES test rows ("LoadTest N" / "LT-<run>-N") to the target database. Point it at
 * a throwaway database, never at the event's real queue. The server's per-IP submission rate limit
 * must be raised for the run (one machine = one IP); the script reports any 429 it sees.
 *
 * Exit code: 0 = all correctness checks passed, 1 = a correctness check failed or the run could not
 * be verified, 2 = bad usage. Missed latency targets are reported but do not change the exit code.
 */
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { hashPassword } from '../auth/password.js';
import { createSongRequestRepository } from '../db/requestRepository.js';
import { REPO_ROOT } from '../paths.js';

// ---------- options ----------

interface Options {
  baseUrl: string;
  ordinary: number;
  ordinarySeconds: number;
  burst: number;
  burstSeconds: number;
  retries: number;
  password: string | undefined;
  dbPath: string | undefined;
  out: string | undefined;
  allowRemote: boolean;
  /** Start the built server on a temp database (random password, raised rate limit) and test that. */
  spawn: boolean;
}

const P95_TARGET_MS = 500; // NFR-002
const FRESHNESS_TARGET_MS = 2000; // NFR-003

function usage(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    [
      'Usage: npm run load-test -- [options]',
      '  --spawn                 EASIEST: start the built server (npm run build first) on a temporary database',
      '                          with a random DJ password and a raised rate limit, test it, then delete it',
      '  --base-url <url>        server to test (default http://localhost:3000)',
      '  --password <pw>         DJ password: enables the dashboard stream/list checks and API verification',
      '                          (or set LOAD_TEST_DJ_PASSWORD; avoid putting real passwords in shell history)',
      '  --db <path>             SQLite file of the target server, for direct verification (read-only)',
      '  --ordinary <n>          ordinary-traffic submissions (default 40)',
      '  --ordinary-seconds <s>  window they are spread over (default 20)',
      '  --burst <n>             burst submissions (default 60)',
      '  --burst-seconds <s>     window the burst lands in (default 2)',
      '  --retries <n>           lost-response retry pairs (default 5)',
      '  --out <file>            also write the full results as JSON',
      '  --allow-remote          required to test a non-local URL (this writes rows!)',
      '',
      'Without --spawn, at least one of --password / --db is required so acknowledged requests can be verified.',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) usage(`unexpected argument "${a}"`);
    const key = a.slice(2);
    if (key === 'allow-remote' || key === 'help' || key === 'spawn') {
      flags.set(key, true);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) usage(`--${key} needs a value`);
    flags.set(key, value);
    i++;
  }
  if (flags.has('help')) usage();
  const num = (name: string, fallback: number, min: number, max: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) usage(`--${name} must be a number between ${min} and ${max}`);
    return n;
  };
  const str = (name: string): string | undefined => {
    const v = flags.get(name);
    return typeof v === 'string' ? v : undefined;
  };
  const options: Options = {
    baseUrl: (str('base-url') ?? 'http://localhost:3000').replace(/\/+$/, ''),
    ordinary: num('ordinary', 40, 0, 100),
    ordinarySeconds: num('ordinary-seconds', 20, 1, 600),
    burst: num('burst', 60, 0, 100),
    burstSeconds: num('burst-seconds', 2, 0.1, 60),
    retries: num('retries', 5, 0, 20),
    password: str('password') ?? process.env.LOAD_TEST_DJ_PASSWORD,
    dbPath: str('db'),
    out: str('out'),
    allowRemote: flags.get('allow-remote') === true,
    spawn: flags.get('spawn') === true,
  };
  if (options.ordinary + options.burst + options.retries > 120) usage('too many submissions; the target is up to 100 clients');
  if (options.ordinary + options.burst === 0) usage('nothing to do: --ordinary and --burst are both 0');
  if (options.spawn) {
    if (flags.has('base-url') || flags.has('password') || flags.has('db')) {
      usage('--spawn manages its own server, password, and database; do not combine it with --base-url, --password, or --db');
    }
    return options;
  }
  if (!options.password && !options.dbPath) usage('provide --password and/or --db so the run can be verified');

  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    return usage('--base-url must be an absolute URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && !options.allowRemote) {
    usage(`${url.origin} is not local. This test writes rows to that server's database; pass --allow-remote if that is intended.`);
  }
  return options;
}

// ---------- measurement helpers ----------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

interface Stats {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function stats(values: number[]): Stats {
  const s = [...values].sort((a, b) => a - b);
  return {
    count: s.length,
    min: s[0] ?? Number.NaN,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1] ?? Number.NaN,
  };
}

const ms = (n: number): string => (Number.isNaN(n) ? 'n/a' : `${Math.round(n)} ms`);

// ---------- HTTP ----------

interface SubmitResult {
  label: string;
  phase: 'ordinary' | 'burst' | 'retry';
  title: string;
  startedAt: number;
  latencyMs: number;
  status: number; // 0 = network error / timeout
  id?: string;
  sequenceNumber?: number;
  error?: string;
}

async function submit(
  base: string,
  runId: string,
  index: number,
  phase: SubmitResult['phase'],
  key: string = randomBytes(16).toString('hex'),
): Promise<SubmitResult> {
  const title = `LT-${runId}-${index}`;
  const body = {
    requesterName: `LoadTest ${index}`,
    songTitle: title,
    ...(index % 3 === 0 ? { artistName: 'Load Artist' } : {}),
    idempotencyKey: key,
  };
  const startedAt = performance.now();
  try {
    const res = await fetch(`${base}/api/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const latencyMs = performance.now() - startedAt;
    const result: SubmitResult = { label: `#${index}`, phase, title, startedAt, latencyMs, status: res.status };
    try {
      const parsed = JSON.parse(text) as { request?: { id: string; sequenceNumber: number }; error?: { code: string } };
      if (parsed.request) {
        result.id = parsed.request.id;
        result.sequenceNumber = parsed.request.sequenceNumber;
      }
      if (parsed.error) result.error = parsed.error.code;
    } catch {
      result.error = 'NON_JSON_RESPONSE';
    }
    return result;
  } catch (err) {
    return {
      label: `#${index}`,
      phase,
      title,
      startedAt,
      latencyMs: performance.now() - startedAt,
      status: 0,
      error: err instanceof Error ? err.name : 'NETWORK',
    };
  }
}

async function login(base: string, password: string): Promise<{ cookie: string }> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(`DJ login failed with HTTP ${res.status}`);
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const pair = setCookie.map((c) => c.split(';')[0]!).find((c) => c.startsWith('dj_session='));
  if (!pair) throw new Error('DJ login succeeded but no dj_session cookie was returned');
  await res.arrayBuffer();
  return { cookie: pair };
}

interface ListedRequest {
  id: string;
  sequenceNumber: number;
  songTitle: string;
}

async function listRequests(base: string, cookie: string): Promise<ListedRequest[]> {
  const res = await fetch(`${base}/api/dj/requests`, { headers: { cookie } });
  if (!res.ok) throw new Error(`GET /api/dj/requests returned HTTP ${res.status}`);
  return ((await res.json()) as { requests: ListedRequest[] }).requests;
}

/** Minimal SSE reader for the DJ stream: calls onEvent(name, data) for each event until aborted. */
async function readStream(
  url: string,
  cookie: string,
  signal: AbortSignal,
  onEvent: (name: string, data: unknown, at: number) => void,
): Promise<void> {
  const res = await fetch(url, { headers: { cookie, accept: 'text/event-stream' }, signal });
  if (!res.ok || !res.body) throw new Error(`stream returned HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const at = performance.now();
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        let name = 'message';
        const dataLines: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        try {
          onEvent(name, JSON.parse(dataLines.join('\n')), at);
        } catch {
          /* ignore malformed event */
        }
      }
    }
  } catch (err) {
    if (signal.aborted) return;
    throw err;
  }
}

// ---------- run ----------

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

async function runPhase(
  base: string,
  runId: string,
  phase: 'ordinary' | 'burst',
  count: number,
  seconds: number,
  firstIndex: number,
): Promise<SubmitResult[]> {
  const jobs: Array<Promise<SubmitResult>> = [];
  for (let i = 0; i < count; i++) {
    const delay = Math.random() * seconds * 1000;
    jobs.push(sleep(delay).then(() => submit(base, runId, firstIndex + i, phase)));
  }
  return Promise.all(jobs);
}

// ---------- --spawn: a private server for a repeatable run ----------

interface SpawnedServer {
  baseUrl: string;
  password: string;
  dbPath: string;
  /** Server-side handling time (ms) of requests matching the filter, from the server's own log. */
  serverTimes(match: (r: { method: string; path: string; status: number }) => boolean): number[];
  stop(): Promise<void>;
  killSync(): void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function startSpawned(): Promise<SpawnedServer> {
  const entry = path.join(REPO_ROOT, 'apps', 'api', 'dist', 'server.js');
  if (!fs.existsSync(entry)) {
    console.error('apps/api/dist/server.js not found. Run "npm run build" first, or point --base-url at a running server.');
    process.exit(1);
  }
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-loadtest-'));
  const password = randomBytes(12).toString('base64url');
  const dbPath = path.join(dir, 'loadtest.sqlite');
  const child: ChildProcess = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_PATH: dbPath,
      PUBLIC_BASE_URL: `http://localhost:${port}`,
      SESSION_SECRET: randomBytes(32).toString('base64url'),
      DJ_PASSWORD_HASH: await hashPassword(password),
      // One machine is one IP: lift the per-IP limits so the limiter does not hide server behavior.
      SUBMISSION_RATE_LIMIT_MAX: '100000',
      LOGIN_RATE_LIMIT_MAX: '100000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const httpLog: Array<{ method: string; path: string; status: number; ms: number }> = [];
  let output = '';
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
  });
  const onData = (chunk: Buffer): void => {
    output += chunk.toString('utf8');
    let nl: number;
    while ((nl = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, nl);
      output = output.slice(nl + 1);
      const at = line.indexOf(' INFO http {');
      if (at >= 0) {
        try {
          httpLog.push(JSON.parse(line.slice(at + ' INFO http '.length)));
        } catch {
          /* ignore */
        }
      }
      if (line.includes('server listening')) ready();
    }
  };
  let ready: () => void = () => undefined;
  const listening = new Promise<void>((resolve) => {
    ready = resolve;
  });
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const removeDir = (): void => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort; the OS temp cleaner will get it */
    }
  };
  const killSync = (): void => {
    if (!exited) child.kill();
    removeDir();
  };

  const outcome = await Promise.race([
    listening.then(() => 'up' as const),
    exitPromise.then(() => 'exited' as const),
    sleep(15_000).then(() => 'timeout' as const),
  ]);
  if (outcome !== 'up') {
    killSync();
    console.error(`The spawned server did not start (${outcome}).`);
    process.exit(1);
  }

  return {
    baseUrl: `http://localhost:${port}`,
    password,
    dbPath,
    serverTimes: (match) => httpLog.filter(match).map((r) => r.ms),
    async stop() {
      if (!exited) child.kill();
      await exitPromise;
      removeDir();
    },
    killSync,
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  let spawned: SpawnedServer | undefined;
  if (parsed.spawn) {
    spawned = await startSpawned();
    process.on('exit', () => spawned?.killSync()); // also covers early process.exit() paths
  }
  const options: Options = spawned
    ? { ...parsed, baseUrl: spawned.baseUrl, password: spawned.password, dbPath: spawned.dbPath }
    : parsed;
  const base = options.baseUrl;
  const runId = randomBytes(3).toString('hex');
  const startedWall = new Date();

  // Preflight: fail fast with a readable message, never a stack trace.
  try {
    const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    console.error(`Cannot reach ${base}/api/health (${err instanceof Error ? err.message : 'unknown error'}). Is the server running?`);
    process.exit(1);
  }

  let cookie: string | undefined;
  if (options.password) {
    try {
      cookie = (await login(base, options.password)).cookie;
    } catch (err) {
      console.error(`${err instanceof Error ? err.message : 'DJ login failed'}. Check --password and the server's login rate limit.`);
      process.exit(1);
    }
  }

  // Dashboard observers: a live stream (freshness) and a polled list (list latency).
  const streamAbort = new AbortController();
  const seenAt = new Map<string, number>(); // title -> time the stream delivered request.created
  let snapshotSeen = false;
  let streamError: string | undefined;
  const streamTask = cookie
    ? readStream(`${base}/api/dj/requests/stream`, cookie, streamAbort.signal, (name, data, at) => {
        if (name === 'snapshot') snapshotSeen = true;
        if (name === 'request.created') {
          const title = (data as { songTitle?: string }).songTitle;
          if (title && !seenAt.has(title)) seenAt.set(title, at);
        }
      }).catch((err: unknown) => {
        streamError = err instanceof Error ? err.message : 'stream failed';
      })
    : Promise.resolve();
  if (cookie) await sleep(500); // let the stream connect before traffic starts

  const listLatencies: number[] = [];
  const listFailures: number[] = [];
  let polling = true;
  const pollTask = cookie
    ? (async () => {
        while (polling) {
          const t = performance.now();
          try {
            const res = await fetch(`${base}/api/dj/requests`, { headers: { cookie: cookie! } });
            await res.arrayBuffer();
            if (res.ok) listLatencies.push(performance.now() - t);
            else listFailures.push(res.status);
          } catch {
            listFailures.push(0);
          }
          await sleep(1000);
        }
      })()
    : Promise.resolve();

  console.log(`Load test ${runId} against ${base}`);
  console.log(`  ordinary: ${options.ordinary} over ${options.ordinarySeconds}s, burst: ${options.burst} within ${options.burstSeconds}s, retry pairs: ${options.retries}`);

  const runStart = performance.now();
  const all: SubmitResult[] = [];

  console.log('Phase 1/3: ordinary traffic...');
  all.push(...(await runPhase(base, runId, 'ordinary', options.ordinary, options.ordinarySeconds, 1)));

  console.log('Phase 2/3: burst...');
  all.push(...(await runPhase(base, runId, 'burst', options.burst, options.burstSeconds, options.ordinary + 1)));

  console.log('Phase 3/3: lost-response retries (same key sent twice at once)...');
  const retryResults: Array<[SubmitResult, SubmitResult]> = [];
  const retryBase = options.ordinary + options.burst;
  for (let i = 1; i <= options.retries; i++) {
    const key = randomBytes(16).toString('hex');
    const pair = await Promise.all([
      submit(base, runId, retryBase + i, 'retry', key),
      submit(base, runId, retryBase + i, 'retry', key),
    ]);
    retryResults.push(pair);
  }
  const runDurationMs = performance.now() - runStart;

  // Give the stream a moment to deliver the last events, then stop the observers.
  const settleDeadline = performance.now() + 5000;
  const acknowledgedTitles = (): string[] =>
    [...all, ...retryResults.flat()].filter((r) => r.status === 201 || r.status === 200).map((r) => r.title);
  while (cookie && performance.now() < settleDeadline && acknowledgedTitles().some((t) => !seenAt.has(t))) {
    await sleep(100);
  }
  polling = false;
  streamAbort.abort();
  await Promise.all([pollTask, streamTask]);

  // ---------- verification ----------

  const everything = [...all, ...retryResults.flat()];
  const acked = everything.filter((r) => (r.status === 201 || r.status === 200) && r.id !== undefined);
  const created = everything.filter((r) => r.status === 201);
  const checks: Check[] = [];

  // Source of truth: SQLite (directly if --db, otherwise via the authenticated API).
  let stored: ListedRequest[] | undefined;
  let storedFrom = '';
  if (options.dbPath) {
    const file = path.resolve(REPO_ROOT, options.dbPath);
    if (!fs.existsSync(file)) {
      console.error(`--db file not found: ${file}`);
      process.exit(1);
    }
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      stored = createSongRequestRepository(db).list();
      storedFrom = 'SQLite file';
    } finally {
      db.close();
    }
  } else if (cookie) {
    stored = await listRequests(base, cookie);
    storedFrom = 'DJ API (reads SQLite)';
  }
  if (!stored) {
    console.error('Could not read stored requests for verification.');
    process.exit(1);
  }

  const mine = stored.filter((r) => r.songTitle.startsWith(`LT-${runId}-`));
  const byId = new Map(mine.map((r) => [r.id, r]));

  const seqCounts = new Map<number, number>();
  for (const r of stored) seqCounts.set(r.sequenceNumber, (seqCounts.get(r.sequenceNumber) ?? 0) + 1);
  const duplicateSeqs = [...seqCounts.entries()].filter(([, n]) => n > 1).map(([s]) => s);
  checks.push({
    name: 'No duplicate sequence numbers',
    pass: duplicateSeqs.length === 0,
    detail: duplicateSeqs.length === 0 ? `${stored.length} stored rows, all sequences unique` : `duplicated: ${duplicateSeqs.slice(0, 10).join(', ')}`,
  });

  const missing = acked.filter((r) => {
    const row = byId.get(r.id!);
    return !row || row.sequenceNumber !== r.sequenceNumber || row.songTitle !== r.title;
  });
  checks.push({
    name: 'Every acknowledged request is stored with the sequence it was told',
    pass: missing.length === 0,
    detail: `${acked.length} acknowledged responses checked against ${storedFrom}; ${missing.length} missing or mismatched`,
  });

  const distinctAckedIds = new Set(acked.map((r) => r.id));
  const extraRows = mine.filter((r) => !distinctAckedIds.has(r.id));
  checks.push({
    name: 'No stored row without an acknowledgement (no ghost or duplicate rows)',
    pass: extraRows.length === 0,
    detail:
      extraRows.length === 0
        ? `${mine.length} rows for this run = ${distinctAckedIds.size} distinct acknowledged requests`
        : `${extraRows.length} stored but never acknowledged (client timeout or duplicate): ${extraRows.slice(0, 5).map((r) => r.songTitle).join(', ')}`,
  });

  const retryProblems = retryResults.filter(([a, b]) => {
    const ok = (x: SubmitResult): boolean => x.status === 200 || x.status === 201;
    if (!ok(a) || !ok(b)) return true;
    if (a.id !== b.id || a.sequenceNumber !== b.sequenceNumber) return true;
    return mine.filter((r) => r.songTitle === a.title).length !== 1;
  });
  checks.push({
    name: 'Retrying with the same idempotency key creates exactly one row',
    pass: retryProblems.length === 0,
    detail: `${retryResults.length} concurrent same-key pairs; ${retryProblems.length} created a second row or got different answers`,
  });

  const unexpected = everything.filter((r) => ![200, 201, 429].includes(r.status));
  checks.push({
    name: 'No unexpected errors (5xx, network errors, timeouts, non-JSON)',
    pass: unexpected.length === 0,
    detail:
      unexpected.length === 0
        ? 'none'
        : `${unexpected.length}: ` + [...new Set(unexpected.map((r) => `${r.status || 'network'} ${r.error ?? ''}`.trim()))].join(', '),
  });

  const limited = everything.filter((r) => r.status === 429);
  checks.push({
    name: 'Submission rate limit did not interfere with the test',
    pass: limited.length === 0,
    detail:
      limited.length === 0
        ? 'no 429 responses'
        : `${limited.length} submissions were rate limited (429). Restart the server with a higher SUBMISSION_RATE_LIMIT_MAX for this test; results below under-count the load.`,
  });

  if (cookie) {
    checks.push({
      name: 'Dashboard stream connected and sent a snapshot',
      pass: snapshotSeen && streamError === undefined,
      detail: streamError ? `stream error: ${streamError}` : snapshotSeen ? 'snapshot received' : 'no snapshot received',
    });
    checks.push({
      name: 'Dashboard list stayed available during the run',
      pass: listFailures.length === 0 && listLatencies.length > 0,
      detail: `${listLatencies.length} polls ok, ${listFailures.length} failed`,
    });
  }

  // ---------- numbers ----------

  const phaseStats = (phase: SubmitResult['phase']): Stats =>
    stats(everything.filter((r) => r.phase === phase && (r.status === 201 || r.status === 200)).map((r) => r.latencyMs));
  const submitAll = stats(acked.map((r) => r.latencyMs));
  const freshness: number[] = [];
  let notObserved = 0;
  if (cookie) {
    for (const r of created) {
      const at = seenAt.get(r.title);
      if (at === undefined) notObserved++;
      else freshness.push(Math.max(0, at - r.startedAt));
    }
  }
  const freshnessStats = stats(freshness);
  const listStats = stats(listLatencies);

  const statusCounts: Record<string, number> = {};
  for (const r of everything) statusCounts[String(r.status)] = (statusCounts[String(r.status)] ?? 0) + 1;

  // NFR-002 excludes client network latency, so prefer the server's own timing when we have it (--spawn).
  const serverPost = spawned
    ? stats(spawned.serverTimes((r) => r.method === 'POST' && r.path === '/api/requests' && (r.status === 201 || r.status === 200)))
    : undefined;
  const serverList = spawned
    ? stats(spawned.serverTimes((r) => r.method === 'GET' && r.path === '/api/dj/requests' && r.status === 200))
    : undefined;
  const p95Basis = serverPost ? 'server time' : 'end to end from this client';
  const p95Value = serverPost ? serverPost.p95 : submitAll.p95;

  const targets = {
    p95: { target: P95_TARGET_MS, value: p95Value, basis: p95Basis, met: p95Value < P95_TARGET_MS },
    freshness: cookie
      ? { target: FRESHNESS_TARGET_MS, value: freshnessStats.max, met: freshnessStats.max < FRESHNESS_TARGET_MS && notObserved === 0 }
      : undefined,
  };

  const results = {
    runId,
    startedAt: startedWall.toISOString(),
    environment: {
      target: base,
      client: `${os.platform()} ${os.arch()}, ${os.cpus().length} CPUs, Node ${process.version}`,
      verifiedAgainst: storedFrom,
      note: 'clientLatency is end to end from this client (includes connection setup and client overhead). serverLatency, when present, is the server\'s own handling time from its request log.',
      spawnedPrivateServer: Boolean(spawned),
    },
    plan: {
      ...options,
      password: undefined,
      // Do not record local temp paths in a file that is meant to be committed.
      ...(spawned ? { baseUrl: '(private server on a free local port)', dbPath: '(temporary database, deleted after the run)' } : {}),
    },
    totals: {
      requestsSent: everything.length,
      acknowledged: acked.length,
      created201: created.length,
      statusCounts,
      durationSeconds: Number((runDurationMs / 1000).toFixed(1)),
      throughputPerSecond: Number((everything.length / (runDurationMs / 1000)).toFixed(1)),
    },
    submitLatencyMs: { overall: submitAll, ordinary: phaseStats('ordinary'), burst: phaseStats('burst'), retry: phaseStats('retry') },
    serverLatencyMs: serverPost ? { postRequests: serverPost, listRequests: serverList } : undefined,
    dashboard: cookie
      ? {
          streamFreshnessMs: freshnessStats,
          eventsNotObserved: notObserved,
          listLatencyMs: listStats,
          freshnessDefinition: 'time from starting the POST to the stream delivering request.created (includes the POST itself, so it is conservative)',
        }
      : undefined,
    checks,
    targets,
  };

  // ---------- report ----------

  const line = (label: string, s: Stats): string => `  ${label.padEnd(10)} n=${String(s.count).padEnd(4)} p50 ${ms(s.p50).padEnd(8)} p95 ${ms(s.p95).padEnd(8)} p99 ${ms(s.p99).padEnd(8)} max ${ms(s.max)}`;
  console.log('\n=== Results ===');
  console.log(`Requests sent: ${everything.length} in ${results.totals.durationSeconds}s (${results.totals.throughputPerSecond}/s avg). Status counts: ${JSON.stringify(statusCounts)}`);
  console.log('POST /api/requests latency (end to end, this client):');
  console.log(line('overall', submitAll));
  console.log(line('ordinary', phaseStats('ordinary')));
  console.log(line('burst', phaseStats('burst')));
  console.log(line('retry', phaseStats('retry')));
  if (serverPost && serverList) {
    console.log('Server-side handling time (from the server log):');
    console.log(line('POST', serverPost));
    console.log(line('list GET', serverList));
  }
  if (cookie) {
    console.log('Dashboard:');
    console.log(line('freshness', freshnessStats) + `  (not observed: ${notObserved})`);
    console.log(line('list GET', listStats));
  }
  console.log('\nCorrectness checks:');
  for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name} - ${c.detail}`);
  console.log('\nTargets (reported, do not affect exit code):');
  console.log(`  [${targets.p95.met ? 'MET' : 'MISSED'}] NFR-002 p95 < ${P95_TARGET_MS} ms: measured ${ms(targets.p95.value)} (${targets.p95.basis})`);
  if (targets.freshness) {
    console.log(`  [${targets.freshness.met ? 'MET' : 'MISSED'}] NFR-003 dashboard freshness < ${FRESHNESS_TARGET_MS} ms: worst ${ms(targets.freshness.value)}, not observed ${notObserved}`);
  }
  console.log(
    spawned
      ? '\nThe private test server and its temporary database have been removed.'
      : `\nTest rows were written with titles "LT-${runId}-N". Use a throwaway database; delete it afterward.`,
  );

  if (options.out) {
    const file = path.resolve(REPO_ROOT, options.out); // npm workspaces run scripts from apps/api, so anchor to the repo root
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(results, null, 2) + '\n');
    console.log(`Full results written to ${file}`);
  }

  await spawned?.stop();
  process.exit(checks.every((c) => c.pass) ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(`Load test failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exit(1);
});
