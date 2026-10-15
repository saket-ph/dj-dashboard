# Product Requirements Document (PRD)

## DJ Night Song Request Application

**Document status:** MVP specification\
**Version:** 1.0\
**Audience:** Product owner, AI coding agent, developer, tester, event
organizer\
**Primary release:** Single DJ night, up to 100 attendees

------------------------------------------------------------------------

## 1. Executive Summary

Build a lightweight, mobile-friendly web application that lets attendees
submit song requests by scanning a static QR code. A DJ uses a
password-protected dashboard to view requests in arrival order, see who
submitted each request, and mark requests as played or skipped.

The MVP prioritizes a simple attendee experience, reliable queue
ordering, basic authentication, and low implementation and hosting
complexity. Requests are stored in a local SQLite database file. They
should survive browser refreshes and ordinary backend process restarts
**while the database file remains intact**. The MVP explicitly accepts
that a redeployment or hosting cleanup may delete temporary local
storage and therefore lose the queue.

The QR code encodes a stable public URL and does not change when
requests change or the backend restarts, provided the public URL remains
unchanged.

## 2. Problem Statement

At a live DJ event, song requests are often communicated verbally or
through informal messages. This interrupts the DJ, makes requests easy
to forget, and provides no dependable ordering or record of who asked
for what.

The application centralizes requests in one queue. Attendees submit
requests from their phones, while the DJ sees an ordered list on a
dashboard.

## 3. Goals and Success Metrics

### 3.1 Goals

-   Make a song request possible in a few simple mobile-friendly steps.
-   Identify the requester and requested song.
-   Place accepted requests into a pending queue immediately after
    persistence succeeds.
-   Preserve deterministic arrival order, including under concurrent
    submissions.
-   Update the DJ dashboard automatically or near-real-time.
-   Allow the DJ to mark requests as played or skipped.
-   Protect dashboard data and management actions with a shared DJ
    password.
-   Keep the implementation deployable as a small application with
    SQLite.

### 3.2 MVP Success Metrics

  -----------------------------------------------------------------------
  Metric                              Target
  ----------------------------------- -----------------------------------
  Audience flow                       A valid request can be submitted
                                      without registration

  Dashboard freshness                 New requests appear within 2
                                      seconds under normal conditions

  Ordering                            Every request has a deterministic
                                      sequence; dashboard order matches
                                      it

  Persistence                         Requests survive page refreshes and
                                      process restarts while the DB file
                                      remains intact

  Authentication                      Unauthenticated users cannot access
                                      protected queue APIs or mutate
                                      statuses

  Scale                               Functional and load testing covers
                                      up to 100 attendees

  QR usability                        Printed QR code opens the
                                      configured audience URL on tested
                                      smartphones
  -----------------------------------------------------------------------

Performance targets are goals to verify, not guarantees independent of
hosting and network conditions.

## 4. Scope

### 4.1 In Scope

-   One configured DJ night and one shared queue.
-   Public audience request page.
-   Requester display name, song title, and optional artist name.
-   Server-side validation and durable-to-file SQLite writes.
-   Unique request ID, server timestamp, and sequence number.
-   Password-protected DJ dashboard with server-side session.
-   Pending, played, and skipped statuses.
-   Automatic or near-real-time dashboard updates.
-   Static QR code for the stable audience URL.
-   Basic rate limiting, error handling, and operational documentation.
-   Local SQLite file, with no guarantee of retention across
    redeployment or storage cleanup.

### 4.2 Out of Scope

-   Multiple simultaneous events or DJs.
-   Audience accounts or registration.
-   Song playback or integration with music services.
-   External song search or metadata enrichment.
-   Audience voting, payments, tipping, chat, or song approval.
-   Advanced analytics.
-   Automated database backups, replication, disaster recovery, or high
    availability.
-   Guaranteed data retention across redeployments.
-   Kubernetes, microservices, Redis, or other infrastructure not
    justified by this scale.

## 5. Assumptions and Constraints

1.  The MVP supports one event at a time.
2.  Up to 100 attendees may access the public page.
3.  Audience members do not need accounts.
4.  Requests enter the pending queue immediately after a successful
    database commit.
5.  The DJ dashboard uses one shared password configured outside source
    control.
6.  SQLite is the authoritative source of queue data.
7.  The database file may reside on temporary hosting storage.
8.  A committed request survives a browser refresh and an ordinary
    backend process restart only if the database file remains intact and
    the storage environment preserves it.
9.  The application URL is configured before the QR code is printed.
    Changing the URL may require a new QR code unless a stable redirect
    is maintained.
10. The app must not report a request as accepted if the database write
    fails.
11. If the database file is missing, the application may initialize a
    new empty database; it must not imply that old requests have been
    recovered.
12. Automated backups and a dedicated recovery service are not MVP
    requirements.

