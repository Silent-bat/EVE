/**
 * Briefing generation for Convex
 *
 * Ports the logic from services/api-node/src/briefing/generate.mjs
 */
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { getFreshGoogleTokens } from "./lib/googleTokens";
import { listGmailMessageIds, fetchGmailMessagesByIds, fetchCalendarEvents, fetchGmailMessage } from "./lib/google";
import { parseGmailMessage } from "./lib/gmailBody";
import { analyzeMessages } from "./lib/gemini";
import { openRouterConfigured } from "./lib/openrouter";
import { urgencyScore } from "./lib/scoring";

const MAX_AUDIT_ENTRIES = 500;

/**
 * Generate or refresh a user's briefing.
 */
export const generateBriefing = action({
  args: {
    range: v.optional(v.union(v.literal("day"), v.literal("week"), v.literal("month"))),
  },
  handler: async (ctx, { range = "day" }): Promise<any> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const user = await ctx.runQuery(internal.users.getUserByUserId, { userId });
    if (!user) throw new Error("User not found");

    const now = new Date();
    const timezone = user.preferences?.timezone || "UTC";

    // --- Gmail: diff-first poll ---
    let newEmails: any[] = [];
    if (user.connectionMode === "google" && user.googleTokens) {
      try {
        newEmails = await pollGmailForUser(ctx, user, userId);
      } catch (error) {
        console.error("Gmail diff-first poll failed:", error);
      }
    }

    // --- Calendar: fresh every time ---
    let calendar: any[] = [];
    if (user.connectionMode === "google" && user.googleTokens) {
      try {
        const tokens = await getFreshGoogleTokens(ctx, user);
        calendar = await fetchCalendarEvents(tokens, now);
      } catch (error) {
        console.error("Google Calendar fetch failed:", error);
      }
    }

    // --- Assemble briefing from the priority inbox ---
    const emails = await ctx.runQuery(internal.briefings.getPriorityInbox, {
      userId,
      range,
    });

    const briefing = {
      id: `briefing-${dayKeyInZone(now, timezone)}-${range}`,
      userId,
      range,
      generatedAt: now.toISOString(),
      emails: emails || [],
      calendar: calendar || [],
      summary: {
        totalEmails: emails?.length || 0,
        highPriority: emails?.filter((e: any) => (e.urgencyScore ?? 0) >= 75).length || 0,
        upcomingEvents: calendar?.length || 0,
      },
    };

    await ctx.runMutation(internal.briefings.storeBriefing, {
      userId,
      dayKey: dayKeyInZone(now, timezone),
      range,
      briefing,
    });

    return briefing;
  },
});

/**
 * Get today's briefing (cached).
 */
export const getTodayBriefing = query({
  args: {
    range: v.optional(v.union(v.literal("day"), v.literal("week"), v.literal("month"))),
  },
  handler: async (ctx, { range = "day" }): Promise<any> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("byUserId", (q) => q.eq("userId", userId))
      .first();

    if (!user) return null;

    const timezone = user.preferences?.timezone || "UTC";
    const now = new Date();
    const dayKey = dayKeyInZone(now, timezone);

    const briefing = await ctx.db
      .query("briefings")
      .withIndex("byUserDayRange", (q) =>
        q.eq("userId", userId).eq("dayKey", dayKey).eq("range", range),
      )
      .first();

    return briefing?.briefing || null;
  },
});

/**
 * Public: the audit log (replaces GET /v1/audit).
 */
export const getAuditLog = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 100 }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const entries = await ctx.db
      .query("audit")
      .withIndex("byUserTimestamp", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit);

    return entries.map((e) => e.entry);
  },
});

/**
 * Public: fetch a single email's body (replaces GET /v1/emails/:id/body).
 */
