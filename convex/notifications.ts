/**
 * Device notification endpoints
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { classifyJSON } from "./lib/classify";

/**
 * Public: list device notifications (replaces GET /v1/device-notifications).
 */
export const getDeviceNotifications = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const limit = args.limit ?? 100;
    const notifications = await ctx.db
      .query("deviceNotifications")
      .withIndex("byUserId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit);

    return {
      entries: notifications.map((n) => ({
        ...(n.notification ?? {}),
        _rowId: n._id,
        receivedAt: n.receivedAt,
        triage: n.triage ?? null,
      })),
    };
  },
});

/**
 * Public: record a device notification (replaces POST /v1/device-notifications).
 * Schedules AI triage (useless vs needs-attention) right after capture.
 */
export const recordDeviceNotification = mutation({
  args: {
    notification: v.any(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const n = args.notification ?? {};
    const isOwnPush = typeof n.id === "string" && n.id.startsWith("push-");

    const entry = await ctx.db.insert("deviceNotifications", {
      userId,
      notification: n,
      receivedAt: new Date().toISOString(),
      triage: { verdict: "pending" },
    });

    if (!isOwnPush) {
      await ctx.scheduler.runAfter(0, internal.notifications.triageNotification, {
        rowId: entry,
      });
    }
    return entry;
  },
});

/**
 * Internal: AI-triage one captured notification into useless vs needs-attention.
 * On "attention", surfaces it as a proactive thought (and, if high-signal,
 * sends a push). Falls back to Gemini when the AI Gateway is unavailable.
 */
export const triageNotification = internalAction({
  args: { rowId: v.id("deviceNotifications") },
  handler: async (ctx, { rowId }) => {
    const row = await ctx.runQuery(internal.notifications.getNotificationRow, { rowId });
    if (!row) return;
    const n = row.notification ?? {};
    const text = [
      n.appName ? `App: ${n.appName}` : "",
      n.title ? `Title: ${n.title}` : "",
      n.body ? `Body: ${n.body}` : "",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 2000);

    const result = await classifyJSON<{
      verdict: "attention" | "useless";
      category: string;
      reason: string;
    }>(
      [
        "You triage a user's phone notifications. Decide if a notification NEEDS THE USER'S ATTENTION or is USELESS noise.",
        'Attention = something a real person expects the user to act on or read soon: a direct message from a person, an urgent/time-sensitive alert, a payment/security notice, a delivery arriving, a calendar reminder.',
        'Useless = promotional, app news, social media engagement bait, routine system events, analytics, tracking, badge count updates.',
        'When a person sent something (message/email/mention/invite), it is ALWAYS attention.',
        'Output {"verdict": "attention" | "useless", "category": <short label>, "reason": <1 sentence>}',
      ].join(" "),
      text,
      { model: "gpt-4o-mini" }
    );

    const verdict = result?.verdict === "attention" ? "attention" : "useless";
    const category = typeof result?.category === "string" ? result.category.slice(0, 100) : "";
    const reason = typeof result?.reason === "string" ? result.reason.slice(0, 500) : "";

    await ctx.runMutation(internal.notifications.setTriage, {
      rowId,
      verdict,
      category,
      reason,
      engine: "ai-gateway",
    });

    if (verdict === "attention" && row.userId) {
      const sourceId = `notification-${rowId}`;
      const title = n.title || "Notification";
      const body = reason || n.body || "";
      
      // Check if we already created a proactive thought for this notification
      const existing = await ctx.runQuery(internal.notifications.findProactiveThought, {
        userId: row.userId,
        sourceId,
      });
      
      if (!existing) {
        await ctx.runMutation(internal.notifications.createProactiveThought, {
          userId: row.userId,
          title,
          body,
          category,
          sourceId,
        });
      }
    }
  },
});

export const getNotificationRow = internalQuery({
  args: { rowId: v.id("deviceNotifications") },
  handler: async (ctx, { rowId }) => await ctx.db.get(rowId),
});

export const setTriage = internalMutation({
  args: {
    rowId: v.id("deviceNotifications"),
    verdict: v.union(v.literal("attention"), v.literal("useless"), v.literal("pending")),
    category: v.optional(v.string()),
    reason: v.optional(v.string()),
    engine: v.optional(v.string()),
  },
  handler: async (ctx, { rowId, verdict, category, reason, engine }) => {
    await ctx.db.patch(rowId, {
      triage: { verdict, category, reason, engine, classifiedAt: new Date().toISOString() },
    });
  },
});

/**
 * Internal: find existing proactive thought by sourceId.
 */
export const findProactiveThought = internalQuery({
  args: {
    userId: v.string(),
    sourceId: v.string(),
  },
  handler: async (ctx, { userId, sourceId }) => {
    const thoughts = await ctx.db
      .query("proactiveThoughts")
      .withIndex("byUserId", (q) => q.eq("userId", userId))
      .collect();
    
    return thoughts.find((t) => t.data?.sourceId === sourceId);
  },
});

/**
 * Internal: create a proactive thought from a notification.
 */
export const createProactiveThought = internalMutation({
  args: {
    userId: v.string(),
    title: v.string(),
    body: v.string(),
    category: v.string(),
    sourceId: v.string(),
  },
  handler: async (ctx, { userId, title, body, category, sourceId }) => {
    const thoughtId = `thought-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    
    await ctx.db.insert("proactiveThoughts", {
      userId,
      thoughtId,
      category: "urgent_email", // reuse existing category for UI
      title: title.slice(0, 200),
      body: body.slice(0, 1000),
      urgency: "high",
      data: { source: "notification", sourceId, notificationCategory: category },
      createdAt: new Date().toISOString(),
      status: "new",
      feedback: null,
      feedbackAt: null,
      pushSuppressedReason: null,
    });

    // Send push notification
    await ctx.scheduler.runAfter(0, internal.notifications.notifyUser, {
      userId,
      title: title.slice(0, 100),
      body: body.slice(0, 200),
    });
  },
});

/**
 * Public: clear device notifications (replaces DELETE /v1/device-notifications).
 */
export const clearDeviceNotifications = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const entries = await ctx.db
      .query("deviceNotifications")
      .withIndex("byUserId", (q) => q.eq("userId", userId))
      .collect();

    for (const entry of entries) {
      await ctx.db.delete(entry._id);
    }

    return { deleted: entries.length };
  },
});

/**
 * Public: register an Expo push token (replaces POST /v1/notifications/push-token).
 */
export const registerPushToken = mutation({
  args: {
    token: v.string(),
    platform: v.optional(v.union(v.literal("ios"), v.literal("android"), v.literal("web"))),
  },
  handler: async (ctx, { token, platform }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const existing = await ctx.db
      .query("pushTokens")
      .withIndex("byToken", (q) => q.eq("token", token))
      .first();

    if (existing) {
      if (existing.userId !== userId) {
        await ctx.db.patch(existing._id, { userId, platform });
      }
      return { ok: true };
    }

    await ctx.db.insert("pushTokens", {
      userId,
      token,
      platform,
      createdAt: new Date().toISOString(),
    });

    return { ok: true };
  },
});

/**
 * Public: unregister an Expo push token (replaces DELETE /v1/notifications/push-token/:token).
 */
export const unregisterPushToken = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const existing = await ctx.db
      .query("pushTokens")
      .withIndex("byToken", (q) => q.eq("token", token))
      .first();

    if (existing && existing.userId === userId) {
      await ctx.db.delete(existing._id);
    }

    return { ok: true };
  },
});

/**
 * Internal: send a push notification to all of a user's registered devices.
 */
export const notifyUser = internalMutation({
  args: {
    userId: v.string(),
    title: v.string(),
    body: v.string(),
  },
  handler: async (ctx, { userId, title, body }) => {
    const tokens = await ctx.db
      .query("pushTokens")
      .withIndex("byUserId", (q) => q.eq("userId", userId))
      .collect();

    if (tokens.length === 0) return { sent: 0 };

    const receipts = await Promise.all(
      tokens.map(async (t) => {
        try {
          const response = await fetch("https://exp.host/--/api/v2/push/send", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
            },
            body: JSON.stringify({
              to: t.token,
              title,
              body,
              priority: "high",
            }),
          });
          return response.ok ? "ok" : "failed";
        } catch {
          return "failed";
        }
      }),
    );

    await ctx.db.insert("deviceNotifications", {
      userId,
      notification: { id: `push-${Date.now()}`, title, body },
      receivedAt: new Date().toISOString(),
    });

    return { sent: receipts.filter((r) => r === "ok").length };
  },
});
