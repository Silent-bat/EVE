# EVE

EVE is the working project for the BriefOS PRD in `briefos_final_prd.html`.

The first implementation slice focuses on the V1 briefing loop:

- Email/password auth
- Google OAuth connection and permission surface
- Morning briefing summary
- Ranked priority emails
- Approve, edit, and reject flow
- Audit trail for every user decision
- Briefing time preference
- Android notification capture with explicit Notification access

## Structure

```text
apps/preview    Browser preview of the mobile V1 loop, no dependencies
apps/mobile     Expo React Native scaffold for the native app
services/api    Go API skeleton for briefing, approval, and audit endpoints
services/api-node Runnable V1 API used locally while Go is unavailable
```

## Run V1

V1 runs without Stripe. It includes the Node API, auth, persisted state,
Postgres-backed user data when `DATABASE_URL` is set, Gmail and Calendar fetches,
Gemini-assisted parsing when `GEMINI_API_KEY` is set, server-backed
approve/edit/reject actions, preferences, audit history, and Android notification
capture.

```bash
pnpm api:start
```

In another terminal:

```bash
pnpm mobile:start
```

The Expo app uses `EXPO_PUBLIC_EVE_API_URL`. For the iOS simulator and web,
`http://127.0.0.1:8080` is fine. For a physical phone, set it to your computer's
LAN address, for example:

```bash
EXPO_PUBLIC_EVE_API_URL=http://192.168.1.197:8080 pnpm mobile:start
```

To use Postgres instead of local JSON state, start the API with `DATABASE_URL`
set in the shell environment. Do not commit the real database URL.

## Auth and device notifications

The Node V1 API now exposes:

```text
POST /v1/auth/signup
POST /v1/auth/login
POST /v1/auth/logout
GET  /v1/session
POST /v1/device-notifications
GET  /v1/device-notifications
```

Android notification capture uses `NotificationListenerService`, so it requires
a native Android dev build. It will not work in Expo Go, and iOS does not allow
apps to read notifications from other apps.

```bash
cd apps/mobile
pnpm expo prebuild --platform android
pnpm android
```

## Google integration

Local V1 can run with JSON state for development. To use real Google OAuth, set
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`, then start
the API from a shell that loads those vars.

The Node V1 API has the integration seams for:

- Google OAuth URL generation and callback token exchange
- Gmail recent-message reads
- Calendar day-event reads
- Local deterministic drafting fallback
- Audit-only approved action recording when Gmail send is not enabled
- Gmail send for approved replies when Google OAuth is configured

## Run the preview

```bash
pnpm preview
```

Then open `http://localhost:4173`.

## Backend

The API service is intentionally dependency-light for the first slice. It uses
Go's standard library today so the domain, API contract, and audit behavior can
settle before adding Fiber, PostgreSQL, Redis, Asynq, and Google integrations.

```bash
cd services/api
go run ./cmd/api
```

## Mobile

The Expo app is scaffolded under `apps/mobile`. Install dependencies before
running it:

```bash
cd apps/mobile
pnpm install
pnpm start
```