export const getEmailBody = action({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const user = await ctx.runQuery(internal.users.getUserByUserId, { userId });
    if (!user) throw new Error("User not found");

    // Inbox rows expose `id` as the DRAFT id (`draft-<gmailId>`) while the raw
    // Gmail message id lives in `emailId`. If a caller passes the draft id,
    // strip the prefix — Gmail rejects `draft-...` with 400 "Invalid id value".
    const messageId = id.startsWith("draft-") ? id.slice("draft-".length) : id;

    // The UI expects a parsed EmailBody ({ ...headers, body, bodyAvailable }),
    // not the raw Gmail envelope. A missing body degrades (bodyAvailable:false
    // + reason) instead of throwing, so the header + summary still render.
    const base = {
      id: `draft-${messageId}`,
      threadId: "",
      senderName: "",
      senderEmail: "",
      subject: "(no subject)",
      receivedAt: "",
      urgencyScore: 0,
      urgencyReason: "",
      summary: "",
      draftReply: "",
      status: "pending" as const,
    };

    if (user.connectionMode !== "google" || !user.googleTokens) {
      return { ...base, body: "", bodyAvailable: false, reason: "Gmail is not connected" };
    }

    try {
      const tokens = await getFreshGoogleTokens(ctx, user);
      const raw = await fetchGmailMessage(tokens, messageId);
      const parsed = parseGmailMessage(raw);
      return {
        ...base,
        threadId: parsed.threadId || base.threadId,
        senderName: parsed.senderName || base.senderName,
        senderEmail: parsed.senderEmail || base.senderEmail,
        subject: parsed.subject || base.subject,
        receivedAt: parsed.receivedAt || base.receivedAt,
        body: parsed.body,
        bodyAvailable: Boolean(parsed.body),
      };
    } catch (error) {
      console.error("getEmailBody failed:", error);
      return { ...base, body: "", bodyAvailable: false, reason: "EVE couldn't reach Gmail for this message" };
    }
  },
});

/**
 * Public: the inbox emails for the Email insights screen, sourced from the
 * drafts the Gmail poller creates (real polled mail with urgency scores). This
 * works even when the AI briefing hasn't been generated — the poller falls back
 * to local scoring — so the screen shows real data rather than depending on a
 * Gemini briefing run. Shaped like BriefingEmail for the client.
 */
export const listInboxEmails = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const drafts = await ctx.db
      .query("drafts")
      .withIndex("byUserId", (q) => q.eq("userId", String(userId)))
      .order("desc")
      .take(80);

    const emails = drafts.map((d) => ({
      // Expose the DRAFT id as `id` (not the raw Gmail id) so the value
      // round-trips through approve/reject, which look a draft up byDraftId.
      // getEmailBody still resolves the body — it strips the `draft-` prefix
      // before hitting Gmail — so opening the message keeps working too.
      id: d.draftId,
      threadId: d.threadId ?? "",
      senderName: d.senderName ?? "",
      senderEmail: d.senderEmail ?? "",
      subject: d.subject ?? "(no subject)",
      receivedAt: d.createdAt,
      urgencyScore: d.urgencyScore ?? 0,
      urgencyReason: "",
      summary: "",
      draftReply: d.draftReply ?? "",
      status: d.status,
      category: d.category ?? "",
    }));
    return { emails };
  },
});

/**
 * Internal: Get priority inbox entries for a user.
 *
 * Drafts are the unit the inbox is built from: each carries its suggested
 * reply, urgency score, and pending/approved/rejected status.
 */
export const getPriorityInbox = internalQuery({
  args: {
    userId: v.string(),
    range: v.union(v.literal("day"), v.literal("week"), v.literal("month")),
  },
  handler: async (ctx, { userId }) => {
    const drafts = await ctx.db
      .query("drafts")
      .withIndex("byUserStatus", (q) => q.eq("userId", userId).eq("status", "pending"))
      .order("desc")
      .take(50);

    return drafts.map((d) => ({
      id: d.draftId,
      emailId: d.emailId,
      subject: d.subject ?? "",
      from: d.senderEmail ?? "",
      senderName: d.senderName ?? "",
      draftReply: d.draftReply,
      threadId: d.threadId,
      status: d.status,
      urgencyScore: d.urgencyScore ?? 0,
    }));
  },
});

/**
 * Internal: Upsert analyzed messages as pending drafts.
 */
