/**
 * Proactive inbox + preferences for Convex.
 *
 * Preferences live on users.preferences.proactive; "thoughts" now live in the
 * proactiveThoughts table. Refactored from array-based storage to proper table.
 */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

const CATEGORIES = [
  "urgent_email",
  "interview_prep",
  "project_checkin",
  "brainstorm_idea",
  "briefing_ready",
] as const;

function defaultPrefs(): any {
  return {
    enabled: true,
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    maxPushesPerDay: 3,
    maxPushesPerHour: 1,
    categories: {
      urgent_email: { enabled: false, threshold: "high", deliveryMode: "silent" },
      interview_prep: { enabled: false, threshold: "high", deliveryMode: "silent" },
      project_checkin: { enabled: false, threshold: "high", deliveryMode: "silent" },
      brainstorm_idea: { enabled: false, threshold: "high", deliveryMode: "silent" },
      briefing_ready: { enabled: true, threshold: "low", deliveryMode: "push" },
    },
    availableNow: null,
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const URGENCY = new Set(["low", "medium", "high", "critical"]);
const DELIVERY = new Set(["silent", "soft", "push"]);

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? Math.round(value) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function mergePrefs(base: any, patch: any): any {
  const b = base && typeof base === "object" ? { ...defaultPrefs(), ...base } : defaultPrefs();
  if (!patch || typeof patch !== "object") return b;

  const next: any = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : b.enabled,
    quietHoursStart: HHMM.test(patch.quietHoursStart) ? patch.quietHoursStart : b.quietHoursStart,
    quietHoursEnd: HHMM.test(patch.quietHoursEnd) ? patch.quietHoursEnd : b.quietHoursEnd,
    maxPushesPerDay: clampInt(patch.maxPushesPerDay, 0, 50, b.maxPushesPerDay),
    maxPushesPerHour: clampInt(patch.maxPushesPerHour, 0, 10, b.maxPushesPerHour),
    categories: { ...defaultPrefs().categories, ...(b.categories ?? {}) },
    availableNow: b.availableNow ?? null,
  };

  if (patch.categories && typeof patch.categories === "object") {
    for (const name of CATEGORIES) {
      const inc = patch.categories[name];
      if (!inc || typeof inc !== "object") continue;
      const cur = next.categories[name] ?? defaultPrefs().categories[name];
      next.categories[name] = {
        enabled: typeof inc.enabled === "boolean" ? inc.enabled : cur.enabled,
        threshold: URGENCY.has(inc.threshold) ? inc.threshold : cur.threshold,
        deliveryMode: DELIVERY.has(inc.deliveryMode) ? inc.deliveryMode : cur.deliveryMode,
      };
    }
  }
  if (patch.availableNow === null) next.availableNow = null;
  return next;
}

async function currentUser(ctx: any) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  const user = await ctx.db.get(userId);
  if (!user) throw new Error("User not found");
  return user;
}

export const getPreferences = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    return mergePrefs(user.preferences?.proactive, null);
  },
});

export const updatePreferences = mutation({
  args: { patch: v.any() },
  handler: async (ctx, { patch }) => {
    const user = await currentUser(ctx);
    const merged = mergePrefs(user.preferences?.proactive, patch);
    await ctx.db.patch(user._id, {
      preferences: { ...(user.preferences ?? {}), proactive: merged },
    });
    return merged;
  },
});

export const listInbox = query({
  args: {
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
    since: v.optional(v.string()),
  },
  handler: async (ctx, { status, limit, since }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    
    let query = ctx.db
      .query("proactiveThoughts")
      .withIndex("byUserCreated", (q) => q.eq("userId", userId));
    
    const allThoughts = await query.collect();
    let thoughts = allThoughts.map((doc) => ({
      id: doc.thoughtId,
      category: doc.category,
      title: doc.title,
      body: doc.body,
      status: doc.status,
      urgency: doc.urgency,
      data: doc.data,
      createdAt: doc.createdAt,
      expiresAt: doc.expiresAt,
      feedback: doc.feedback,
      feedbackAt: doc.feedbackAt,
      pushSuppressedReason: doc.pushSuppressedReason,
    }));
    
    // Sort newest first
    thoughts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    
    if (status) thoughts = thoughts.filter((t) => t.status === status);
    if (since) thoughts = thoughts.filter((t) => t.createdAt > since);
    if (limit) thoughts = thoughts.slice(0, limit);
    
    return { thoughts };
  },
});

export const markThought = mutation({
  args: {
    id: v.string(),
    status: v.optional(v.string()),
    feedback: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { id, status, feedback }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    
    const thought = await ctx.db
      .query("proactiveThoughts")
      .withIndex("byThoughtId", (q) => q.eq("thoughtId", id))
      .first();
    
    if (!thought || thought.userId !== userId) {
      throw new Error("thought not found");
    }
    
    const updates: any = {};
    
    if (status && ["new", "seen", "dismissed", "acted_on"].includes(status)) {
      updates.status = status;
    }
    
    if (feedback !== undefined) {
      if (feedback === null) {
        updates.feedback = null;
        updates.feedbackAt = null;
      } else if (["helpful", "not_now", "never_again"].includes(feedback)) {
        updates.feedback = feedback;
        updates.feedbackAt = new Date().toISOString();
      }
    }
    
    await ctx.db.patch(thought._id, updates);
    
    return { ...thought, ...updates };
  },
});

export const startAvailableNow = mutation({
  args: {
    minutes: v.optional(v.number()),
    categories: v.optional(v.array(v.string())),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { minutes, categories, reason }) => {
    const user = await currentUser(ctx);
    const mins = clampInt(minutes, 1, 480, 60);
    const availableNow = {
      until: new Date(Date.now() + mins * 60 * 1000).toISOString(),
      categories: Array.isArray(categories) ? categories.filter((c) => (CATEGORIES as readonly string[]).includes(c)) : [],
      reason: typeof reason === "string" ? reason.slice(0, 500) : "",
    };
    const prefs = mergePrefs(user.preferences?.proactive, null);
    prefs.availableNow = availableNow;
    await ctx.db.patch(user._id, {
      preferences: { ...(user.preferences ?? {}), proactive: prefs },
    });
    return availableNow;
  },
});

export const stopAvailableNow = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    const prefs = mergePrefs(user.preferences?.proactive, null);
    prefs.availableNow = null;
    await ctx.db.patch(user._id, {
      preferences: { ...(user.preferences ?? {}), proactive: prefs },
    });
    return { cleared: true };
  },
});