## 6. Personas and User Journeys

### 6.1 Audience Member

**Need:** Submit a request quickly from a phone without installing an
app or creating an account.

**Journey:** 1. Scan the QR code. 2. Open the public request page. 3.
Enter display name and song title; optionally enter artist. 4. Submit
the form. 5. See confirmation only after the server confirms the
database commit.

If validation or persistence fails, show an actionable error and do not
display a false success message.

### 6.2 DJ

**Need:** See requests in order, identify requesters, and manage the
queue while performing.

**Journey:** 1. Open the DJ dashboard. 2. Enter the configured password.
3. View the persisted queue. 4. Receive new requests without manual
refresh. 5. Mark requests as played or skipped. 6. Refresh or reconnect
and reload the current queue from SQLite.

### 6.3 Organizer

**Need:** Prepare the application before the event.

**Journey:** 1. Configure the event title/branding and DJ password. 2.
Deploy the application at a stable public URL. 3. generate and print the
QR code. 4. Test submission, dashboard access, and request ordering. 5.
Confirm readiness before attendees arrive.

## 7. Functional Requirements

Priority key: **P0** = required for launch; **P1** = desirable MVP
hardening.

### 7.1 Audience Request Page

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  FR-001                  P0                      Provide a public
                                                  audience request page
                                                  accessible from the QR
                                                  code.

  FR-002                  P0                      Support modern mobile
                                                  and desktop browsers
                                                  without app
                                                  installation.

  FR-003                  P0                      Do not require audience
                                                  registration or login.

  FR-004                  P0                      Require a requester
                                                  display name.

  FR-005                  P0                      Require a song title.

  FR-006                  P0                      Allow an optional
                                                  artist name.

  FR-007                  P0                      Validate fields and
                                                  length limits on the
                                                  server, independently
                                                  of frontend validation.

  FR-008                  P0                      Show a loading state
                                                  while a request is
                                                  being submitted.

  FR-009                  P0                      Show success only after
                                                  the database
                                                  transaction commits
                                                  successfully.

  FR-010                  P0                      Show clear validation,
                                                  network, rate-limit,
                                                  and persistence errors.

  FR-011                  P0                      Disable or guard the
                                                  submit action while the
                                                  current submission is
                                                  in progress.

  FR-012                  P1                      Use an idempotency key
                                                  or equivalent mechanism
                                                  to reduce duplicate
                                                  creation on safe
                                                  retries.

  FR-013                  P0                      Clear the form after
                                                  success; retain input
                                                  after correctable
                                                  failures where
                                                  practical.
  -----------------------------------------------------------------------

### 7.2 Queue and Request Management

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  FR-014                  P0                      Add every accepted
                                                  request to the pending
                                                  queue immediately after
                                                  persistence.

  FR-015                  P0                      Assign every request a
                                                  unique ID.

  FR-016                  P0                      Assign every request a
                                                  server-generated
                                                  timestamp.

  FR-017                  P0                      Assign every request a
                                                  server-controlled
                                                  sequence number.

  FR-018                  P0                      Display requests in
                                                  ascending
                                                  sequence-number order.

  FR-019                  P0                      Display requester,
                                                  song, optional artist,
                                                  timestamp, sequence,
                                                  and status.

  FR-020                  P0                      Assign a deterministic
                                                  order to concurrent
                                                  submissions.

  FR-021                  P0                      Preserve original queue
                                                  order when a status
                                                  changes.

  FR-022                  P0                      Support pending,
                                                  played, and skipped
                                                  statuses.

  FR-023                  P0                      Retain played and
                                                  skipped requests in
                                                  event history.

  FR-024                  P0                      Show a useful empty
                                                  state when no requests
                                                  exist.
  -----------------------------------------------------------------------

### 7.3 DJ Dashboard and Authentication

  ----------------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- ----------------------------
  FR-025                  P0                      Provide a dedicated DJ
                                                  dashboard route.

  FR-026                  P0                      Protect dashboard data and
                                                  management operations
                                                  through server-side
                                                  authentication.

  FR-027                  P0                      Use one shared DJ password
                                                  configured through
                                                  environment/secrets
                                                  configuration.

  FR-028                  P0                      Never expose the password in
                                                  frontend code, logs, or
                                                  source control.

  FR-029                  P0                      Verify the configured
                                                  password securely and
                                                  establish an authenticated
                                                  session.

  FR-030                  P0                      Provide logout and
                                                  invalidate the session.

  FR-031                  P0                      Define session expiration.

  FR-032                  P1                      Rate-limit repeated failed
                                                  login attempts.

  FR-033                  P0                      Reject unauthenticated calls
                                                  to protected queue APIs.

  FR-034                  P0                      Allow the DJ to mark a
                                                  request as played.

  FR-035                  P0                      Allow the DJ to mark a
                                                  request as skipped.

  FR-036                  P0                      Persist status changes to
                                                  SQLite.

  FR-037                  P0                      Show connection state and
                                                  loading/error/reconnecting
                                                  states.
  ----------------------------------------------------------------------------