export const upsertDrafts = internalMutation({
  args: {
    userId: v.string(),
    drafts: v.array(
      v.object({
        draftId: v.string(),
        emailId: v.string(),
        subject: v.optional(v.string()),
        senderEmail: v.optional(v.string()),
        senderName: v.optional(v.string()),
        draftReply: v.optional(v.string()),
        threadId: v.optional(v.string()),
        urgencyScore: v.optional(v.number()),
        category: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { userId, drafts }) => {
    for (const d of drafts) {
      const existing = await ctx.db
        .query("drafts")
        .withIndex("byDraftId", (q) => q.eq("draftId", d.draftId))
        .first();

      if (existing) continue;

      await ctx.db.insert("drafts", {
        userId,
        draftId: d.draftId,
        emailId: d.emailId,
        subject: d.subject,
        senderEmail: d.senderEmail,
        senderName: d.senderName,
        draftReply: d.draftReply ?? "",
        threadId: d.threadId,
        urgencyScore: d.urgencyScore,
        category: d.category,
        status: "pending",
        createdAt: new Date().toISOString(),
      });
    }
  },
});

/**
 * Internal: Store a generated briefing.
 */
export const storeBriefing = internalMutation({
  args: {
    userId: v.string(),
    dayKey: v.string(),
    range: v.union(v.literal("day"), v.literal("week"), v.literal("month")),
    briefing: v.any(),
  },
  handler: async (ctx, { userId, dayKey, range, briefing }) => {
    const existing = await ctx.db
      .query("briefings")
      .withIndex("byUserDayRange", (q) =>
        q.eq("userId", userId).eq("dayKey", dayKey).eq("range", range),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        briefing,
        generatedAt: new Date().toISOString(),
      });
    } else {
      await ctx.db.insert("briefings", {
        userId,
        dayKey,
        range,
        briefing,
        generatedAt: new Date().toISOString(),
      });
    }
  },
});

/**
 * Internal: append an audit entry for the current user.
 */
export const recordAudit = internalMutation({
  args: {
    userId: v.string(),
    entry: v.any(),
  },
  handler: async (ctx, { userId, entry }) => {
    await ctx.db.insert("audit", {
      userId,
      entry,
      timestamp: new Date().toISOString(),
    });

    // Keep the log bounded.
    const count = await ctx.db
      .query("audit")
      .withIndex("byUserId", (q) => q.eq("userId", userId))
      .collect();

    if (count.length > MAX_AUDIT_ENTRIES) {
      const oldest = count
        .slice()
        .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))
        .slice(0, count.length - MAX_AUDIT_ENTRIES);
      for (const doc of oldest) {
        await ctx.db.delete(doc._id);
      }
    }
  },
});

/**
 * Approve a briefing draft.
 *
 * Marks the draft approved and hands the reply to the Gmail delivery action.
 * The audit entry records the delivery outcome.
 */
