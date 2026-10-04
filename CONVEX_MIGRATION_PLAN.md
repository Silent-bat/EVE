# EVE Backend Migration to Convex

## Current State

### Node.js API (services/api-node)

The existing backend is a custom Node.js HTTP server with:
- In-memory state management (persisted to JSON/PostgreSQL)
- JWT-based authentication
- Manual rate limiting
- Custom OAuth flow
- Gmail polling loop (3-hour intervals)
- Gemini API integration for briefings
- Voice transcription via Gemini
- Push notification handling

### Mobile App

The React Native app currently:
- Uses `apiFetch()` to call REST endpoints at `config.apiBaseURL`
- Stores bearer tokens in SecureStore
- Has a hybrid `convexApi.tsx` that routes some calls to Convex
- Falls back to the Node API for voice endpoints

## Migration Strategy

### Phase 1: Schema & Infrastructure ✅

- [x] Define Convex schema (`convex/schema.ts`)
- [x] Set up Convex Auth
- [x] Create HTTP actions for public endpoints
- [x] Move Gmail polling to Convex cron
- [x] Port voice transcription to Convex HTTP action

### Phase 2: Core Queries & Mutations (IN PROGRESS)

#### Authentication
- [ ] Port password signup/login to Convex mutations
- [ ] Port Google native login flow
- [ ] Implement JWT verification in Convex
- [ ] Migrate session management

#### Briefing System
- [x] `GET /v1/briefings/today` → Convex query
- [x] `POST /v1/briefings/generate` → Convex action
- [ ] `GET /v1/emails/:id/body` → Convex query
- [x] `GET /v1/audit` → Convex query

#### User Preferences
- [ ] `GET /v1/session` → Convex query
- [ ] `PUT /v1/preferences` → Convex mutation
- [ ] `GET /v1/profile` → Convex query
- [ ] `PUT /v1/profile` → Convex mutation

#### Draft Actions
- [x] `POST /v1/drafts/:id/action` → Convex mutation (partially done in convexApi.tsx)
- [ ] Polish approve/reject logic

#### Notifications
- [x] `GET /v1/device-notifications` → Convex query
- [x] `DELETE /v1/device-notifications` → Convex mutation
- [ ] `POST /v1/push-tokens` → Convex mutation
- [ ] `DELETE /v1/push-tokens/:token` → Convex mutation

#### Assistant
- [ ] `POST /v1/assistant/ask` → Convex action
- [ ] Port proactive inbox logic
- [ ] Port memory system

### Phase 3: WebSocket & Real-Time

#### Gemini Live (Voice Bridge)
- [ ] Replace WebSocket relay with Convex HTTP streaming or Cloudflare Durable Objects
- [ ] Current: `useGeminiLive.ts` connects to `ws://127.0.0.1:8080/v1/voice/live`
- [ ] Option A: Keep Node.js for WebSocket relay only
- [ ] Option B: Migrate to Cloudflare Durable Objects for stateful WebSocket
- [ ] Option C: Use Convex HTTP streaming with SSE

### Phase 4: Data Migration

#### PostgreSQL → Convex
- [ ] Export existing users from PostgreSQL
- [ ] Transform to Convex schema format
- [ ] Bulk insert via Convex mutations
- [ ] Verify data integrity
- [ ] Run both backends in parallel for 1 week
- [ ] Switch traffic to Convex
- [ ] Retire PostgreSQL

#### State Migration Script
```typescript
// migration/migrateToConvex.ts
import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { readFileSync } from "fs";

const client = new ConvexClient(process.env.CONVEX_URL!);

// Read existing state.json
const state = JSON.parse(readFileSync("state.json", "utf-8"));

// Migrate users
for (const [userId, user] of Object.entries(state.users)) {
  await client.mutation(api.users.create, {
    userId,
    email: user.email,
    displayName: user.displayName,
    preferences: user.preferences,
    googleTokens: user.googleTokens,
    // ... rest of fields
  });
}

// Migrate briefings
for (const [userId, briefings] of Object.entries(state.briefings)) {
  for (const [cacheKey, briefing] of Object.entries(briefings)) {
    const [dayKey, range] = cacheKey.includes(":") 
      ? cacheKey.split(":")
      : [cacheKey, "day"];
    await client.mutation(api.briefings.create, {
      userId,
      dayKey,
      range,
      briefing,
    });
  }
}
```

### Phase 5: Retirement

- [ ] Remove `services/api-node` directory
- [ ] Update documentation
- [ ] Archive PostgreSQL backup
- [ ] Remove Docker Compose config
- [ ] Update README with Convex-only setup

## Key Architectural Changes

### 1. Authentication

**Before (Node.js):**
```javascript
// JWT stored in SecureStore
const token = await tokenStore.current;
fetch(`${apiBaseURL}/v1/session`, {
  headers: { Authorization: `Bearer ${token}` }
});
```

**After (Convex):**
```typescript
// Convex Auth provider wraps app
<ConvexAuthProvider client={convex}>
  {/* Auth state is automatic */}
</ConvexAuthProvider>

// Queries auto-include auth
const session = useQuery(api.users.getCurrentUser);
```

### 2. Real-Time Updates

**Before (Node.js):**
```typescript
// Poll for updates every 30s
setInterval(() => {
  fetch(`${apiBaseURL}/v1/briefings/today`);
}, 30000);
```

**After (Convex):**
```typescript
// Reactive query — auto-updates when data changes
const briefing = useQuery(api.briefings.getTodayBriefing, { range: 'day' });
// No polling needed — component re-renders when briefing changes
```