### 7.4 Static QR Code

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  FR-038                  P0                      Generate a QR code
                                                  encoding the permanent
                                                  audience URL.

  FR-039                  P0                      Keep the QR code valid
                                                  across restarts and
                                                  deployments that
                                                  preserve the URL.

  FR-040                  P0                      Do not include expiring
                                                  tokens, request IDs, or
                                                  session information in
                                                  the QR code.

  FR-041                  P0                      Provide a practical
                                                  downloadable,
                                                  print-ready image or
                                                  documented generation
                                                  command.

  FR-042                  P0                      Ensure the QR code
                                                  opens the public
                                                  request page, not the
                                                  DJ dashboard.

  FR-043                  P0                      Document the effect of
                                                  changing the public
                                                  URL.
  -----------------------------------------------------------------------

### 7.5 Persistence and Recovery

  ------------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- ------------------------
  FR-044                  P0                      Store requests and
                                                  status changes in
                                                  SQLite.

  FR-045                  P0                      Treat SQLite as the
                                                  source of truth, not
                                                  frontend state or an
                                                  in-memory array.

  FR-046                  P0                      Survive browser
                                                  refreshes while the
                                                  database file remains
                                                  intact.

  FR-047                  P0                      Survive ordinary backend
                                                  process restarts while
                                                  the database file
                                                  remains intact.

  FR-048                  P0                      Reload the queue from
                                                  SQLite when the DJ
                                                  dashboard loads or
                                                  reconnects.

  FR-049                  P0                      Use a transaction or
                                                  equivalent atomic
                                                  mechanism for sequence
                                                  allocation and request
                                                  insertion.

  FR-050                  P0                      Do not confirm
                                                  submissions when the
                                                  database write fails.

  FR-051                  P0                      Do not clear a valid
                                                  database automatically
                                                  on application startup
                                                  or deployment.

  FR-052                  P0                      If the database file is
                                                  missing, initialize a
                                                  new schema and document
                                                  that old requests may be
                                                  lost.

  FR-053                  P0                      Explicitly document that
                                                  temporary storage may be
                                                  replaced during
                                                  redeployment or hosting
                                                  cleanup.

  FR-054                  P0                      Do not implement
                                                  automated backups or
                                                  replication in the MVP.

  FR-055                  P1                      Keep database access
                                                  behind a
                                                  repository/data-access
                                                  layer to support future
                                                  migration.
  ------------------------------------------------------------------------

### 7.6 Security and Abuse Prevention

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  FR-056                  P0                      Validate and constrain
                                                  all audience input on
                                                  the server.

  FR-057                  P0                      Use parameterized
                                                  database queries or a
                                                  safe ORM.

  FR-058                  P0                      Render user-provided
                                                  text safely to prevent
                                                  script injection.

  FR-059                  P1                      Apply configurable rate
                                                  limiting to public
                                                  submissions.

  FR-060                  P1                      Apply rate limiting to
                                                  login attempts.

  FR-061                  P0                      Avoid exposing stack
                                                  traces, secrets, or
                                                  database details to
                                                  users.

  FR-062                  P0                      Apply suitable CSRF
                                                  protection to
                                                  state-changing
                                                  authenticated
                                                  operations, based on
                                                  the chosen session
                                                  design.

  FR-063                  P0                      Collect no unnecessary
                                                  personal information.
  -----------------------------------------------------------------------

## 8. Non-Functional Requirements

  -----------------------------------------------------------------------
  ID                      Requirement / target    Verification
  ----------------------- ----------------------- -----------------------
  NFR-001                 Support up to 100       Concurrent/load test
                          attendees.              with documented
                                                  assumptions.

  NFR-002                 Target p95 API latency  Measure with a
                          under 500 ms under      repeatable test.
                          normal test conditions, 
                          excluding client        
                          network latency.        

  NFR-003                 Target dashboard        Submit from a second
                          freshness within 2      device and measure
                          seconds under normal    arrival.
                          conditions.             

  NFR-004                 Preserve committed      Restart and refresh
                          requests across         tests.
                          refreshes and process   
                          restarts while the DB   
                          file remains intact.    

  NFR-005                 Queue order must be     Concurrent submission
                          deterministic.          tests.

  NFR-006                 Mobile form must not    Responsive browser
                          require horizontal      tests.
                          scrolling on common     
                          phone sizes.            

  NFR-007                 Protected DJ endpoints  API security tests.
                          must reject             
                          unauthenticated calls.  

  NFR-008                 Forms must have labels, Accessibility review.
                          keyboard support, and   
                          visible focus states.   

  NFR-009                 Reconnection must       Disconnect/reconnect
                          reload the              test.
                          authoritative queue.    

  NFR-010                 Local setup and         Follow README from a
                          deployment must be      clean environment.
                          documented.             

  NFR-011                 Prefer low-cost,        Document chosen
                          low-maintenance         platform and expected
                          hosting.                operating requirements.

  NFR-012                 Do not log passwords,   Review logs and error
                          session secrets, or     handling.
                          unnecessary personal    
                          information.            

  NFR-013                 Document that temporary Review deployment
                          local storage does not  documentation.
                          guarantee retention     
                          across redeployment.    
  -----------------------------------------------------------------------

