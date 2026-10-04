# Convex Backend for EVE

This directory contains the Convex serverless backend that replaces `services/api-node`.

## Setup

### 1. Install Convex CLI

```bash
npm install -g convex
```

### 2. Login to Convex

```bash
npx convex login
```

### 3. Initialize Convex Project

```bash
npx convex dev
```

This will:
- Create a new Convex project (or connect to existing)
- Generate TypeScript types in `convex/_generated/`
- Start a local dev server with hot reload

### 4. Set Environment Variables

Go to your Convex dashboard (https://dashboard.convex.dev) → Settings → Environment Variables and set:

```bash
GEMINI_API_KEY=<your-gemini-api-key>
STATE_ENCRYPTION_KEY=<32-byte-hex-key>  # Generate with: openssl rand -hex 32
GOOGLE_CLIENT_ID=<oauth-client-id>
GOOGLE_CLIENT_SECRET=<oauth-client-secret>
```

### 5. Deploy to Production

```bash
npx convex deploy
```

This pushes your functions to production. Get your deployment URL from the dashboard.

### 6. Update Mobile App

In `apps/mobile/.env`:

```bash
EXPO_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud
```

## Project Structure

```
convex/
├── schema.ts              # Database schema (tables, indexes)
├── http.ts                # HTTP endpoints (REST API)
├── auth.ts                # Convex Auth configuration
├── briefings.ts           # Briefing generation and queries
├── gmail.ts               # Gmail polling cron job
├── users.ts               # User queries and mutations
├── notifications.ts       # Push notifications and device notifications
├── lib/
│   ├── gemini.ts          # Gemini API wrapper
│   ├── google.ts          # Gmail/Calendar API helpers
│   ├── scoring.ts         # Email urgency scoring
│   └── secrets.ts         # AES-GCM encryption for tokens
└── _generated/            # Auto-generated TypeScript types
```

## Key Features

### Real-Time Queries

Convex queries are reactive — when data changes, subscribed components auto-update:

```tsx
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';

function BriefingScreen() {
  // Auto-updates when a new briefing is generated
  const briefing = useQuery(api.briefings.getTodayBriefing, { range: 'day' });
  return <BriefingView data={briefing} />;
}
```

### Scheduled Functions (Cron)

Gmail polling runs every 3 hours automatically:

```typescript
// convex/gmail.ts
export default crons.interval("gmail-poll", { hours: 3 }, api.gmail.pollAllUsers);
```

### HTTP Actions

Voice transcription endpoint:

```typescript
// convex/http.ts
http.route({
  path: "/v1/voice/transcribe",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    const body = await request.json();
    const result = await transcribeAudio({ audioBase64: body.audio, mimeType: body.mimeType });
    return new Response(JSON.stringify(result), { status: 200 });
  }),
});
```

### Database Queries

Type-safe queries with indexes:

```typescript
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await ctx.db
      .query("users")
      .withIndex("byUserId", (q) => q.eq("userId", identity.subject))
      .first();
  },
});
```

## Migration Status

### ✅ Migrated to Convex

- Voice transcription (`POST /v1/voice/transcribe`)
- Briefing generation (`POST /v1/briefing/generate`)
- Briefing queries (`GET /v1/briefing/today`)
- Gmail polling (cron)
- User queries
- Gemini API integration
- Google OAuth token encryption

### 🚧 TODO

- Assistant chat endpoints
- Draft actions (approve/reject)
- Profile endpoints
- Push notification registration
- WebSocket voice bridge (may need Cloudflare Durable Objects)
- Database migration from PostgreSQL

## Development

### Run Dev Server

```bash
npx convex dev
```

This watches for changes and hot-reloads functions.

### Test Locally

Convex functions run in the cloud even during dev. To test:

```bash
curl -X POST https://your-deployment.convex.cloud/v1/voice/transcribe \
  -H "Content-Type: application/json" \
  -d '{"audio":"...","mimeType":"audio/m4a"}'
```

### View Logs

Logs appear in the Convex dashboard under "Logs" tab, or in your terminal during `npx convex dev`.

### Run Queries from CLI

```bash
npx convex run briefings:getTodayBriefing '{"range":"day"}'
```

## Deployment

### Production Deploy

```bash
npx convex deploy --prod
```

### Environment Variables

Set in dashboard → Settings → Environment Variables. Changes take effect immediately (no redeploy needed).

### Rollback

Convex keeps a history of deployments. Rollback from the dashboard → Deployments → "Restore" on a previous version.

## Resources

- [Convex Docs](https://docs.convex.dev)
- [Convex Auth](https://labs.convex.dev/auth)
- [HTTP Actions](https://docs.convex.dev/functions/http-actions)
- [Scheduled Functions](https://docs.convex.dev/scheduling/cron-jobs)
- [React Hooks](https://docs.convex.dev/client/react)
