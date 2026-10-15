# DJ Night Song Request

A small, mobile-friendly web app for a single DJ night (up to ~100 attendees).

- Attendees scan a **static QR code**, open the public page, and submit a song request. No account needed.
- The DJ opens a **password-protected dashboard** at `/dj`, sees requests in arrival order with live updates, and marks them played or skipped.
- Requests are stored in a **local SQLite file**. SQLite is the source of truth.

The full specification is in `dj_dashboard_PRD.md`; the implementation backlog is `tasks.md`; requirement-to-test coverage is in `docs/traceability.md`.

> ## Read this first: the queue lives in one file
>
> Requests are stored in a SQLite file (default `./data/dj-requests.sqlite`). There are **no automated backups and no replication**.
>
> | Event | Queue survives? |
> | --- | --- |
> | Browser refresh, closing a tab, refreshing the DJ dashboard | Yes |
> | Ordinary backend process restart (file still on disk) | Yes |
> | Redeploying in a way that replaces the filesystem or container | **Not guaranteed. Likely lost.** |
> | Hosting cleanup of temporary storage | **Not guaranteed** |
> | Container replacement, permanent storage loss | **Not guaranteed** |
> | Deleting or replacing the database file | **No.** The app starts with a new empty queue |
>
> If the file is missing at startup, the app creates a new empty database and logs that earlier requests were **not** recovered. It never claims old data was restored. It never wipes a valid existing database.

## Contents

