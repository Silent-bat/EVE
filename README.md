# EVE / BriefOS

EVE is a personal-operations agent. The product spec lives in [`briefos_final_prd.html`](briefos_final_prd.html).

## Repository layout

```
apps/mobile           Expo React Native app (TypeScript)
services/api-node     Node HTTP API (ESM, JSDoc-typed)
apps/preview          Static browser preview of the V1 loop (no deps)
.github/workflows     CI (lint, typecheck, tests)
```

## Architecture

```
┌─────────────────┐      HTTPS       ┌──────────────────────┐
│ Mobile (Expo)   │ ────────────────▶│  Node API            │
│ apps/mobile     │ ◀────────────── │ services/api-node    │
└─────────────────┘                  └──────────┬───────────┘
                                                 │
                              ┌──────────────────┼────────────────────┐
                              ▼                  ▼                    ▼
                     ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
                     │  Postgres    │    │ Google APIs  │    │ Gemini       │
                     │  (or JSON)   │    │ Gmail, Cal.  │    │              │
                     └──────────────┘    └──────────────┘    └──────────────┘
```

## Quick start

```bash
# install deps for both workspaces
pnpm install

# copy and fill in environment vars
cp .env.example .env
$EDITOR .env

# run the API (loads .env automatically)
pnpm api:start

# in a second terminal, start Metro
pnpm mobile:start
```

The mobile app uses `EXPO_PUBLIC_EVE_API_URL` to reach the backend. For a
physical phone, set it to your computer's LAN address (e.g.
`http://192.168.1.197:8080`). For the iOS simulator or web, `http://127.0.0.1:8080`
is fine. Browser sessions keep the bearer token in memory only, so a page reload
requires signing in again. Realtime voice is currently native-only; enabling it
for browsers needs a short-lived WebSocket ticket or an HttpOnly-cookie handshake.

## Scripts

| Command                 | What it does                                    |
| ----------------------- | ----------------------------------------------- |
| `pnpm api:start`        | Start the API with structured logging           |
| `pnpm api:test`         | Run backend tests (Node `node:test`)            |
| `pnpm api:typecheck`    | TypeScript checkJs over the JSDoc-typed backend |
| `pnpm mobile:start`     | Start Expo Metro bundler                        |
| `pnpm mobile:typecheck` | TypeScript check on the mobile app              |
| `pnpm typecheck`        | Both workspaces                                 |
| `pnpm test`             | All tests                                       |
| `pnpm lint`             | ESLint across the repo                          |
| `pnpm lint:fix`         | Auto-fix lint issues                            |
| `pnpm format`           | Prettier write                                  |
| `pnpm format:check`     | Prettier check (CI uses this)                   |

## Configuration

The API uses zod to validate `process.env` at boot. Set these in `.env`:

| Variable                             | Required   | Default       | Notes                                                                                                        |
| ------------------------------------ | ---------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                           | no         | `development` | `production` enables HSTS + harder error responses                                                           |
| `API_HOST`                           | no         | `127.0.0.1`   | Use `0.0.0.0` to accept LAN connections                                                                      |
| `API_PORT`                           | no         | `8080`        |                                                                                                              |
| `EVE_DATA_DIR`                       | no         | `.eve-data`   | JSON state path when `DATABASE_URL` is unset                                                                 |
| `AUTH_TOKEN_TTL_DAYS`                | no         | `30`          | Session token lifetime                                                                                       |
| `LOG_LEVEL`                          | no         | `info`        | pino level — `silent` for tests                                                                              |
| `DATABASE_URL`                       | production | —             | Postgres connection string; development/test may leave it blank for the JSON fallback                        |
| `CORS_ORIGINS`                       | no         | —             | Comma-separated browser origins; production denies cross-origin browser access when blank                    |
| `GOOGLE_CLIENT_ID`                   | optional   | —             | Web OAuth client (`/v1/google/*` flows). Requires `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` together. |
| `GOOGLE_CLIENT_SECRET`               | with web   | —             |                                                                                                              |
| `GOOGLE_ANDROID_CLIENT_ID`           | optional   | —             | Used by mobile native sign-in                                                                                |
| `GOOGLE_REDIRECT_URI`                | with web   | —             | Must match the URI registered in Google Cloud                                                                |
| `GEMINI_API_KEY`                     | optional   | —             | When set, briefing + assistant use Gemini; otherwise local fallback                                          |
| `ANTHROPIC_API_KEY`                  | optional   | —             | Reserved (not yet wired)                                                                                     |
| `AUTH_RATELIMIT_IP_PER_MIN`          | no         | `5`           | `429` after this many `/v1/auth/*` requests per minute per IP                                                |
| `AUTH_RATELIMIT_EMAIL_PER_15MIN`     | no         | `20`          | `429` after this many per email per 15min                                                                    |
| `OUTBOUND_TIMEOUT_MS`                | no         | `15000`       | Timeout for Google/Gemini/Expo network calls (milliseconds)                                                  |
| `DATABASE_CONNECT_TIMEOUT_MS`        | no         | `10000`       | Postgres connection acquisition timeout (milliseconds)                                                       |
| `DATABASE_STATEMENT_TIMEOUT_MS`      | no         | `15000`       | Postgres statement timeout (milliseconds)                                                                    |
| `DATABASE_SSL_REJECT_UNAUTHORIZED`   | no         | `true`        | Verify remote Postgres certificates; the bundled local `postgres` host uses plaintext                        |
| `GOOGLE_RESPONSE_MAX_BYTES`          | no         | `2000000`     | Maximum bytes accepted from a Google JSON response                                                           |
| `GMAIL_MAX_BODY_CHARS`               | no         | `20000`       | Maximum characters retained from one Gmail body/snippet                                                      |
| `GMAIL_FETCH_CONCURRENCY`            | no         | `6`           | Maximum concurrent Gmail detail requests per operation                                                       |
| `GEMINI_PROMPT_MAX_CHARS`            | no         | `120000`      | Maximum characters sent in one Gemini prompt                                                                 |
| `DEVICE_NOTIFICATION_RETENTION_DAYS` | no         | `30`          | Days captured notification previews remain available                                                         |
| `STATE_ENCRYPTION_KEY`               | production | —             | Required secret used to encrypt stored Google credentials                                                    |
| `USER_RATELIMIT_PER_MIN`             | no         | `30`          | Per-user budget for each billable AI/Gmail route per minute                                                  |
| `VOICE_MAX_CONNECTIONS_PER_USER`     | no         | `2`           | Concurrent authenticated Live voice sockets per user                                                         |
| `VOICE_MAX_AUDIO_BYTES`              | no         | `2000000`     | Cumulative inbound Live audio quota per turn/session budget                                                  |
| `VOICE_MAX_SESSION_MS`               | no         | `900000`      | Maximum Live voice session length (milliseconds)                                                             |
| `VOICE_IDLE_TIMEOUT_MS`              | no         | `600000`      | Close an inactive Live socket after this period (milliseconds)                                               |