export const approveDraft = mutation({
  args: {
    id: v.string(),
    draftReply: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, { id, draftReply, idempotencyKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const draft = await ctx.db
      .query("drafts")
      .withIndex("byDraftId", (q) => q.eq("draftId", id))
      .first();

    if (!draft || draft.userId !== userId) {
      throw new Error("Draft not found");
    }
    if (draft.status !== "pending") {
      throw new Error("Draft already approved or rejected");
    }

    const reply = typeof draftReply === "string" && draftReply.trim()
      ? draftReply.trim()
      : draft.draftReply;

    await ctx.db.patch(draft._id, {
      status: "approved",
      draftReply: reply,
      actionId: idempotencyKey,
      updatedAt: new Date().toISOString(),
    });

    // Delivery happens out-of-band so a slow Gmail call can't hold the mutation.
    await ctx.scheduler.runAfter(0, internal.gmail.deliverApprovedDraft, {
      userId,
      draftId: id,
      idempotencyKey,
    });

    return { success: true, subject: draft.subject };
  },
});

/**
 * Reject a briefing draft.
 */
export const rejectDraft = mutation({
  args: { id: v.string(), idempotencyKey: v.optional(v.string()) },
  handler: async (ctx, { id, idempotencyKey }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const draft = await ctx.db
      .query("drafts")
      .withIndex("byDraftId", (q) => q.eq("draftId", id))
      .first();

    if (!draft || draft.userId !== userId) {
      throw new Error("Draft not found");
    }
    if (draft.status !== "pending") {
      throw new Error("Draft already approved or rejected");
    }

    await ctx.db.patch(draft._id, {
      status: "rejected",
      actionId: idempotencyKey,
      updatedAt: new Date().toISOString(),
    });

    return { success: true, subject: draft.subject };
  },
});

// --- Helper functions ---

async function pollGmailForUser(ctx: any, user: any, userId: string): Promise<any[]> {
  const tokens = await getFreshGoogleTokens(ctx, user);
  const knownIds = new Set(user.knownMessageIds || []);

  // List all message IDs
  const allIds = await listGmailMessageIds(tokens);
  const newIds = allIds.filter((id) => !knownIds.has(id));

  if (newIds.length === 0) return [];

  // Fetch new messages
  const newMessages = await fetchGmailMessagesByIds(tokens, newIds);

  // Score messages locally
  const scored = newMessages.map((msg) => ({
    message: msg,
    score: urgencyScore(msg),
  }));

  // Sort the mail with AI when available: analyzeMessages prefers OpenRouter
  // (the "jev" router) and falls back to Gemini. Only drop to local scoring
  // when neither provider is configured.
  const geminiKey = process.env.GEMINI_API_KEY;
  const analyzed = geminiKey || openRouterConfigured()
    ? await analyzeMessages(scored, {}, geminiKey ?? "")
    : scored.map(({ message, score }) => ({
        id: message.id,
        urgencyScore: score,
        reasoning: "Local scoring",
        category: "other",
        actionable: false,
      }));

  // Persist as pending drafts so the inbox and briefing share one source.
  const drafts = analyzed.map((a: any) => {
    const headers = scored.find((s) => s.message.id === a.id)?.message?.payload?.headers ?? [];
    const getHeader = (name: string) =>
      headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

    return {
      draftId: `draft-${a.id}`,
      emailId: a.id,
      subject: getHeader("subject"),
      senderEmail: getHeader("from"),
      senderName: getHeader("from"),
      threadId: scored.find((s) => s.message.id === a.id)?.message?.threadId,
      urgencyScore: a.urgencyScore,
      category: a.category,
    };
  });

  await ctx.runMutation(internal.briefings.upsertDrafts, { userId, drafts });

  // Update known message IDs
  await ctx.runMutation(internal.users.updateKnownMessageIds, {
    userId,
    messageIds: allIds,
  });

  return analyzed;
}

function dayKeyInZone(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

/**
 * Internal: load a draft with the fields delivery needs.
 */
export const getDraftForDelivery = internalQuery({
  args: { draftId: v.string() },
  handler: async (ctx, { draftId }) => {
    return await ctx.db
      .query("drafts")
      .withIndex("byDraftId", (q) => q.eq("draftId", draftId))
      .first();
  },
});

/**
 * Internal: minimal draft rows for re-classification (the backfill that runs
 * the existing inbox back through the mail-sort classifier).
 */
export const draftsForRescore = internalQuery({
  args: { userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { userId, limit }) => {
    const rows = await ctx.db
      .query("drafts")
      .withIndex("byUserId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit ?? 300);
    return rows.map((d) => ({
      draftId: d.draftId,
      subject: d.subject ?? "",
      senderName: d.senderName ?? "",
      senderEmail: d.senderEmail ?? "",
      urgencyScore: d.urgencyScore ?? 0,
    }));
  },
});

/** Internal: write a classifier verdict (urgency + category) back onto a draft. */
export const setDraftClassification = internalMutation({
  args: {
    draftId: v.string(),
    urgencyScore: v.optional(v.number()),
    category: v.optional(v.string()),
  },
  handler: async (ctx, { draftId, urgencyScore, category }) => {
    const d = await ctx.db
      .query("drafts")
      .withIndex("byDraftId", (q) => q.eq("draftId", draftId))
      .first();
    if (!d) return;
    await ctx.db.patch(d._id, {
      ...(typeof urgencyScore === "number" ? { urgencyScore } : {}),
      ...(category ? { category } : {}),
      updatedAt: new Date().toISOString(),
    });
  },
});
