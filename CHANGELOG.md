# Changelog

All notable changes to EVE are recorded here. Versions follow [SemVer](https://semver.org).

## 0.2.0 — 2026-06-01

Production-grade refactor of the V1 codebase. Behavior is preserved; the surface that callers depend on (API routes, response shapes) is unchanged.

### Added

- **Backend modules.** `services/api-node` is now an installed pnpm workspace with focused modules under `src/`:
  - `config.mjs` — zod-validated env at boot
  - `logger.mjs` — pino with redaction
  - `http/{responses,middleware}.mjs` — HTTP utilities, security headers, error mapping
  - `storage/{state,postgres,json,index}.mjs` — storage facade hiding the dual-write
  - `auth/{password,index,rate-limit}.mjs` — scrypt, session lifecycle, sliding-window rate limit
  - `google/{oauth,api,email}.mjs` — OAuth flow, Gmail/Calendar reads, send
  - `briefing/{generate,scoring,analysis,assistant,drafts}.mjs` — briefing pipeline
  - `notifications/index.mjs` — device notification ingest + history
  - `utils/dates.mjs` — pure date helpers
- **Mobile module split.** `apps/mobile/src/config.ts` for typed configuration, `apps/mobile/src/api/client.ts` for `apiFetch` + `TokenStore` (replaces the previous module-level mutable token global).
- **Real `/v1/health` endpoint** — reports status, version, uptime, mode, storage backend, and live DB connectivity.
- **Auth rate limiting** — sliding window per IP and per email, configurable via `AUTH_RATELIMIT_IP_PER_MIN` and `AUTH_RATELIMIT_EMAIL_PER_15MIN`.
- **Security headers middleware** — CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, COOP/CORP, HSTS in production.
- **Structured logging** — pino with module child loggers; redaction of authorization, cookie, password, token, secret fields.
- **Graceful shutdown** — SIGINT/SIGTERM clears the briefing interval, closes the HTTP server, and closes the pg pool.
- **Tooling.** Prettier + ESLint flat config covering both workspaces, plus root npm scripts: `lint`, `format`, `typecheck`, `test`.
- **Tests** — 29 backend tests on Node's `node:test` runner, covering urgency scoring, password hashing, rate limiting, and date helpers.
- **CI** — GitHub Actions workflow runs format check, lint, typecheck (both workspaces), and backend tests on every push and PR.
- **Docker** — `services/api-node/Dockerfile` (non-root, multi-stage, healthcheck) + repo-root `docker-compose.yml` bringing up the API plus a Postgres 16 service.

### Changed

- `server.mjs` reduced from **1500 to ~330 lines** — it now does boot, request routing, and shutdown only.
- `apps/mobile/App.tsx` no longer reaches into `AsyncStorage` directly or holds a module-level token; everything goes through `tokenStore`.
- Hardcoded values (Google web client id, OAuth scopes, default preferences, brand colors) moved to typed config modules.
- `console.*` in the backend replaced with structured `logger.info / warn / error / fatal` calls.

### Removed

- Root `App.tsx`, `App.js`, and `index.js` — monorepo bundle-URL workarounds no longer needed once Metro is started from `apps/mobile`.
- `apps/mobile/src/asyncStorageShim.ts` — temporary in-memory shim; the EAS dev build now links `RNCAsyncStorage` correctly.
- `services/api/` Go stub — we are not migrating away from Node.

### Notes for operators

- The dual-write (JSON + Postgres) is unchanged behaviorally but now lives entirely inside `src/storage/index.mjs`; the rest of the code calls `state`, `save()`, and `isDatabaseConnected()` without conditional branches.
- Env config now fails fast with a clear message when something is malformed (e.g. `GOOGLE_CLIENT_ID` without `GOOGLE_CLIENT_SECRET`).
- Tests run with their own `.env.test` and never touch your production Postgres.

## 0.1.0 — Initial V1

- Email/password auth, scrypt password hashing.
- Google OAuth (web + native) with Gmail send for approved replies.
- Morning briefing summary with priority-ranked emails and calendar events.
- Approve / reject / edit flow with an audit trail.
- Android device notification capture via NotificationListenerService.
- Gemini-assisted parsing with local heuristic fallback.
