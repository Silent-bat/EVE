# Security

## Reporting a vulnerability

If you believe you have found a security issue in EVE, **do not open a public GitHub issue**. Email the maintainer with a description and reproduction. We aim to acknowledge within 72 hours.

## Secret storage

All runtime secrets live in `.env` at the workspace root. `.env` is in `.gitignore` and is **never** committed. The API loads it via Node's built-in `--env-file=.env` flag at boot.

The following keys are sensitive:

| Variable               | What it grants                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | Read/write access to the Neon Postgres database (users, sessions, app state, device notifications) |
| `GOOGLE_CLIENT_SECRET` | Ability to mint OAuth tokens against your Google project on behalf of any user who consents        |
| `GEMINI_API_KEY`       | Billable Gemini API access                                                                         |
| `ANTHROPIC_API_KEY`    | Billable Anthropic API access (reserved, not yet wired)                                            |

## Known historical exposure

During development (May–June 2026), several secrets were typed into a Claude conversation transcript while iterating on the integration:

- The Neon `DATABASE_URL`
- The Google web `client_secret` and Android `client_id`
- The Gemini API key

Treat them as compromised. Rotate before any production use.

## Rotation steps

### Neon Postgres

1. Sign in to <https://console.neon.tech/>.
2. Open the project → **Settings → Reset password** (or create a new role and revoke the old one).
3. Copy the new connection string.
4. Update `.env` locally and on every deployment target (Docker compose env, hosting provider env vars).
5. Restart the API: `pnpm api:start`. Verify with `curl -sf http://localhost:8080/v1/health` — `databaseConnected` should be `true`.

### Google OAuth

The Web client and Android client live in the same Google Cloud project.

**Web client secret:**

1. <https://console.cloud.google.com/apis/credentials>
2. Open the Web OAuth 2.0 Client (id ending `…u27hbqd…`).
3. **Reset Secret**. Copy the new value.
4. Update `GOOGLE_CLIENT_SECRET` in `.env`. Restart the API.
5. Old tokens issued before rotation continue to work; refresh tokens will require re-consent only if the user explicitly revokes the app.

**Android client (no secret, but SHA-1 matters):**

The Android client uses the APK signing cert SHA-1. If you rebuild with a new keystore (e.g. EAS regenerates credentials), add the new SHA-1 to the Android client in Google Cloud Console — _don't delete the old SHA-1_ until every user has the new APK.

### Gemini API key

1. <https://aistudio.google.com/app/apikey>
2. Delete the old key.
3. Create a new key, copy it, update `GEMINI_API_KEY` in `.env`. Restart the API.

### Anthropic API key (when wired)

1. <https://console.anthropic.com/settings/keys>
2. Delete the old key. Create a new one. Update `ANTHROPIC_API_KEY` in `.env`. Restart.

## If a secret was accidentally committed

1. **Rotate first.** Treat the secret as public the moment it touches a remote.
2. Force-remove the secret from history with [`git filter-repo`](https://github.com/newren/git-filter-repo) or BFG. `git rm --cached` only removes it from HEAD; the value remains in every prior commit on disk and on every fork.
3. Force-push (`git push --force --all`) and notify any collaborators to re-clone — their local clones still hold the secret.
4. Audit downstream caches: GitHub search indexes, Sourcegraph mirrors, archived issue/PR drafts, CI build artifacts, container registries.

## Moving secrets out of `.env`

For production, prefer a secrets manager over a `.env` file:

- **Hosting provider env vars** — Render, Fly.io, Heroku, Vercel each have a UI for setting env vars. Simplest path; rotate by editing the dashboard.
- **Doppler / 1Password Secrets Automation** — central UI, project scoping, audit log. Inject at container start with `doppler run -- pnpm api:start`.
- **AWS Secrets Manager / GCP Secret Manager / HashiCorp Vault** — cloud-native, supports automatic rotation hooks for Postgres credentials.

The API config (`services/api-node/src/config.mjs`) reads from `process.env` only — any of the above works without code changes.

## Defense in depth (already in place)

- Passwords hashed with `scrypt` and a 16-byte salt; timing-safe comparison.
- Session tokens stored as SHA-256 hashes; raw value returned once at signup/login.
- Auth endpoints rate-limited per IP (5/min) and per email (20/15min).
- Pino redacts `authorization`, `cookie`, `*password`, `*token`, `*access_token`, `*refresh_token`, `*client_secret` from log lines.
- Strict CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, COOP, CORP on every response. HSTS in production.
- OAuth state parameters single-use, 10-minute TTL.
- `safeReturnTo` allowlist on the OAuth callback rejects arbitrary redirect URIs.

## Defense in depth (not yet in place)

- No CSRF tokens on state-changing endpoints (the API is JSON-only and uses bearer auth, so CSRF is moot for cross-origin attacks via cookies — but if you ever add cookie auth, add CSRF tokens).
- No request body size limit (untrusted clients can send arbitrarily large payloads). For production, put the API behind a reverse proxy (nginx, Caddy) with a body size cap.
- No DDoS mitigation. The in-process rate-limiter only covers auth endpoints. For production, put the API behind Cloudflare or your provider's edge.
- The Gemini and Google APIs are called over plain `fetch` without retries or circuit breakers. A transient outage will surface as a 500 to the user.
