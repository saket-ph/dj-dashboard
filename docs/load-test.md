# Load test results (T5.07, NFR-001 to NFR-003, T-024)

Run on **2026-10-14** with `npm run load-test -- --spawn`. The raw numbers are in
[`load-test-results.json`](load-test-results.json) (mixed run) and
[`load-test-burst-results.json`](load-test-burst-results.json) (burst run).

## What was simulated

The script (`apps/api/src/scripts/load-test.ts`) starts the **built production server** on a free
port with a temporary SQLite file, a random DJ password, and the per-IP rate limits raised
(one machine is one IP, so the default 30 submissions per minute per IP would otherwise hide the
server's behavior). It then drives it over real HTTP:

| Phase | Mixed run | Burst run |
| --- | --- | --- |
| Ordinary traffic: submissions spread randomly over a window | 40 over 20 s | none |
| Burst: submissions landing close together | 60 within 2 s | **100 within 1 s** |
| Lost-response retries: the same idempotency key sent twice at once | 5 pairs | none |
| DJ dashboard stream (freshness) and a list poll once per second | yes | yes |

The PRD says not to assume all 100 attendees submit at once, so the mixed run is the realistic
shape and the burst run is the deliberately harsh one.

## Environment and assumptions

- **Machine:** Windows 11 (x64), 12 CPUs, Node v26.7.0. Client and server on the same machine over
  loopback, so there is **no real network latency** in these numbers.
- **Server:** `NODE_ENV=production`, plain HTTP on localhost, SQLite in the OS temp directory (WAL mode).
- **Rate limits:** raised for the test. Default limits are verified separately by automated tests.
- **Not covered:** a real deployed host, a TLS-terminating proxy in front of the app, real phones on
  mobile networks, and sustained load beyond the runs above. Re-run against the real deployment
  (see "Running it yourself") before the event.

## Results

### Mixed run (110 submissions in 22 s)

| Measure | Result |
| --- | --- |
| Requests sent / acknowledged | 110 / 110 (105 created `201`, 5 same-key replays `200`) |
| Errors, rate limits, timeouts | 0 |
| **Server handling time**, `POST /api/requests` | p50 2.4 ms, **p95 4.3 ms**, p99 6.5 ms, max 6.7 ms |
| Server handling time, `GET /api/dj/requests` | p50 1.4 ms, p95 2.5 ms, max 3 ms |
| Client end-to-end `POST` latency | p50 11.5 ms, p95 146 ms, max 329 ms |
| **Dashboard freshness** (POST start to `request.created` received on the stream) | p50 17.5 ms, p95 146 ms, **max 329 ms**, 0 events missed |
| Duplicate sequence numbers | none (105 stored rows, all unique) |
| Acknowledged requests missing from SQLite | none (checked by reading the SQLite file directly) |
| Rows that were never acknowledged | none |
| Same-key retries that created a second row | none (5 pairs, 1 row each) |

### Burst run (100 submissions inside 1 second)

| Measure | Result |
| --- | --- |
| Requests sent / acknowledged | 100 / 100, all `201` |
| Server handling time, `POST` | p50 1.5 ms, **p95 3.6 ms**, max 10.4 ms |
| Client end-to-end `POST` latency | p50 9.9 ms, p95 40 ms, max 50 ms |
| Dashboard freshness | p95 41 ms, max 52 ms, 0 events missed |
| Duplicate sequences / missing rows | none / none |

### Against the targets

| Target | Result | Status |
| --- | --- | --- |
| NFR-001 up to 100 attendees, no loss | 100 submissions in 1 s and 110 in a mixed run, all stored with unique sequences | **met** (loopback) |
| NFR-002 p95 API latency under 500 ms, excluding client network | server p95 4.3 ms (mixed), 3.6 ms (burst) | **met** |
| NFR-003 dashboard freshness within 2 s | worst 329 ms (mixed), 52 ms (burst) | **met** (loopback) |
| T-024 correctness: unique sequences, no acknowledged request missing, no unhandled errors, write contention handled | all checks `PASS` | **met** |

## Reading the client-side outliers

The 300 to 450 ms worst cases seen in the mixed run's client columns (across several runs while
developing this script; the committed run's worst case is 329 ms) are **not server handling time**:
the server's own log shows every request handled in at most about 13 ms. The slowest samples
cluster in the sparse "ordinary" phase (p95 256 ms) rather than in the dense burst (p95 83 ms), and
the separate burst run never exceeded 53 ms. That pattern points at a cost in the Windows test
client (for example opening a fresh connection after an idle gap), not at server load, but **the
exact cause was not isolated**. Because the server measures only its own handler time, it cannot see
delays before a request reaches it. Treat the client columns as an upper bound on what a user would
see on loopback, and re-measure on the real deployment. Freshness is measured from the moment the
POST starts, so it includes the same client-side delay and is therefore conservative. A real
deployment adds network latency on top of both. Exact numbers vary a little from run to run.

## What the checks prove

- **No duplicate sequence numbers:** every stored row in the database has a unique `sequence_number`.
- **No acknowledged request missing:** each `201`/`200` response is matched, by id, sequence number,
  and title, to a row read from the SQLite file itself (not from an API response).
- **No ghost or duplicate rows:** the number of stored rows for the run equals the number of
  distinct acknowledged requests.
- **Retries are safe:** two simultaneous submissions with one idempotency key give identical answers
  and exactly one row.
- **Write contention:** the concurrency tests (`apps/api/test/hardening.test.ts`) additionally prove
  that separate database connections writing at once never share a sequence.

## Running it yourself

```bash
npm run build
npm run load-test -- --spawn --out docs/load-test-results.json
```

`--spawn` is self-contained and leaves nothing behind. To test a server that is already running
(for example the real deployment before the event), use a **throwaway database**, not the event
queue, because the test writes rows titled `LT-<run>-<n>`:

```bash
# the target server must be started with a high SUBMISSION_RATE_LIMIT_MAX for the run
npm run load-test -- --base-url https://staging.example.com --allow-remote --password "<dj password>"
```

The exit code is `0` when all correctness checks pass and `1` otherwise. Missed latency targets are
printed as `MISSED` but do not change the exit code.
