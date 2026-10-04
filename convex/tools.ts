/**
 * Tool catalog + memory management for the assistant.
 *
 * Ports the tool catalog from services/api-node/src/briefing/tools.mjs.
 * Memory now backs onto the `memories` table instead of in-memory state.
 */
import { GenericId, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

export const MEMORY_KINDS = Object.freeze([
  "profile",
  "contact",
  "project",
  "preference",
  "general",
]);

export const TOOL_CATALOG = Object.freeze([
  {
    name: "answer",
    description:
      "Reply conversationally without taking an action. Use when no other tool fits or when the user just asked a question.",
    args: { text: "string — the answer to show the user" },
  },
  {
    name: "generate_briefing",
    description: "Refresh today's briefing from Gmail + Calendar and re-rank emails.",
    args: {},
  },
  {
    name: "approve_draft",
    description: "Approve a pending draft reply by id. Sends via Gmail if connected.",
    args: {
      draftId: "string — the draft id (e.g. draft-12345)",
      draftReply: "optional string — overrides the suggested reply",
    },
  },
  {
    name: "reject_draft",
    description: "Reject a pending draft reply by id.",
    args: { draftId: "string — the draft id" },
  },
  {
    name: "update_preferences",
    description: "Update the user's preferences. Use HH:MM for briefingTime, IANA strings for timezone.",
    args: {
      briefingTime: "optional string — HH:MM 24h",
      timezone: "optional string — IANA tz, e.g. Africa/Douala",
    },
  },
  {
    name: "remember",
    description:
      "Save a durable fact about the user that should persist across conversations. Use one short factual sentence.",
    args: {
      fact: "string — one concise sentence",
      kind: "optional string — one of 'profile', 'contact', 'project', 'preference', 'general'",
    },
  },
  {
    name: "forget",
    description: "Remove a saved memory by its id.",
    args: { id: "string — the memory id" },
  },
]);

export function toolCatalogPrompt(): string {
  return TOOL_CATALOG.map((t) => {
    const argList = Object.entries(t.args)
      .map(([k, val]: [string, any]) => `    "${k}": (${val})`)
      .join(",\n");
    return `- ${t.name}: ${t.description}\n  args:\n${argList || "    (none)"}`;
  }).join("\n");
}

export function normalizeMemoryKind(value: any): string {
  const kind = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (MEMORY_KINDS as readonly string[]).includes(kind) ? kind : "general";
}

/**
 * Internal: list a user's saved facts (newest first).
 */
export const listMemory = internalQuery({
  args: { userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { userId, limit = 50 }) => {
    const rows = await ctx.db
      .query("memories")
      .withIndex("byUserId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit);
    return rows.map((r) => ({ id: r._id, fact: r.fact, kind: r.kind, savedAt: r.savedAt }));
  },
});

/**
 * Public: save a durable fact about the user.
 */
export const remember = mutation({
  args: { fact: v.string(), kind: v.optional(v.string()) },
  handler: async (ctx, { fact, kind }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const text = String(fact ?? "").trim();
    if (!text) throw new Error("fact is required");

    await ctx.db.insert("memories", {
      userId,
      fact: text.slice(0, 1000),
      kind: normalizeMemoryKind(kind) as any,
      savedAt: new Date().toISOString(),
    });

    return { stored: true };
  },
});

/**
 * Public: remove a saved memory by id.
 */
export const forget = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const doc = await ctx.db.get(id as GenericId<"memories">);
    if (!doc || doc.userId !== userId) throw new Error("Memory not found");

    await ctx.db.delete(doc._id);
    return { deleted: true };
  },
});
