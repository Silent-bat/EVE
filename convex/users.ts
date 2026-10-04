/**
 * User management for Convex
 */
import {
  internalMutation,
  internalQuery,
  query,
  mutation,
  type QueryCtx,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { GenericId, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";

/**
 * Public: the current session payload (replaces GET /v1/session).
 */
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    // `getAuthUserId` returns the `users` document id, so read it directly.
    const user = await ctx.db.get(userId);
    if (!user) return null;

    return {
      userId: user.userId ?? userId,
      email: user.email,
      displayName: user.displayName ?? null,
      photoURL: user.photoURL ?? null,
      connectionMode: user.connectionMode ?? "none",
      googleConnected: user.googleConnected ?? false,
      preferences: user.preferences ?? {},
      integrations: user.integrations ?? {},
    };
  },
});

/**
 * Resolve a user by id.
 *
 * The canonical id is the `users` document id (that is what
 * `getAuthUserId` returns), but legacy ids such as `google-<email>` are
 * still stored in the `userId` field, so fall back to the index.
 */
async function findUserById(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"users"> | null> {
  let direct = null;
  try {
    direct = await ctx.db.get(userId as GenericId<"users">);
  } catch {
    direct = null;
  }
  if (direct) return direct;
  return await ctx.db
    .query("users")
    .withIndex("byUserId", (q) => q.eq("userId", userId))
    .first();
}

/**
 * Internal: get a user by their userId.
 */
export const getUserByUserId = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    // The canonical id is the `users` document id.
    return await findUserById(ctx, userId);
  },
});

/**
 * Internal: look up a user by email. Used by the Google handoff in auth.ts.
 */
export const getByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    return await ctx.db
      .query("users")
      .withIndex("byEmail", (q) => q.eq("email", email))
      .first();
  },
});

/**
 * Internal: create a user record for a Google sign-in.
 * Returns the new document id.
 */
export const createGoogleUser = internalMutation({
  args: {
    email: v.string(),
    displayName: v.optional(v.string()),
    googleTokens: v.optional(v.string()),
    photoURL: v.optional(v.string()),
  },
  handler: async (ctx, { email, displayName, googleTokens, photoURL }) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("byEmail", (q) => q.eq("email", email))
      .first();
    if (existing) return existing._id;

    // The canonical id is the document id; it is backfilled below so the
    // `byUserId` index matches `getAuthUserId` for this user.
    const id = await ctx.db.insert("users", {
      email,
      displayName,
      photoURL,
      googleTokens,
      connectionMode: "google",
      googleConnected: true,
      preferences: {},
    });
    await ctx.db.patch(id, { userId: id });
    // Poll Gmail immediately on connect rather than waiting for the 15-min cron.
    await ctx.scheduler.runAfter(0, internal.gmail.pollOneUser, { userId: String(id) });
    return id;
  },
});

/**
 * Internal: link Google to an existing password account.
 */
export const markGoogleConnected = internalMutation({
  args: {
    userId: v.string(),
    googleTokens: v.optional(v.string()),
    photoURL: v.optional(v.string()),
  },
  handler: async (ctx, { userId, googleTokens, photoURL }) => {
    const user = await findUserById(ctx, userId);
    if (!user) throw new Error(`User ${userId} not found`);

    await ctx.db.patch(user._id, {
      googleConnected: true,
      connectionMode: "google",
      ...(googleTokens ? { googleTokens } : {}),
      ...(photoURL ? { photoURL } : {}),
    });
    // Poll Gmail immediately on (re)connect rather than waiting for the cron.
    await ctx.scheduler.runAfter(0, internal.gmail.pollOneUser, {
      userId: String(user.userId ?? user._id),
    });
  },
});

/**
 * Internal: replace the stored (encrypted) Google token blob. Used by the
 * Gmail poller/sender after refreshing an expired access token.
 */
export const updateGoogleTokens = internalMutation({
  args: {
    userId: v.string(),
    googleTokens: v.string(),
  },
  handler: async (ctx, { userId, googleTokens }) => {
    const user = await findUserById(ctx, userId);
    if (!user) throw new Error(`User ${userId} not found`);
    await ctx.db.patch(user._id, { googleTokens });
  },
});

/**
 * Update the known message IDs set for a user.
 */
export const updateKnownMessageIds = internalMutation({
  args: {
    userId: v.string(),
    messageIds: v.array(v.string()),
  },
  handler: async (ctx, { userId, messageIds }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("byUserId", (q) => q.eq("userId", userId))
      .first();

    if (!user) {
      throw new Error(`User ${userId} not found`);
    }

    await ctx.db.patch(user._id, {
      knownMessageIds: messageIds,
    });
  },
});

/**
 * Public: toggle a non-Google integration's connected state, persisted on the
 * user so it survives reloads. Google (gmail/calendar) is driven by
 * connectionMode, not this map.
 */
export const setIntegration = mutation({
  args: { key: v.string(), enabled: v.boolean() },
  handler: async (ctx, { key, enabled }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");
    const integrations = { ...(user.integrations ?? {}), [key]: enabled };
    await ctx.db.patch(user._id, { integrations });
    return integrations;
  },
});

/**
 * Public: update display name (replaces PUT /v1/account/name).
 */
export const updateDisplayName = mutation({
  args: { displayName: v.string() },
  handler: async (ctx, { displayName }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");

    await ctx.db.patch(user._id, { displayName });
    return { ok: true };
  },
});

/**
 * Internal: record the outcome of a Gmail poll and clear the in-flight flag.
 */
export const setPollResult = internalMutation({
  args: {
    userId: v.string(),
    lastPollAt: v.string(),
    lastPollCount: v.optional(v.number()),
    lastNewPriorityCount: v.optional(v.number()),
  },
  handler: async (ctx, { userId, lastPollAt, lastPollCount, lastNewPriorityCount }) => {
    const user = await findUserById(ctx, userId);
    if (!user) return;

    await ctx.db.patch(user._id, {
      gmailPoll: {
        ...(user.gmailPoll ?? {}),
        lastPollAt,
        lastPollCount,
        lastNewPriorityCount,
        inFlight: false,
      },
    });
  },
});

/**
 * Internal: clear the in-flight flag after a failed poll.
 */
export const clearPollInFlight = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const user = await findUserById(ctx, userId);
    if (!user) return;

    await ctx.db.patch(user._id, {
      gmailPoll: { ...(user.gmailPoll ?? {}), inFlight: false },
    });
  },
});
