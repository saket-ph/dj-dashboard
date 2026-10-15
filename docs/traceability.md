# Requirement-to-test traceability (PRD §21, T5.08)

Status key: **pass** = verified by an automated test and/or a recorded manual check; **gap** = not verified, called out below.

## Gaps and limits to know before the event

No P0 requirement is failing, but these things have **not** been verified, and the organizer should know:

| # | Gap | Affects | What to do |
| --- | --- | --- | --- |
| G1 | **Never deployed to a real HTTPS host.** The README runbook was followed in a clean copy of the repository (install, build, test, configure, QR, start in production mode) on localhost only. TLS, a real reverse proxy, `TRUST_PROXY` behind a proxy, and SSE through a proxy were **not** exercised. | NFR-010, NFR-011, FR-041 | Follow the runbook on the real host, then run the [event readiness checklist](../README.md#event-readiness-checklist) items 5 to 12 against the real URL |
| G2 | **The printed QR code has not been scanned by two real phones.** The code is generated and decoded by a test, and its payload is proven to be exactly the audience URL, but printing and scanning is a physical step. | FR-038, FR-041, T-019 | Checklist item 13 |
| G3 | **Dashboard freshness was measured by script, not from a second physical device on a real network.** Measured worst case 329 ms on loopback (limit 2 s). | NFR-003 | Checklist item 9 |
| G4 | **Only Chromium was used for manual browser checks.** Safari (iOS) and Firefox were not tried by hand. The layout uses standard CSS and no vendor-specific APIs, and EventSource is supported everywhere, but this is unverified. | FR-002 | Open the audience page on one iPhone and one Android phone during checklist item 7 |
| G5 | **Load test numbers are loopback-only** (no network latency, no TLS, one machine). | NFR-001, NFR-002, T-024 | Re-run against the deployed app using a throwaway database (see `docs/load-test.md`) |
| G6 | **The queue does not survive storage replacement.** This is an accepted MVP limit (PRD §5, §18.1), documented in the README, not a defect. | FR-053, NFR-013, T-023 | None. Do not redeploy onto new storage during the event |

## Manual checks recorded

| ID | Check | When | Result |
| --- | --- | --- | --- |
| M-01 | Real browser: submit, loading state, success, validation error keeps input, page refresh, API restart keeps the queue, sequence continues | Phase 1 | pass |
| M-02 | Real browser: DJ login failure and success, mark played and skipped, refresh keeps statuses, logout | Phase 2 | pass |
| M-03 | Real browser: new request appears on the dashboard in about 107 ms; stopping the API shows "Offline — retrying"; requests committed during the outage appear after reconnect; counts match SQLite | Phase 3 | pass |
| M-04 | Production build in a 360 × 740 browser viewport: audience page and DJ dashboard (with a 100-character unbroken song title) have no horizontal scrolling; every input and button is 48 px or taller (row actions 52 px); input text is 16 px; DJ login works under the strict CSP with the `Secure` cookie, and `document.cookie` cannot see the session cookie | Phase 4 | pass |
| M-05 | Production build: a song title containing `<img onerror>` and `<script>` arrives live on the dashboard and is shown as literal text; no element is injected | Phase 4 | pass |
| M-06 | Clean copy of the repository (no `node_modules`, `dist`, data, or `.env`): `npm ci`, `npm run build`, `npm test` (125 API + 103 web), `npm run hash-password`, `.env` setup, `npm run qr`, `npm start` in production mode with `HOST=127.0.0.1`, health, page shell, `401` on the DJ API, and a small load test with default rate limits | Phase 5 | pass (localhost only, see G1) |
| M-07 | Load tests: mixed run (110 submissions) and a 100-in-1-second burst, verified against the SQLite file. See `docs/load-test.md` | Phase 5 | pass (see G5) |
| M-08 | README inspection: temporary-storage limit, data-loss table, URL-change effect for the QR code, no-backup statement, password rotation, new-queue steps, health check, troubleshooting | Phase 5 | pass |

## Test index (PRD §17)

API tests are in `apps/api/test/` (Node test runner); web tests are beside the code in `apps/web/src/` (Vitest).

| Test ID | Scenario | Automated coverage | Status |
| --- | --- | --- | --- |
| T-001 | Valid request | `requests.test.ts` "creates exactly one row and returns 201"; `AudiencePage.test.tsx` success flow; M-01 | pass |
| T-002 | Missing name | `requests.test.ts`, `validation.test.ts` "missing or blank requester name" | pass |
| T-003 | Missing song | `requests.test.ts`, `validation.test.ts` "missing or blank song title" | pass |
| T-004 | Artist omitted | `requests.test.ts` "omitted artist and stores NULL"; `validation.test.ts` | pass |
| T-005 | Input over limit | `requests.test.ts` "over-long input"; `validation.test.ts`; `database.test.ts` constraints | pass |
| T-006 | Double-click submit | `AudiencePage.test.tsx` "ignores a second click"; `submitLock.test.ts`; `hardening.test.ts` "overlapping retries of one key create exactly one row" | pass |
| T-007 | Database write failure | `requests.test.ts` "never returns success when the database write fails"; `stream.test.ts` "a failed insert emits no event and no row" | pass |
| T-008 | Concurrent submissions | `hardening.test.ts` concurrent sequence assignment (parallel HTTP and separate database connections); `load-test.md` | pass |
| T-009 | Queue ordering | `dj.test.ts` ordering tests (including identical timestamps); `hardening.test.ts` "list order follows sequence numbers"; `queue.test.ts`; `Dashboard.test.tsx` | pass |
| T-010 | DJ login success | `auth.test.ts` login and logout; `DjPage.test.tsx`; M-02 | pass |
| T-011 | DJ login failure | `auth.test.ts` "rejects a wrong password"; `DjPage.test.tsx` wrong password | pass |
| T-012 | Unauthenticated DJ API call | `dj.test.ts` "rejects every DJ endpoint without a session"; `hardening.test.ts` unauthenticated sweep; `stream.test.ts` 401 | pass |
| T-013 | Mark played | `dj.test.ts` "marks played and skipped, persists, and keeps sequence numbers unchanged"; `Dashboard.test.tsx` | pass |
| T-014 | Mark skipped | same as T-013 | pass |
| T-015 | Audience refresh | `requests.test.ts` persistence tests (T-015); M-01 | pass |
| T-016 | Dashboard refresh | `dj.test.ts` GET list; `Dashboard.test.tsx` load, retry, and snapshot replace; M-02 | pass |
| T-017 | Backend restart | `requests.test.ts` "keeps committed requests after the server restarts"; `dj.test.ts` "DJ sees persisted statuses after the server restarts"; M-01 | pass |
| T-018 | Dashboard reconnect | `stream.test.ts` "requests committed while disconnected appear in the next snapshot"; `liveConnection.test.ts` (12); `Dashboard.test.tsx` live updates; M-03 | pass |
| T-019 | QR after restart | `qr.test.ts` (decode, deterministic, no tokens); G2 for the printed copy | pass (printed scan: G2) |
| T-020 | Rate limit exceeded | `hardening.test.ts` submission and login rate limiting | pass |
| T-021 | Missing database file | `database.test.ts` T-021 tests | pass |
| T-022 | Existing database at startup | `database.test.ts` "does not clear an existing valid database on startup" | pass |
| T-023 | Database file lost in redeploy | `database.test.ts` (starts empty and says so); README data-loss table (M-08). Limit documented, not testable by deleting production disks | pass (G6) |
| T-024 | 100-attendee load | `apps/api/src/scripts/load-test.ts`; `docs/load-test.md` | pass (G5) |
| T-025 | Unsafe text | `Dashboard.test.tsx` "Safe rendering of untrusted text"; `sourceHygiene.test.ts`; `hardening.test.ts` "unsafe text is stored and returned as plain data"; M-05 | pass |

## Functional requirements

Module paths are relative to `apps/api/src/` (API) or `apps/web/src/` (web). Phase = the implementation phase in `tasks.md` where it was built.

| ID | Pri | Phase | Where | Verification | Status |
| --- | --- | --- | --- | --- | --- |
| FR-001 | P0 | 1 | `pages/AudiencePage.tsx`, static serving in `app.ts` | `AudiencePage.test.tsx` labelled form; `static.test.ts` SPA fallback; M-01 | pass |
| FR-002 | P0 | 1, 4 | `styles.css` | M-04 (360 px); `contrast.test.ts` touch targets | pass (Chromium only, G4) |
| FR-003 | P0 | 1 | `routes/publicRoutes.ts` | `AudiencePage.test.tsx` no login field; `dj.test.ts` "POST /api/requests stays public" | pass |
| FR-004 | P0 | 1 | `validation.ts` | T-002 | pass |
| FR-005 | P0 | 1 | `validation.ts` | T-003 | pass |
| FR-006 | P0 | 1 | `validation.ts` | T-004 | pass |
| FR-007 | P0 | 1 | `validation.ts` | `validation.test.ts`; `requests.test.ts` over HTTP | pass |
| FR-008 | P0 | 1 | `pages/AudiencePage.tsx` | `AudiencePage.test.tsx` in-flight state | pass |
| FR-009 | P0 | 1 | `routes/publicRoutes.ts`, `db/requestRepository.ts` | T-007; `AudiencePage.test.tsx` no success while pending | pass |
| FR-010 | P0 | 1, 4 | `lib/messages.ts` | `messages.test.ts`; `AudiencePage.test.tsx` per-error messages | pass |
| FR-011 | P0 | 1, 4 | `lib/submitLock.ts` | T-006 | pass |
| FR-012 | P1 | 4 | `lib/attemptKey.ts`, `db/requestRepository.ts` | `hardening.test.ts` idempotency; `attemptKey.test.ts`; `AudiencePage.test.tsx` retry keys | pass |
| FR-013 | P0 | 1 | `pages/AudiencePage.tsx` | `AudiencePage.test.tsx` clears on success, keeps on failure | pass |
| FR-014 | P0 | 1, 3 | `routes/publicRoutes.ts`, `realtime/hub.ts` | `stream.test.ts` "exactly one request.created event and one SQLite row"; `Dashboard.test.tsx` | pass |
| FR-015 | P0 | 1 | `db/requestRepository.ts` | `database.test.ts` unique ids | pass |
| FR-016 | P0 | 1 | `db/requestRepository.ts` | `database.test.ts` UTC timestamps | pass |
| FR-017 | P0 | 1 | `db/requestRepository.ts` | `database.test.ts`; T-008 | pass |
| FR-018 | P0 | 2 | `routes/djRoutes.ts`, `lib/queue.ts` | T-009 | pass |
| FR-019 | P0 | 2 | `components/RequestRow.tsx` | `dj.test.ts` response shape; `Dashboard.test.tsx` rows | pass |
| FR-020 | P0 | 1, 4 | `db/requestRepository.ts` (`BEGIN IMMEDIATE`) | T-008 (mutation-checked: removing `BEGIN IMMEDIATE` fails the contention test) | pass |
| FR-021 | P0 | 2 | `routes/djRoutes.ts` | T-013; `queue.test.ts` "keeps the sequence of a request when its status changes" | pass |
| FR-022 | P0 | 1, 2 | `db/schema.ts` check constraint | `database.test.ts` constraints; `dj.test.ts` rejects invalid status | pass |
| FR-023 | P0 | 2 | `components/Dashboard.tsx` | `Dashboard.test.tsx` "splits pending from history" | pass |
| FR-024 | P0 | 2 | `components/Dashboard.tsx` | `dj.test.ts` empty list; `Dashboard.test.tsx` empty state | pass |
| FR-025 | P0 | 2 | `pages/DjPage.tsx`, `app.ts` | `DjPage.test.tsx`; `static.test.ts` `/dj` | pass |
| FR-026 | P0 | 2 | `auth/session.ts`, `routes/djRoutes.ts` | T-012; `DjPage.test.tsx` gate | pass |
| FR-027 | P0 | 2 | `config.ts`, `auth/password.ts` | `config.test.ts`; `auth.test.ts` password verification | pass |
| FR-028 | P0 | 2, 4 | `logger.ts`, `http/requestLogger.ts` | `auth.test.ts` "never logs the attempted password"; `hardening.test.ts` no secrets in logs; `sourceHygiene.test.ts` | pass |
| FR-029 | P0 | 2 | `routes/authRoutes.ts` | T-010; T-011 | pass |
| FR-030 | P0 | 2 | `routes/authRoutes.ts` | `auth.test.ts` logout; `Dashboard.test.tsx` logout; `stream.test.ts` logout closes stream | pass |
| FR-031 | P0 | 2 | `auth/session.ts`, `db/sessionRepository.ts` | `auth.test.ts` "rejects an expired session"; `stream.test.ts` expiry; `DjPage.test.tsx` expiry | pass |
| FR-032 | P1 | 4 | `http/rateLimit.ts`, `app.ts` | T-020 | pass |
| FR-033 | P0 | 2 | `routes/djRoutes.ts`, `routes/streamRoutes.ts` | T-012 | pass |
| FR-034 | P0 | 2 | `routes/djRoutes.ts` | T-013; `Dashboard.test.tsx` | pass |
| FR-035 | P0 | 2 | `routes/djRoutes.ts` | T-014 | pass |
| FR-036 | P0 | 2 | `db/requestRepository.ts` | T-013, T-017 | pass |
| FR-037 | P0 | 2, 3 | `components/Dashboard.tsx`, `lib/liveConnection.ts` | `liveConnection.test.ts`; `Dashboard.test.tsx` states; M-03 | pass |
| FR-038 | P0 | 1 | `qr.ts` | T-019 | pass |
| FR-039 | P0 | 1 | `qr.ts` | `qr.test.ts` deterministic | pass |
| FR-040 | P0 | 1 | `qr.ts` | `qr.test.ts` "contains no token, request id, or session data" | pass |
| FR-041 | P0 | 1, 5 | `scripts/qr.ts`, README | `qr.test.ts`; M-06 ran `npm run qr`; print procedure in README (printed copy: G2) | pass (G2) |
| FR-042 | P0 | 1 | `qr.ts`, `config.ts` | `qr.test.ts` not `/dj`; `config.test.ts` | pass |
| FR-043 | P0 | 5 | README "QR code: generate and print" | M-08 | pass |
| FR-044 | P0 | 1 | `db/*` | `database.test.ts`; `requests.test.ts` | pass |
| FR-045 | P0 | 1, 3 | `db/*`, `lib/queue.ts` | `stream.test.ts` "notifications are never the sole record"; snapshot replace | pass |
| FR-046 | P0 | 1 | `db/*` | T-015 | pass |
| FR-047 | P0 | 1 | `db/*` | T-017 | pass |
| FR-048 | P0 | 3 | `routes/streamRoutes.ts`, `components/Dashboard.tsx` | T-018 | pass |
| FR-049 | P0 | 1 | `db/requestRepository.ts` | `database.test.ts` rollback; T-008 | pass |
| FR-050 | P0 | 1 | `routes/publicRoutes.ts` | T-007 | pass |
| FR-051 | P0 | 1 | `db/schema.ts`, `db/database.ts` | T-022 | pass |
| FR-052 | P0 | 1 | `db/database.ts` | T-021; README "SQLite file and initialization" | pass |
| FR-053 | P0 | 1, 5 | README top table and Deployment | M-08 | pass |
| FR-054 | P0 | n/a | no backup or replication code exists | code inspection; README states it | pass |
| FR-055 | P1 | 1 | all SQL is in `db/requestRepository.ts`, `db/sessionRepository.ts`, `db/schema.ts` | code inspection (a search for `prepare`, `exec`, and SQL keywords finds only those three files) | pass |
| FR-056 | P0 | 1 | `validation.ts`, `db/schema.ts` | `validation.test.ts`; `database.test.ts` constraints | pass |
| FR-057 | P0 | 1 | `db/*` | `database.test.ts` "safe against SQL injection payloads" | pass |
| FR-058 | P0 | 2, 4 | `components/RequestRow.tsx`, `http/securityHeaders.ts` | T-025 | pass |
| FR-059 | P1 | 4 | `http/rateLimit.ts` | T-020 | pass |
| FR-060 | P1 | 4 | `http/rateLimit.ts` | T-020 | pass |
| FR-061 | P0 | 1, 4 | `http/errors.ts`, `lib/messages.ts` | `messages.test.ts`; `requests.test.ts` JSON error contract and safe malformed-JSON response; `config.test.ts` no secrets in errors | pass |
| FR-062 | P0 | 2, 4 | `auth/session.ts` (`requireCsrf`) | `dj.test.ts` CSRF tests; `auth.test.ts` logout needs CSRF | pass |
| FR-063 | P0 | 1 | `validation.ts`, `db/schema.ts` | `validation.test.ts` ignores unknown fields; schema stores only name, song, artist | pass |

## Non-functional requirements

| ID | Phase | Where | Verification | Status |
| --- | --- | --- | --- | --- |
| NFR-001 | 5 | `scripts/load-test.ts` | `docs/load-test.md`: 100 submissions in 1 s and a 110-submission mixed run, no loss | pass (loopback, G5) |
| NFR-002 | 5 | `scripts/load-test.ts` | server p95 4.3 ms (limit 500 ms), repeatable with `npm run load-test -- --spawn` | pass (G5) |
| NFR-003 | 3, 5 | SSE hub and client | worst case 329 ms in the load test; about 107 ms in M-03 | pass (second device: G3) |
| NFR-004 | 1 | `db/*` | T-015, T-017 | pass |
| NFR-005 | 1, 4 | `db/requestRepository.ts` | T-008 | pass |
| NFR-006 | 4 | `styles.css` | M-04; `contrast.test.ts` touch targets | pass |
| NFR-007 | 2 | `auth/session.ts` | T-012 | pass |
| NFR-008 | 4 | components, `styles.css` | `AudiencePage.test.tsx` keyboard path and labels; `DjPage.test.tsx`; `contrast.test.ts` (WCAG AA ratios for both themes, focus ring); status always shown as text | pass |
| NFR-009 | 3 | `routes/streamRoutes.ts`, `lib/liveConnection.ts` | T-018 | pass |
| NFR-010 | 5 | README | M-06 (clean copy, localhost) | pass (real host: G1) |
| NFR-011 | 5 | README "What the host must provide" | M-08: requirements and a low-cost reference setup are documented. No specific host was provisioned | pass (documentation only, G1) |
| NFR-012 | 1, 2, 4 | `logger.ts`, `http/requestLogger.ts` | `requests.test.ts` no body in logs; `hardening.test.ts` and `auth.test.ts` no secrets in logs | pass |
| NFR-013 | 5 | README | M-08 | pass |

## Summary

- Every P0 requirement (all FR except FR-012, FR-032, FR-055, FR-059, FR-060) and every NFR has a status of `pass`, each with an automated test or a recorded manual check.
- Where a `pass` carries a note, the note points at a gap above. G1 to G5 are physical or environmental steps that cannot be completed from a development machine and are covered by the event readiness checklist.
- Counts at the time of writing: 125 API tests and 103 web tests pass; `npm run typecheck` is clean.
