# EVE to Convex Migration: Getting Started

## Setup Steps

1. **Install Convex CLI** (not yet done)
   ```bash
   npm install -g convex
   ```

2. **Create a Convex Project**
   ```bash
   cd /Users/kanafranklin/Desktop/project\ EVE
   npx convex init
   ```
   - This will create an account and configure your project
   - It will also set your `CONVEX_DEPLOYMENT` environment variable

3. **Configure Environment Variables**
   - Copy `convex/.env.example` to `convex/.env.local`
   - Add your existing secrets:
     - `GOOGLE_CLIENT_ID`
     - `GOOGLE_CLIENT_SECRET`
     - `GOOGLE_ANDROID_CLIENT_ID`
     - `GOOGLE_REDIRECT_URI`
     - `GEMINI_API_KEY`
     - `STATE_ENCRYPTION_KEY`

4. **Update Mobile Config**
   - After `npx convex init`, you'll see your new Convex deployment URL
   - Update `apps/mobile/src/api/convexClient.tsx` with that URL

5. **Run Convex Locally**
   ```bash
   npx convex dev
   ```
   This will watch your `convex/` directory and deploy changes automatically

## What We've Done So Far

- [x] Created the Convex data schema (`convex/schema.ts`)
- [x] Added Convex config and auth setup
- [x] Created a simple "hello" query (`convex/hello.ts`)
- [x] Added Convex dependencies to the monorepo root and mobile app
- [x] Updated `App.tsx` to include the `ConvexProvider`

## Next Steps

After you get Convex connected, the plan is:

1. **Migrate Auth** - Swap `/v1/auth/*` routes for Convex Auth
2. **Migrate Data** - Move Postgres/JSON data to Convex tables
3. **Migrate Briefing Generation** - Turn it into a Convex action
4. **Migrate Gmail Polling** - Use Convex cron instead of Node `setInterval`
5. **Migrate the rest** - All other API routes
6. **Remove Node (optional)** - Keep it only for voice bridge, or remove entirely

## Reminder: Gemini Live Voice

We're keeping the existing Node voice bridge for now. The mobile app will still talk to your Node server for `/v1/voice/live` while everything else moves to Convex.