These are targets, not unconditional service guarantees. Hosting, disk
behavior, network latency, and platform limits must be considered during
verification.

## 9. Proposed Technical Architecture

### 9.1 Recommended Stack

Use one coherent stack and document exact version choices in the
implementation README.

-   **Frontend:** React + TypeScript.
-   **Backend:** Node.js + TypeScript with a lightweight HTTP framework.
-   **Database:** SQLite with a maintained driver or ORM.
-   **Real-time delivery:** Prefer Server-Sent Events (SSE) if supported
    by the selected host; otherwise use polling every 1--2 seconds while
    the DJ dashboard is open.
-   **Authentication:** Server-side session using a secure, HTTP-only
    cookie.
-   **QR code:** A standard QR generation library or a documented
    generation script.
-   **Deployment:** One application service with a writable local
    filesystem.
-   **Configuration:** Environment variables and hosting secret
    configuration.

Do not introduce Redis, a message broker, Kubernetes, microservices, or
a separate managed database for the MVP.

### 9.2 Hosting and SQLite Constraints

-   Configure the SQLite file path explicitly, such as
    `./data/dj-requests.sqlite`, and create its parent directory when
    appropriate.
-   Verify the selected host allows the backend to write to that
    directory.
-   Do not use an in-memory SQLite database.
-   Do not assume the local filesystem is durable across redeployments.
-   If the host does not support a writable local filesystem, select a
    compatible deployment target rather than silently switching to
    memory-only storage.
-   Do not automatically delete or recreate a database that already
    exists and is valid.
-   Explain that replacing the database file may start the application
    with an empty queue.
-   Backups, replication, and managed persistence are out of scope for
    this release.

### 9.3 Architecture Diagram

``` mermaid
flowchart TD
    A[Audience phone] -->|Scan static QR| B[Public request page]
    B -->|POST request| C[Backend API]
    C --> D[Validation and sequence assignment]
    D --> E[(SQLite database file)]
    E --> C
    C -->|Commit confirmation| B
    F[DJ browser] -->|Login and fetch queue| C
    C -->|Authenticated session| F
    E --> C
    C -->|SSE or polling response| F
    F -->|Played / skipped update| C
    C --> E
```

### 9.4 Request Submission Flow

1.  Client sends a request to the backend.
2.  Backend validates and normalizes input.
3.  Backend starts a database transaction.
4.  Backend allocates the next sequence number atomically and inserts
    the request.
5.  Backend commits the transaction.
6.  Only after commit does the API return success.
7.  Backend notifies connected dashboards or makes the request available
    through polling.
8.  Dashboard displays the request according to sequence number.

A notification must never be the only copy of a request. If a
notification is missed, the dashboard reloads from SQLite.

## 10. Data Model

### 10.1 `song_requests` Table

Use a schema equivalent to the following; adapt syntax to the selected
SQLite library while preserving the constraints.

``` sql
CREATE TABLE IF NOT EXISTS song_requests (
  id TEXT PRIMARY KEY,
  sequence_number INTEGER NOT NULL UNIQUE,
  requester_name TEXT NOT NULL
    CHECK (length(trim(requester_name)) BETWEEN 1 AND 80),
  song_title TEXT NOT NULL
    CHECK (length(trim(song_title)) BETWEEN 1 AND 160),
  artist_name TEXT
    CHECK (artist_name IS NULL OR length(trim(artist_name)) <= 160),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'played', 'skipped')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  idempotency_key TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_song_requests_status_sequence
  ON song_requests(status, sequence_number);

CREATE INDEX IF NOT EXISTS idx_song_requests_sequence
  ON song_requests(sequence_number);
```

Implementation notes: - Generate IDs server-side, using UUIDs or another
robust unique identifier. - Store timestamps in a consistent UTC format
(for example, ISO 8601). - Treat `sequence_number` as the authoritative
ordering field. - Do not depend on timestamp precision to order
simultaneous requests. - Enforce length limits on the server as well as
with database constraints. - Decide and document whether blank optional
artist input is normalized to `NULL`.

### 10.2 Sequence Allocation and Concurrency