[Prerequisites](#prerequisites) · [Stack](#stack-exact-versions-are-in-package-lockjson) · [Local setup](#local-setup) · [Commands](#commands) · [Environment variables](#environment-variables) · [SQLite file](#sqlite-file-and-initialization) · [Queue behavior](#queue-behavior) · [API](#api-summary) · [Security notes](#security-notes) · [**Deployment**](#deployment) · [QR code](#qr-code-generate-and-print) · [Operations](#operations) · [Testing](#testing) · [Load testing](#load-testing) · [**Event readiness checklist**](#event-readiness-checklist) · [Limitations](#known-limitations)

## Prerequisites

- Node.js 22 or newer (developed and tested on Node 26)
- npm 10 or newer
- `better-sqlite3` ships prebuilt binaries for common platforms. If your platform has none, `npm ci` compiles it, which needs a C++ toolchain and Python.

## Stack (exact versions are in `package-lock.json`)

| Area | Choice |
| --- | --- |
| API | Express 5 + TypeScript (`apps/api`) |
| Database | SQLite via `better-sqlite3` (WAL mode) |
| Validation | `zod` on the server; client checks are hints only |
| Web | React 19 + Vite + TypeScript (`apps/web`) |
| Auth | Server-side session stored in SQLite, `HttpOnly` cookie, scrypt password hash |
| Live updates | Server-Sent Events (SSE), with a reload-and-poll fallback in the browser |
| Tests | Node built-in test runner (API), Vitest + Testing Library (web) |

Production runs as **one process on one origin**: the API also serves the built web app. No Redis, message broker, Kubernetes, or managed database is needed.

## Local setup

```bash
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
npm run hash-password       # hidden prompt; prints DJ_PASSWORD_HASH=...
# paste the printed DJ_PASSWORD_HASH line into .env and set SESSION_SECRET (see below)
npm run dev                 # API on :3000, web dev server on :5173 (proxies /api)
```

Open `http://localhost:5173/` (audience) and `http://localhost:5173/dj` (DJ).

Generate `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API (watch mode) and Vite dev server together |
| `npm run build` | Builds the web app, then compiles the API |
| `npm start` | Runs the built API and serves the built web app (single origin) |
| `npm test` | API tests and web tests |
| `npm run typecheck` | TypeScript checks for both workspaces |
| `npm run hash-password` | Prints a `DJ_PASSWORD_HASH` value from a hidden prompt (or from stdin) |
| `npm run qr` | Writes the audience QR code to `data/qr-audience.png` and `.svg` |
| `npm run load-test -- --spawn` | Self-contained 100-attendee load test (see [Load testing](#load-testing)) |

## Environment variables

Use these exact names. Never commit real values; `.env` is git-ignored. In production, set them as host secrets or environment variables (real environment variables take precedence over `.env`).

| Name | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | no | `3000` | API listen port |
| `HOST` | no | all interfaces | Interface to listen on. Use `127.0.0.1` when a reverse proxy on the same machine fronts the app |
| `NODE_ENV` | no | `development` | `development`, `production`, or `test`. **Set `production` when deployed** (turns on the `Secure` cookie) |
| `DATABASE_PATH` | no | `./data/dj-requests.sqlite` | SQLite file. Relative paths resolve from the repository root. In-memory paths are rejected |
| `PUBLIC_BASE_URL` | **yes** | none | Stable public origin encoded in the QR code. Absolute `http`/`https`. Must not end in `/dj` |
| `EVENT_TITLE` | no | `DJ Night` | Title shown on both pages |
| `DJ_PASSWORD_HASH` | **yes** | none | scrypt hash of the DJ password (`npm run hash-password`) |
| `SESSION_SECRET` | **yes** | none | Signs the session cookie. At least 16 characters; use a long random value |
| `SESSION_TTL_HOURS` | no | `12` | DJ session lifetime |
| `SUBMISSION_RATE_LIMIT_MAX` | no | `30` | Max audience submissions per window **per client IP** (counts invalid ones too) |
| `SUBMISSION_RATE_LIMIT_WINDOW_MS` | no | `60000` | Submission window length |
| `LOGIN_RATE_LIMIT_MAX` | no | `5` | Max failed DJ logins per window per client IP |
| `LOGIN_RATE_LIMIT_WINDOW_MS` | no | `600000` | Login window length (10 minutes) |
| `TRUST_PROXY` | no | `false` | Set `true` when a reverse proxy that terminates HTTPS sits in front of the app. See [HTTPS and the proxy setting](#https-cookie-and-proxy-settings) |

The app refuses to start if `PUBLIC_BASE_URL`, `DJ_PASSWORD_HASH`, or `SESSION_SECRET` is missing. Error messages never print secret values. In production it also logs a warning for common deployment mistakes (plain-HTTP public URL, HTTPS without `TRUST_PROXY`).

## SQLite file and initialization

- The file path comes from `DATABASE_PATH`. The parent directory is created if needed.
- On startup the schema is applied with `CREATE ... IF NOT EXISTS`. Existing rows are never touched.
- **File missing:** a new empty database is created and a warning is logged that earlier requests were not recovered.
- **File exists and is valid:** it is opened as is. Nothing is cleared.
- **File exists but is not a SQLite database:** startup fails with a safe message. The file is left untouched. It is never deleted automatically.
- Never use an in-memory database for this app.
- The same file also holds the DJ login sessions, so a restart does not log the DJ out, but a fresh database does.
- SQLite runs in WAL mode, so you will also see `-wal` and `-shm` files next to the database while the app runs. They belong to the database; do not delete them separately while it is running.

## Queue behavior

- Every request gets a server-generated UUID, a UTC timestamp, and a sequence number.
- The sequence number and the insert happen in **one write transaction**, so concurrent submissions can never share a sequence.
- "Arrival order" means the order in which the backend serialized successful commits. It is not a measurement of who physically tapped first.
- Marking a request played or skipped never changes its sequence number.
- A blank optional artist is stored as `NULL`.
- The audience sees success only after the database commit. If the write fails, the response is an error and nothing is stored.

## API summary

| Method and path | Access | Purpose |
| --- | --- | --- |
| `POST /api/requests` | public, rate limited | Create a request. `201` only after the transaction commits |
| `GET /api/health` | public | `{"status":"ok"}`, or `503 {"status":"error"}` if the database is unusable. Nothing else is exposed |
| `GET /api/config` | public | `{"eventTitle": "..."}` |
| `POST /api/auth/login` | public, failed attempts rate limited | Body `{"password"}`. Sets the `dj_session` cookie and returns a CSRF token |
| `GET /api/auth/session` | public | `{"authenticated": false}` or `{"authenticated": true, "csrfToken"}` |
| `POST /api/auth/logout` | DJ + CSRF | Invalidates the session and clears the cookie |
| `GET /api/dj/requests` | DJ | Full queue in sequence order, read from SQLite |
| `PATCH /api/dj/requests/:id/status` | DJ + CSRF | Body `{"status":"played"\|"skipped"}` |
| `GET /api/dj/requests/stream` | DJ | Server-Sent Events: a `snapshot` on connect, then `request.created` / `request.updated`, plus a `heartbeat` every 15 s |

All errors use `{"error":{"code","message"}}` and never include stack traces, SQL, file paths, or secrets. Unknown `/api/*` paths return a JSON `404`.

### Idempotency key

The audience page sends an `idempotencyKey` with each submission attempt. If a response is lost and the same attempt is retried with the **same key and the same content**, the server returns the original request (`200`) instead of creating a duplicate. The same key with **different** content returns `409 CONFLICT` and changes nothing. Keys are stored with the request, so the scope is the life of the database file.

### Live updates

Events are only notifications, published **after** the database commit. The dashboard replaces its queue with the full SQLite snapshot every time the stream (re)connects, and reloads from `GET /api/dj/requests` when the connection drops or the tab becomes visible again. If the stream is down, the dashboard says so in words ("Live updates: Reconnecting…" or "Offline — retrying") and keeps polling until it recovers.

## Security notes

- Password: stored only as a scrypt hash in the environment; compared in constant time; never logged, never sent to the browser.
- Session: random id stored in SQLite; the `dj_session` cookie is `<id>.<HMAC>` and is `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Sessions expire after `SESSION_TTL_HOURS`.
- CSRF: every state-changing DJ call requires the `X-CSRF-Token` header. The token lives only in browser memory, never in local storage.
- Rate limits: in memory, per client IP (see environment table). They reset when the app restarts.
- All user text is rendered as plain text. The app also sends a strict Content-Security-Policy, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a `Referrer-Policy`.
- SQL is confined to the repository modules and is always parameterized.
- Logging: logs contain only method, path (no query string), status, and duration; passwords, password hashes, cookies, session ids, request bodies, SQL, and file paths are never logged.

## Deployment

### What the host must provide

The app is one Node process with one SQLite file. Any host that satisfies **all** of these works:

1. **A writable local filesystem path for the SQLite file**, ideally on a persistent disk or volume (see the data-loss limit above). A host that cannot write to disk is a reason to **pick a different host**, never to switch to an in-memory database.
2. **Exactly one running instance.** Rate limits and live-update connections live in the process, and SQLite allows one writer. Do not enable autoscaling or run two copies against one file.
3. **HTTPS on a stable public URL** (a reverse proxy or the platform terminates TLS).
4. Node 22 or newer, and the ability to run `npm ci`, `npm run build`, `npm start`.

The reference deployment below is a **single small Linux VM** (Node, systemd, and Caddy for HTTPS). Managed platforms also work if they meet the four points above: attach a persistent volume, point `DATABASE_PATH` at it, keep one instance, and set the variables in the next section as platform secrets. Replacing the container or disk can delete the queue unless that volume is preserved.

### HTTPS, cookie, and proxy settings

- In production (`NODE_ENV=production`) the `dj_session` cookie is `Secure`. Browsers only keep a `Secure` cookie over HTTPS, so **the public URL must be HTTPS. On plain HTTP, DJ login fails closed:** the password is accepted but the session never sticks and you land back on the login page. `http://localhost` is the one exception browsers allow, which is handy for a local production smoke test.
- The app itself speaks plain HTTP. HTTPS therefore means a proxy sits in front of it. Set **`TRUST_PROXY=true`** in that case. Without it, every visitor appears to come from the proxy's address, so the per-IP rate limits would apply to the **whole audience at once** (30 submissions per minute for everyone) and 5 wrong DJ passwords would lock the DJ out for everyone. The app logs a warning at startup if it sees an HTTPS `PUBLIC_BASE_URL` without `TRUST_PROXY`.
- Only set `TRUST_PROXY=true` when the proxy is the **only** way to reach the app and it overwrites client-supplied `X-Forwarded-For`. Caddy does this by default. When the proxy runs on the same machine, also set `HOST=127.0.0.1` (and keep the app's port closed in the firewall) so nobody can bypass the proxy.
- `SameSite=Lax` and `HttpOnly` are always on.

### Runbook (reference VM)

Assumes a Debian/Ubuntu VM with a DNS name (`dj.example.com`) pointing at it and ports 80 and 443 open (port 3000 stays closed).

1. **Install Node 22+** and Caddy from their official packages, and create a service user:

   ```bash
   sudo useradd --system --create-home --home-dir /opt/dj-night --shell /usr/sbin/nologin djnight
   ```

2. **Get the code and build** (as that user, in `/opt/dj-night/app`):

   ```bash
   git clone <your repository url> app && cd app
   npm ci
   npm run build
   ```

3. **Create a writable data directory outside the checkout** so redeploying the code does not touch it:

   ```bash
   sudo install -d -o djnight -g djnight -m 750 /var/lib/dj-night
   ```

4. **Create the DJ password hash** and a session secret (run these on the VM; do not paste secrets into chat or tickets):

   ```bash
   npm run hash-password        # prints DJ_PASSWORD_HASH=scrypt:...
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```

5. **Store the configuration as secrets**, readable only by the service user. Create `/etc/dj-night.env` (mode `600`, owner `djnight`):

   ```ini
   NODE_ENV=production
   PORT=3000
   HOST=127.0.0.1
   TRUST_PROXY=true
   PUBLIC_BASE_URL=https://dj.example.com
   EVENT_TITLE=DJ Night
   DATABASE_PATH=/var/lib/dj-night/dj-requests.sqlite
   DJ_PASSWORD_HASH=<value printed in step 4>
   SESSION_SECRET=<value printed in step 4>
   ```

6. **Run it under systemd** (`/etc/systemd/system/dj-night.service`):

   ```ini
   [Unit]
   Description=DJ Night song requests
   After=network.target

   [Service]
   User=djnight
   WorkingDirectory=/opt/dj-night/app
   EnvironmentFile=/etc/dj-night.env
   ExecStart=/usr/bin/node apps/api/dist/server.js
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now dj-night
   ```

7. **Put HTTPS in front** with Caddy (`/etc/caddy/Caddyfile`), which obtains and renews the certificate itself:

   ```text
   dj.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   ```bash
   sudo systemctl reload caddy
   ```

   (With nginx instead, proxy to `127.0.0.1:3000`, pass `X-Forwarded-For`, and make sure buffering is off for `/api/dj/requests/stream`. The app already sends `X-Accel-Buffering: no`.)

8. **Verify**:
   - `curl https://dj.example.com/api/health` returns `{"status":"ok"}`.
   - Open `https://dj.example.com/` on a phone and submit a request.
   - Open `https://dj.example.com/dj`, log in, and see the request appear without refreshing.
   - `sudo journalctl -u dj-night -n 50` shows no warnings except, on a first start, "A new empty database was created". That is expected once.

9. **Generate the QR code** only after the URL is final: see [QR code](#qr-code-generate-and-print).

**Redeploying code:** `git pull && npm ci && npm run build && sudo systemctl restart dj-night`. The data directory is outside the checkout, so the queue survives. **Redeploying by replacing the machine, container, or disk can delete the queue.** Do not redeploy during the event.

### Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Startup: `Could not create the database directory. Check DATABASE_PATH and filesystem permissions.` | The service user cannot create the parent directory. Create it yourself (step 3) with the right owner |
| Startup: `Could not open the database file. Check that DATABASE_PATH is writable and is a valid SQLite database.` | Permission denied on the file or directory, a read-only filesystem, or the path points at a file that is not a SQLite database. Fix permissions or the path. The file is never modified by this failure |
| Startup: `Configuration error: Missing required environment variable(s): ...` | The service did not load the env file. Check `EnvironmentFile=` and the file's owner and mode |
| Health returns `503 {"status":"error"}` | The database became unusable (disk full, file removed, permissions changed). Check disk space and `journalctl` |
| DJ login "does nothing" (password accepted, back at login) | The `Secure` cookie is not being kept: the public URL is not HTTPS, or the proxy is not forwarding to the app. Use HTTPS |
| "Too many failed attempts" for the DJ, or the audience gets "sending too quickly" while few people are active | `TRUST_PROXY` is not set behind a proxy, so everyone shares one address. Set `TRUST_PROXY=true` and restart |
| Dashboard says "Offline — retrying" | The live stream is blocked or buffered by a proxy, or the app is down. It keeps reloading by polling meanwhile. Check `/api/health` and the proxy config |
| The QR code opens the wrong host or an old address | `PUBLIC_BASE_URL` was wrong or changed after printing. Fix the variable, regenerate, and reprint (or keep a redirect from the old URL) |
| Queue empty after a redeploy | The database file was on storage that was replaced. See the data-loss table. The app cannot recover it |

## QR code: generate and print

```bash
npm run qr
```

- Encodes only `PUBLIC_BASE_URL` plus `/`, which is the **public audience page**. It never points at `/dj`, and it contains no tokens, request ids, or session data.
- Output: `data/qr-audience.png` (1024 px, high error correction, standard 4-module quiet zone) and `data/qr-audience.svg`. Use the SVG for large or professional printing.
- The code stays valid across restarts and redeployments as long as the public URL stays the same.
- **If `PUBLIC_BASE_URL` changes, the QR code points at the old address.** Generate and print a new one, or keep a redirect from the old URL to the new one.

**Print procedure**

1. Set the final `PUBLIC_BASE_URL` (the real HTTPS address) and run `npm run qr` on the machine whose `.env` has that value. Check that the printed `Encoded URL :` line is exactly the address you expect.
2. Print on plain white paper with dark ink. Do not crop the white border (the quiet zone), recolor, stretch, or put a logo over it.
3. Size: at least about 4 × 4 cm for scanning from arm's length, and 10 cm or larger for a sign people scan from further away.
4. Test the **printed** copy before the event: scan it from at least two different phones (one iPhone, one Android if possible) and confirm each opens the audience request page, not the DJ page.
5. Keep a spare print. If the URL ever changes, every printed copy is out of date.

## Operations

### Health check

`GET /api/health` returns `{"status":"ok"}` when the database is reachable and `503 {"status":"error"}` when it is not. It exposes nothing else. Use it for uptime monitors and as the first step of any troubleshooting.

### Change the DJ password

1. Run `npm run hash-password` and type the new password at the hidden prompt.
2. Replace `DJ_PASSWORD_HASH` in the host's secret configuration (for the reference VM: `/etc/dj-night.env`).
3. **Restart the app.** The hash is read at startup, so nothing changes until then.
4. Existing DJ sessions stay valid until they expire or log out. To sign everyone out immediately, also change `SESSION_SECRET` in step 2, which invalidates every session cookie.

### Start a new queue

There is **no in-app reset button**, by design (no accidental wipes), and **no automated backup**.

> **Destructive:** this permanently deletes every request in the current queue.

1. Stop the app (`sudo systemctl stop dj-night`).
2. If you might want the old data, copy `dj-requests.sqlite` **and** its `-wal` and `-shm` files somewhere safe first. This is manual; nothing does it for you.
3. Delete or move the database file and its `-wal` / `-shm` files.
4. Start the app. It logs "A new empty database was created" and begins at request #1. The DJ will need to log in again, because sessions live in the same file.

## Testing

```bash
npm test                  # API tests (125) + web tests (103)
npm run typecheck
```

- API tests start the real server on a random port with a temporary database. They cover validation, persistence, restart survival, write failure, sequence concurrency (including separate database connections), auth, CSRF, sessions, rate limits, idempotency, the live stream, QR decoding, single-origin serving, and log redaction.
- Web tests render the real components against a faked network and event stream. They cover the double-submit guard, success and error states, keyboard use, safe rendering of hostile text, live updates, contrast ratios, and a source scan for unsafe patterns.
- `docs/traceability.md` maps every requirement to its tests.

## Load testing

```bash
npm run build
npm run load-test -- --spawn      # self-contained: private server, temp database, nothing left behind
```

Simulates ordinary traffic plus a burst of up to 100 submissions, retries with repeated idempotency keys, a live dashboard stream, and a dashboard poll. It then verifies against the SQLite file that sequence numbers are unique and no acknowledged request is missing. The last recorded run (110 submissions in a mixed run, and 100 inside one second) passed every check; server-side p95 was about 4 ms and the worst dashboard freshness was about 0.3 s on loopback. Full numbers, assumptions, and what was **not** measured are in [`docs/load-test.md`](docs/load-test.md). Re-run it against the real deployment before the event (see that file for how, using a throwaway database).

## Event readiness checklist

Run this the day of the event, in order. Every item is a yes/no; do not start the event until each answer is **yes**.

**Configuration**

1. [ ] `NODE_ENV=production`, `PUBLIC_BASE_URL` is the final HTTPS address, and `TRUST_PROXY=true` if a proxy terminates HTTPS?
2. [ ] `DJ_PASSWORD_HASH` and `SESSION_SECRET` are set as host secrets, and no real password, hash, or secret is committed to the repository (`git ls-files .env` prints nothing; only `.env.example`, which has blank values, is tracked)?
3. [ ] `DATABASE_PATH` is on a persistent, writable disk, and you know the data-loss limits in the table at the top?
4. [ ] The app was **not** redeployed or restarted onto a new machine since your last test (the queue is intact), or you accept starting with an empty queue?

**Smoke test on the real URL**

5. [ ] `GET /api/health` returns `{"status":"ok"}`?
6. [ ] The startup log has no deployment warnings (HTTPS, `TRUST_PROXY`)?
7. [ ] From a phone, the audience page loads without horizontal scrolling and one test request is accepted with a success message?
8. [ ] You can log in at `/dj` with the DJ password, and the test request is listed as "Pending"?
9. [ ] A second test request, sent from another phone, appears on the dashboard **without refreshing**, within a couple of seconds?
10. [ ] "Played" and "Skip" each move a request to History, and the order does not change?
11. [ ] After refreshing the dashboard, the queue and statuses are the same?
12. [ ] A wrong DJ password is rejected, and `/api/dj/requests` returns `401` when you are logged out (for example `curl -i https://<url>/api/dj/requests`)?

**QR code**

13. [ ] `npm run qr` printed the exact final audience URL, and the printed code was scanned from **two different phones**, each opening the audience page (not `/dj`)?
14. [ ] A spare printed copy is on hand?

**Before doors open**

15. [ ] You started a clean queue (see [Start a new queue](#start-a-new-queue)) so test requests are gone, and the dashboard shows the empty state?
16. [ ] The DJ knows the password, has the `/dj` link, and knows the queue lives in one file with no backup?
17. [ ] (Recommended) the load test was run against a throwaway copy of the deployment and passed?

## Known limitations

- Single event, single instance, one shared DJ password, no accounts.
- No automated backups, no replication, no in-app reset, and no guarantee the queue survives a redeploy that replaces storage.
- Rate limits and live connections are in memory: they reset on restart and do not work across multiple instances.
- Only Chromium-based browsers were tested by hand; other modern browsers are expected to work but were not verified. See `docs/traceability.md` for the status of every requirement.