Password inputs are capped at 256 characters before scrypt work begins.

## API endpoints

Health:

- `GET /v1/health` → `{ status, version, uptimeSeconds, mode, storage, databaseConnected }` (liveness; always 200 when the process is running)
- `GET /v1/ready` → the same shape, with `200` only when configured dependencies are reachable (`503` while Postgres is unavailable)

Auth (rate-limited):

- `POST /v1/auth/signup`
- `POST /v1/auth/login`
- `POST /v1/auth/logout`
- `GET  /v1/auth/google-url?returnTo=…`
- `POST /v1/auth/google-native`
- `POST /v1/auth/google-exchange` (one-use callback handoff code)
- `GET  /v1/google/callback`

Authenticated:

- `GET  /v1/session`
- `GET  /v1/google/auth-url`
- `GET  /v1/briefings/today`
- `POST /v1/briefings/generate`
- `GET  /v1/audit`
- `GET  /v1/preferences`
- `PUT  /v1/preferences`
- `GET  /v1/device-notifications`
- `POST /v1/device-notifications`
- `DELETE /v1/device-notifications` (clear this account's captured previews)
- `POST /v1/assistant/ask`
- `POST /v1/drafts/{id}/action`

The realtime voice bridge is `GET /v1/voice/live` over WebSocket. Native clients
must send the session as an `Authorization: Bearer …` upgrade header; bearer
tokens in query strings are intentionally not accepted because proxies and
access logs commonly retain URLs. Tool calls made inside a Live socket are
rate-limited per authenticated user and per billable category (Gmail, mail
mutations, settings, memory, or other) using `USER_RATELIMIT_PER_MIN`.

## Deployment

The API ships with a Dockerfile and docker-compose definition. From the repo root:

```bash
# bring up API + Postgres
docker compose up -d --build

# tail logs
docker compose logs -f api

# liveness / readiness
curl -sf http://localhost:8080/v1/health | jq
curl -sf http://localhost:8080/v1/ready | jq

# stop
docker compose down
```

The container runs as a non-root user and exposes a `wget`-based readiness healthcheck against `/v1/ready`. Provide your `.env` at the repo root before bringing the stack up — compose passes through the Google + Gemini keys without baking them into the image.

## Testing

```bash
pnpm test                  # both workspaces
pnpm api:test              # backend only
```

Backend tests live in [`services/api-node/tests/`](services/api-node/tests/) and use Node's built-in `node:test`. They run with [`tests/.env.test`](services/api-node/tests/.env.test), which leaves `DATABASE_URL` unset so the JSON fallback path is exercised.

When Postgres is enabled, app-state saves use an optimistic `state_version` check. A
concurrent worker that loaded an older snapshot receives a conflict rather than
silently overwriting newer state; retry the operation after reloading the current
state. The automated suite does not include a live Postgres service, so migrations
and multi-worker behavior still need an environment-level smoke test.

## CI

Every push and pull request runs the [CI workflow](.github/workflows/ci.yml):

- Prettier check
- ESLint
- TypeScript (both workspaces)
- Backend tests

## Android notification capture

Notification capture uses `NotificationListenerService`, so it requires a
native dev build (it will not work in Expo Go). The `withAndroidNotificationListener`
config plugin adds the manifest entry.

```bash
cd apps/mobile
pnpm exec expo prebuild --platform android
pnpm android
```

iOS does not allow apps to read other apps' notifications, so the listener is
Android-only. The listener keeps a bounded, encrypted durable queue and retries
uploads; queued previews are bound to the active account and expire locally
after seven days. The server stores previews for
`DEVICE_NOTIFICATION_RETENTION_DAYS` (30 by default). The Captured settings page
can clear the account's stored previews. A native package allowlist is available
for deployments that want to restrict capture further; a user-facing package
picker is still a product follow-up.

## Security

- Sessions are stored as SHA-256 hashes of the token; the raw value is returned once at login/signup.
- Passwords use scrypt with a per-user 16-byte salt; comparison is timing-safe.
- Auth endpoints rate-limited per IP and per email.
- All responses set `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-*` and a strict CSP; HSTS in production.
- Env loaded via Node's `--env-file`; secrets never enter source control (`.env` is gitignored).
- Logs redact `authorization`, `cookie`, `*password`, `*token`, `*access_token`, `*refresh_token`, `*client_secret` at the pino layer.

## Contributing

Before opening a PR:

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
```

All four should pass; CI runs the same commands.