The sequence assignment and insert must be atomic. Use an appropriate
SQLite transaction mode and ensure only one transaction can successfully
claim a given next sequence. A simple implementation may derive the next
value from the current maximum within a write transaction, provided the
transaction strategy handles concurrent writers correctly. A dedicated
sequence table is also acceptable if it makes correctness clearer.

Requirements: - `sequence_number` must be unique. - Sequence values must
increase as requests are committed to the queue. - Failed inserts must
not create visible queue entries. - Concurrent submissions must not
receive the same sequence. - Return requests ordered by
`sequence_number ASC`. - A request's status must not alter its
sequence. - Explain that "arrival order" means the order established by
the backend's serialized successful commits, not a perfect measurement
of which phone user physically tapped first.

### 10.3 Event Configuration

The MVP supports one event only. Avoid an unnecessary multi-event
schema. Event title and public URL may be configuration values. Add an
event table only if the chosen implementation has a concrete need.

### 10.4 Reset Behavior

No automatic reset on startup, refresh, or deployment. If an
administrative reset is included: - It must be protected by DJ
authentication. - It must require explicit confirmation. - It must be
documented as destructive. - It must not change the public URL or QR
code.

## 11. API Contracts

Use JSON for API request and response bodies. Standardize error
responses, for example:

``` json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Please provide a song title."
  }
}
```

Do not expose stack traces, SQL statements, credentials, or internal
file paths in API errors.

### 11.1 `POST /api/requests` --- Public

Purpose: Create a song request.

Example request:

``` json
{
  "requesterName": "Alex",
  "songTitle": "Example Song",
  "artistName": "Example Artist",
  "idempotencyKey": "client-generated-unique-value"
}
```

Successful response (`201 Created`):

``` json
{
  "request": {
    "id": "generated-request-id",
    "sequenceNumber": 1,
    "requesterName": "Alex",
    "songTitle": "Example Song",
    "artistName": "Example Artist",
    "status": "pending",
    "createdAt": "2026-10-13T14:00:00.000Z"
  }
}
```

Rules: - `requesterName` and `songTitle` are required. - `artistName` is
optional. - Validate types, trimmed content, and maximum lengths. -
Return `400` for invalid input, `429` for rate limiting, and `500`/`503`
for persistence or service failures as appropriate. - Return success
only after commit. - If idempotency is implemented, document the key's
scope and behavior when the same key is reused with a different payload.

### 11.2 `GET /api/health` --- Public

Purpose: Basic application health check. Return a minimal status. Do not
expose secrets, filesystem paths, or detailed infrastructure data. If a
database check is included, return only a safe health state.

### 11.3 `POST /api/auth/login` --- Public, Rate-Limited

Example request:

``` json
{ "password": "provided-by-dj" }
```

On success, establish a server-side session and set the session cookie.
Never return the password or password hash. Use a generic authentication
failure response that does not reveal sensitive details.

### 11.4 `POST /api/auth/logout` --- Authenticated

Invalidate the current session and clear its cookie.

### 11.5 `GET /api/auth/session` --- Optional

May be used by the frontend to determine whether the DJ session is
active. It must not expose secrets.

### 11.6 `GET /api/dj/requests` --- Authenticated

Return persisted requests ordered by `sequence_number ASC`. For this
small MVP, returning the complete queue is acceptable; avoid unnecessary
pagination unless implementation needs it.

Example response:

``` json
{
  "requests": [
    {
      "id": "request-id",
      "sequenceNumber": 1,
      "requesterName": "Alex",
      "songTitle": "Example Song",
      "artistName": "Example Artist",
      "status": "pending",
      "createdAt": "2026-10-13T14:00:00.000Z",
      "updatedAt": "2026-10-13T14:00:00.000Z"
    }
  ]
}
```

### 11.7 `PATCH /api/dj/requests/{id}/status` --- Authenticated

Example request:

``` json
{ "status": "played" }
```

Allowed statuses: `played`, `skipped`. The MVP does not need to support
moving a completed request back to pending unless explicitly justified.

Requirements: - Confirm that the request exists. - Validate the
status. - Persist the status and `updated_at`. - Return the updated
request. - Reject unauthenticated calls. - Keep `sequence_number`
unchanged.

### 11.8 Real-Time Endpoint

If SSE is selected, implement an authenticated stream endpoint, for
example `GET /api/dj/requests/stream`. Protect it using the established
session and ensure browser cookie behavior works with the selected
frontend arrangement.

If SSE is incompatible with the hosting environment, poll
`GET /api/dj/requests` at a documented interval, such as every 1--2
seconds while the dashboard is visible. Stop or reduce polling when the
page is hidden if practical.

## 12. Authentication and Security

-   Configure the DJ password through a secret/environment
    configuration, never in source code.