### 3. Scheduled Jobs

**Before (Node.js):**
```javascript
// Manual cron loop in startGmailPollerLoop()
setInterval(async () => {
  await sweepGmailPollers();
}, 3 * 60 * 60 * 1000); // 3 hours
```

**After (Convex):**
```typescript
// convex/crons.ts
export default crons.interval(
  "gmail-poll",
  { hours: 3 },
  api.gmail.pollAllUsers
);
```

### 4. Rate Limiting

**Before (Node.js):**
```javascript
// Manual in-memory rate limiter
enforceUserRateLimit(userID, "voice");
```

**After (Convex):**
```typescript
// Convex rate limits via table + indexes
const recentCalls = await ctx.db
  .query("rateLimits")
  .withIndex("byUserBucket", q => 
    q.eq("userId", userId).eq("bucket", "voice")
  )
  .filter(q => q.gt(q.field("timestamp"), Date.now() - 60000))
  .collect();

if (recentCalls.length > 10) {
  throw new Error("Rate limit exceeded");
}
```

## Environment Variables

### Convex Dashboard Settings

```bash
# Required in production
GEMINI_API_KEY=<your-gemini-api-key>
STATE_ENCRYPTION_KEY=<32-byte-hex-key>  # openssl rand -hex 32
GOOGLE_CLIENT_ID=<oauth-client-id>
GOOGLE_CLIENT_SECRET=<oauth-client-secret>
```

### Mobile App (.env)

```bash
# Primary backend
EXPO_PUBLIC_CONVEX_URL=https://veracious-panther-496.convex.cloud

# OAuth (unchanged)
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=458142706595-...
EXPO_PUBLIC_GOOGLE_WEB_RETURN_URL=http://localhost:8081
```

## Risk Mitigation

### 1. Gradual Rollout

- Keep both backends running in parallel for 1 week
- Use feature flags to toggle Convex vs Node per user
- Monitor error rates and latency
- Roll back to Node if issues arise

### 2. Data Backup

- Export PostgreSQL to JSON before migration
- Keep Node API code in a `legacy/` branch
- Archive state.json snapshots daily during transition

### 3. WebSocket Bridge

The Gemini Live voice feature requires WebSocket. Options:

**A. Keep Node.js for WebSocket only**
- Pro: Minimal changes to voice code
- Con: Still need to run Node server

**B. Cloudflare Durable Objects**
- Pro: Serverless, stateful WebSocket
- Con: Adds Cloudflare dependency
- Cost: $5/month + $0.15 per million requests

**C. HTTP Streaming (SSE)**
- Pro: No WebSocket needed
- Con: Gemini API uses WebSocket natively
- Requires polling or long-polling wrapper

**Recommendation:** Start with Option A (keep Node for WebSocket), migrate to Durable Objects later if needed.

## Testing Plan

### 1. Unit Tests
- [ ] Test each Convex query/mutation in isolation
- [ ] Verify schema validation
- [ ] Test rate limiting logic

### 2. Integration Tests
- [ ] End-to-end auth flow (signup → login → session)
- [ ] Briefing generation from Gmail data
- [ ] Voice transcription via HTTP action
- [ ] Push notification delivery

### 3. Load Tests
- [ ] Simulate 100 concurrent users
- [ ] Measure p50/p95/p99 latency
- [ ] Verify Convex auto-scaling

### 4. Manual Testing
- [ ] iOS app with Convex backend
- [ ] Android app with Convex backend
- [ ] Web app (if applicable)
- [ ] Voice feature end-to-end

## Cost Comparison

### Current (Node.js + PostgreSQL)
- Render.com free tier: $0/month (500 hours)
- PostgreSQL: $7/month (Render add-on)
- **Total: $7/month**

### After (Convex)
- Convex free tier: 1M reads, 100k writes/month
- Convex Pro: $25/month (unlimited reads, 10M writes)
- Expected usage: ~500k reads, ~50k writes/month
- **Total: $0/month (within free tier)**
- **OR: $25/month if we hit Pro tier limits**

### Savings
- Short term: $7/month (free tier)
- Long term: $0-$18/month depending on scale

## Timeline

- **Week 1:** Port auth & session queries ✓ (mostly done)
- **Week 2:** Port briefing & profile mutations
- **Week 3:** Port assistant & notification endpoints
- **Week 4:** Data migration & parallel testing
- **Week 5:** Switch traffic to Convex, retire Node API

## Next Steps

1. **Complete Phase 2** — finish porting queries/mutations
2. **Test in parallel** — run both backends with feature flag
3. **Migrate data** — export PostgreSQL, import to Convex
4. **Monitor** — watch error rates and latency for 1 week
5. **Retire Node API** — remove services/api-node

## Open Questions

1. **WebSocket strategy:** Keep Node.js relay or migrate to Durable Objects?
2. **Rate limiting:** Use Convex tables or external service (Upstash)?
3. **Secrets:** Keep AES-GCM encryption or use Convex's built-in secrets?
4. **Cron frequency:** Keep 3-hour Gmail polling or increase to 1 hour?
5. **Push notifications:** Keep Expo push tokens in Convex or separate service?

## Success Metrics

- [ ] All REST endpoints migrated to Convex
- [ ] Mobile app works without Node API
- [ ] Briefing generation latency < 5s (p95)
- [ ] Voice transcription latency < 3s (p95)
- [ ] Zero data loss during migration
- [ ] Zero auth failures after switch
- [ ] PostgreSQL retired
- [ ] Node API removed from codebase
