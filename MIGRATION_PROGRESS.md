# EVE → Convex Migration Progress

## ✅ Deployed

- **Dev deployment**: https://artful-meadowlark-292.convex.cloud
- **Prod deployment**: https://veracious-panther-496.convex.cloud
- **All functions live**: 11 functions deployed and serving traffic
- **Auth enforced**: unauthenticated calls correctly rejected

## ✅ Done

1. **Data model** (convex/schema.ts) — 7 tables with indexes
2. **Auth** (convex/auth.ts) — Password + Google access-token providers
3. **Queries/mutations** — briefings, audit, notifications, users, preferences, drafts
4. **Utility modules** — scoring, secrets (AES-256-GCM), Gmail wrappers
5. **Mobile client** — ConvexProvider + hybrid apiFetch routing Convex/Node

## 🚧 Remaining

### Set environment variables (required before real use)
https://dashboard.convex.dev → rosnel-kana/eve → Settings → Environment Variables

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_ANDROID_CLIENT_ID`
- `GEMINI_API_KEY`
- `STATE_ENCRYPTION_KEY`

### Deploy commands

```bash
# Dev (watches for changes)
CONVEX_DEPLOYMENT=artful-meadowlark-292 npx convex dev

# Production
npx convex deploy
```

The prod deploy prompts for confirmation; pipe `y` if running headless.

## 📝 Notes

- Voice (`/v1/voice/live`, `/v1/voice/transcribe`) still runs on the Node server.
- The mobile app points at the prod deployment.