-   Prefer storing a password hash (for example, using a modern password
    hashing algorithm) or use the hosting secret as input to a secure
    verification mechanism.
-   Use a server-side session and a cryptographically random session
    identifier.
-   Use `HttpOnly`, `SameSite`, and `Secure` cookie settings in
    production over HTTPS.
-   Invalidate the session at logout and expire it according to a
    documented policy.
-   Rate-limit failed login attempts.
-   Protect status-changing routes against CSRF based on the chosen
    cookie/session design.
-   Validate and constrain all inputs.
-   Render text safely; never interpret song titles or names as HTML.
-   Use parameterized database queries.
-   Do not log passwords, session IDs, secret values, or unnecessary
    personal information.
-   Use HTTPS for production.
-   Ensure all DJ APIs check the session on the server. Hiding dashboard
    controls is not authorization.

## 13. UI Specifications

### 13.1 Audience Page

Required elements: - Event title or DJ branding. - Requester name
field. - Song title field. - Optional artist field. - Submit button. -
Submission/loading indicator. - Success confirmation. - Field validation
messages. - Network/server failure message and retry guidance.

UX rules: - Mobile-first layout. - Clear labels and readable text. -
Minimal steps. - Prevent accidental double submission. - Do not display
an accepted state before server confirmation.

### 13.2 DJ Login Page

Required elements: - Password field. - Login button. - Loading
indicator. - Generic invalid-login message. - Accessible labels and
keyboard support.

### 13.3 DJ Dashboard

Required elements: - Event title. - Connection status: connected,
reconnecting, or offline. - Pending request count. - Pending queue
sorted by sequence. - Each request's sequence, song, artist (if
present), requester, timestamp, and status. - Actions to mark pending
requests as played or skipped. - Completed history. - Loading, empty,
and error states. - Logout action.

Use high contrast and clear typography suitable for a dimly lit DJ
booth. Status must not be conveyed by color alone. Prevent accidental
repeated status updates while a request action is in progress.

## 14. Real-Time Delivery and Reconnection

Choose SSE where supported because the main live update direction is
server-to-dashboard. Polling is an acceptable simpler fallback.

Requirements: 1. New requests appear on the dashboard without manual
refresh. 2. The dashboard always sorts by sequence number. 3.
Notifications do not create duplicate database records. 4. On reconnect,
reload the authoritative request list from SQLite. 5. If a notification
is missed, the queue must still be corrected by the next
snapshot/reload. 6. If the real-time connection fails, show a visible
connection warning. 7. If the database file has been lost and
reinitialized, the app may show an empty queue; it must not imply prior
data was recovered.

## 15. Error Handling and Observability

Handle at least: - Invalid audience input. - Rate limit exceeded. -
Database unavailable or write failure. - Authentication failure. -
Session expiration. - Request not found. - Invalid status transition. -
SSE/polling connection failure. - Missing database file and
initialization failure.

Provide concise user-facing errors and useful server-side logs. Avoid
leaking internal details. A successful submission response must
correspond to a committed SQLite transaction.

## 16. Phased Implementation Plan

Each phase must leave the application runnable. The coding agent must
implement, test, and verify acceptance criteria for a phase before
moving to the next.

### Phase 1 --- Foundation and Audience Submission

**Tasks** - Initialize frontend and backend project. - Establish code
structure and environment configuration. - Configure SQLite file path
and initialization. - Create schema/migration logic. - Implement public
form and server validation. - Implement transactional insert, unique ID,
sequence, and timestamp. - Generate a static QR code for the configured
public URL. - Add baseline error handling and README setup steps.

**Tests** - Valid request creates one row. - Invalid required fields are
rejected. - Database failure does not return success. - Audience page
refresh does not delete requests. - Backend restart preserves requests
when the file remains intact. - QR code opens the configured audience
URL.

**Exit criteria** - Audience submission works end-to-end. - Requests are
stored in SQLite. - The app does not use frontend state as its source of
truth. - QR URL and database limitations are documented.

### Phase 2 --- DJ Authentication and Queue Dashboard

**Tasks** - Implement password verification and session handling. -
Implement login/logout. - Protect all DJ APIs. - Build dashboard and
queue list. - Fetch persisted queue in sequence order. - Implement
played/skipped status updates and completed history. - Add loading,
empty, and error states.

**Tests** - Correct password creates a session. - Incorrect password is
rejected. - Unauthenticated API requests cannot read or mutate DJ
data. - Status changes persist after refresh. - Queue order remains
unchanged after status updates. - Logout invalidates the session.

**Exit criteria** - DJ can securely view and manage the queue. - Queue
content comes from SQLite.

### Phase 3 --- Real-Time Updates and Recovery

**Tasks** - Implement SSE or polling. - Add new requests to the visible
queue without manual refresh. - Add connection-state indicators. -
Handle reconnect and queue refresh. - Avoid duplicate visual entries.

**Tests** - Submit from another phone and observe the dashboard. -
Submit multiple requests quickly. - Disconnect and reconnect the
dashboard. - Refresh the dashboard and verify order/status. - Confirm
notifications are not the sole record of requests.

**Exit criteria** - New requests appear automatically under normal
conditions. - Reconnection reloads the authoritative queue.

### Phase 4 --- Security, Reliability, and UX Hardening

**Tasks** - Add submission and login rate limits. - Review input
validation and safe rendering. - Verify CSRF protection for the session
model. - Test concurrency and transaction behavior. - Improve mobile
responsiveness and accessibility. - Improve error messages and
operational logs. - Verify behavior for database write failure and
missing database file.

**Tests** - Concurrent requests get unique, deterministic sequences. -
Excessive input is rejected. - Rate limiting works. - Protected
endpoints reject unauthenticated access. - Missing database initializes
safely. - Existing database is not reset at startup. - Database failure
never produces false success.

**Exit criteria** - Critical security and business-rule tests pass. -
Known durability limitations are clearly documented.

### Phase 5 --- Deployment and Event Readiness

**Tasks** - Configure production environment variables and secrets. -
Deploy to a host with a writable local filesystem. - Configure stable
public URL and HTTPS. - Verify database location and permissions. -
Generate and print the QR code. - Run end-to-end and 100-attendee
representative load tests. - Complete README, deployment, and
troubleshooting documentation.

**Tests** - Deploy from documented instructions. - Scan the printed QR
code from multiple phones. - Submit requests from multiple devices. -
Verify DJ login and status management. - Restart backend and confirm
queue remains when database file is intact. - Verify the deployment
documentation explicitly states that redeployment may replace temporary
storage.

**Exit criteria** - The application is usable for a single event with up
to 100 attendees. - All P0 requirements pass. - The static QR code,
queue ordering, authentication, and SQLite behavior are verified.

## 17. Test Plan and Traceability

Create a test matrix with test ID, requirement IDs, preconditions,
steps, expected outcome, and result. Include at least the following
tests:

  -----------------------------------------------------------------------
  Test ID                 Scenario                Expected outcome
  ----------------------- ----------------------- -----------------------
  T-001                   Submit valid request    Request is committed
                                                  and success is shown

  T-002                   Missing requester name  Validation error; no
                                                  row created

  T-003                   Missing song title      Validation error; no
                                                  row created

  T-004                   Artist omitted          Request accepted with
                                                  artist null/empty
                                                  normalized value

  T-005                   Input exceeds limit     Server rejects request

  T-006                   Double-click submit     No accidental duplicate
                                                  under normal client
                                                  interaction

  T-007                   Database write failure  No success response

  T-008                   Multiple concurrent     Each request has a
                          submissions             unique sequence

  T-009                   Queue ordering          Dashboard sorts by
                                                  ascending sequence

  T-010                   DJ login success        Authenticated session
                                                  established

  T-011                   DJ login failure        Access denied

  T-012                   Unauthenticated DJ API  Rejected
                          call                    

  T-013                   Mark played             Status persists and
                                                  sequence stays
                                                  unchanged

  T-014                   Mark skipped            Status persists and
                                                  sequence stays
                                                  unchanged

  T-015                   Audience page refresh   Existing requests
                                                  remain in SQLite

  T-016                   Dashboard refresh       Queue and statuses
                                                  reload from SQLite

  T-017                   Backend process restart Queue remains if
                                                  database file remains
                                                  intact

  T-018                   Dashboard               Queue reloads and
                          disconnect/reconnect    ordering is correct

  T-019                   QR code after restart   Same URL opens audience
                                                  page

  T-020                   Rate limit exceeded     Request/login is
                                                  throttled with safe
                                                  error

  T-021                   Missing database file   New schema initializes;
                                                  app does not claim old
                                                  data recovered

  T-022                   Existing valid database Data is not
                          at startup              automatically cleared

  T-023                   Database file lost      App can initialize
                          during redeployment     empty DB; loss
                                                  limitation is
                                                  documented

  T-024                   Representative          Performance and
                          100-attendee load       correctness targets are
                                                  measured

  T-025                   Unsafe text in          Text is rendered safely
                          name/song               and not executed as
                                                  markup
  -----------------------------------------------------------------------

### 17.1 Load Test Guidance

Use a representative test of up to 100 clients or a suitable
concurrent-request simulation. Document the request rate and test
environment. Verify: - No duplicate sequence numbers. - No acknowledged
request is missing from the database while the file remains intact. - No
unhandled application errors. - Dashboard latency is measured. - SQLite
write contention is handled appropriately.

Do not assume 100 attendees all submit simultaneously; test a burst
scenario as well as ordinary usage.

## 18. Deployment and Operations

The README must include: - Prerequisites and local setup. - Install,
development, test, and build commands. - Environment variables and
secret configuration. - SQLite file path and initialization behavior. -
Production deployment steps. - HTTPS and cookie configuration. - QR
generation/download instructions. - Health-check behavior. - How to
change the DJ password. - Troubleshooting for database permissions and
write failures. - How to start with a new queue. - Known
temporary-storage limitation.

Recommended configuration values include: - `PORT` - `DATABASE_PATH` -
`PUBLIC_BASE_URL` - `DJ_PASSWORD_HASH` or a documented
secret-verification alternative - Session secret - Rate-limit
configuration where applicable

Use actual names consistently in code and documentation. Do not include
real secret values in examples.

### 18.1 Data-Loss Limitation

The application must distinguish: - **Expected to survive:** browser
refresh, tab closure, dashboard refresh, and ordinary backend process
restart when the SQLite file remains intact. - **Not guaranteed to
survive:** filesystem cleanup, redeployment that replaces the
filesystem, container replacement, database-file deletion, or permanent
storage loss.

If the file disappears, the application may create a new empty database.
It must not claim that the old queue has been recovered. Automated
backup and restore are out of scope for MVP.

## 19. Risks and Mitigations

  -----------------------------------------------------------------------
  Risk                                Mitigation
  ----------------------------------- -----------------------------------
  QR code becomes invalid due to URL  Configure stable public URL;
  change                              document redirect option

  Queue lost after redeployment       Accepted MVP trade-off; clearly
                                      document temporary storage

  Hosting filesystem is not writable  Verify hosting compatibility before
                                      deployment

  Duplicate or ambiguous ordering     Atomic sequence assignment and
                                      unique constraint

  Notification missed                 Reload authoritative SQLite
                                      snapshot after reconnect

  Unauthorized DJ access              Server-side session checks on all
                                      protected APIs

  Spam submissions                    Input validation and rate limiting

  False success on database error     Return success only after commit

  Accidental queue reset              No automatic reset; require
                                      explicit authenticated action if
                                      implemented

  Future database migration is        Isolate persistence behind a
  expensive                           data-access layer
  -----------------------------------------------------------------------

## 20. Definition of Done

The MVP is complete when:

-   [ ] Audience can submit a song request from a mobile browser.
-   [ ] Requester name and song title are required; artist is optional.
-   [ ] Requests are persisted to SQLite.
-   [ ] Requests have unique IDs, server timestamps, and deterministic
    sequence numbers.
-   [ ] The DJ dashboard is password-protected.
-   [ ] Unauthenticated users cannot read or modify DJ queue data.
-   [ ] Requests appear in sequence order and update automatically or
    near-real-time.
-   [ ] The DJ can mark requests as played or skipped.
-   [ ] Status and order persist across refreshes while the database
    file remains intact.
-   [ ] The static QR code opens the stable audience URL.
-   [ ] Critical validation, authentication, concurrency, and recovery
    tests pass.
-   [ ] The app handles database write failure without false success.
-   [ ] The README documents setup, deployment, and the
    temporary-storage data-loss limitation.
-   [ ] No unrequested features or unnecessary infrastructure have been
    added.

## 21. Requirement-to-Test Traceability

The implementation should maintain a traceability mapping from each
functional and non-functional requirement to: 1. The implementation
phase. 2. Relevant code/module or API. 3. Automated or manual test ID.
4. Verification status.

At minimum, map all P0 requirements to tests. Any requirement that
cannot be verified must be explicitly called out before release.

## 22. Instructions for the AI Coding Agent

1.  Read this entire PRD before implementation.
2.  Implement the application phase by phase in the specified order.
3.  Keep the application runnable at the end of each phase.
4.  Use SQLite as the authoritative source of queue data.
5.  Do not substitute in-memory or browser-only storage.
6.  Use atomic, server-controlled sequence assignment.
7.  Enforce DJ authentication on the server.
8.  Add automated tests for critical business rules and security
    controls.
9.  Run tests and verify the phase acceptance criteria before
    proceeding.
10. Keep all secrets out of source control and frontend code.
11. Do not add features outside the agreed MVP scope.
12. Keep the data-access layer isolated so a future database migration
    is feasible.
13. Handle a missing database file safely, but do not imply that old
    data is recoverable.
14. Do not automatically reset an existing database at startup.
15. Document setup, configuration, deployment, testing, and limitations.
16. Report any unavoidable deviation from this PRD and explain its
    reason.

**Final product principle:** Build the smallest reliable application
that satisfies this PRD. The MVP values simplicity and speed while
retaining correct queue ordering, basic security, and SQLite persistence
for as long as the local database file exists. It does not promise
durability across redeployments or loss of temporary storage.
