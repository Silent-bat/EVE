/**
 * Tasks (todos) for Convex.
 *
 * Greenfield — this feature never existed on the Node server; the contract is
 * defined by the mobile client (apps/mobile/src/tasks/api.ts) and the `Task`
 * type. The document `_id` is exposed as the public `id` the client round-trips.
 */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { GenericId } from "convex/values";
import type { Doc } from "./_generated/dataModel";

const STATUS = v.union(v.literal("open"), v.literal("done"));
const PRIORITY = v.union(v.literal("low"), v.literal("normal"), v.literal("high"));

/** Shape a stored task doc into the client `Task` JSON (nullables as null). */
function toTask(doc: Doc<"tasks">) {
  return {
    id: doc._id,
    userId: doc.userId,
    title: doc.title,
    notes: doc.notes ?? "",
    status: doc.status,
    priority: doc.priority,
    dueAt: doc.dueAt ?? null,
    createdAt: doc.createdAt,
    completedAt: doc.completedAt ?? null,
    source: doc.source,
    sourceEmailId: doc.sourceEmailId ?? null,
  };
}

export const listTasks = query({
  args: {
    status: v.optional(STATUS),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { status, limit }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const rows = status
      ? await ctx.db
          .query("tasks")
          .withIndex("byUserStatus", (q) => q.eq("userId", String(userId)).eq("status", status))
          .order("desc")
          .take(limit ?? 200)
      : await ctx.db
          .query("tasks")
          .withIndex("byUserId", (q) => q.eq("userId", String(userId)))
          .order("desc")
          .take(limit ?? 200);

    return { tasks: rows.map(toTask) };
  },
});

export const createTask = mutation({
  args: {
    title: v.string(),
    notes: v.optional(v.string()),
    priority: v.optional(PRIORITY),
    dueAt: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { title, notes, priority, dueAt }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const trimmed = String(title ?? "").trim();
    if (!trimmed) throw new Error("title is required");

    const id = await ctx.db.insert("tasks", {
      userId: String(userId),
      title: trimmed.slice(0, 500),
      notes: (notes ?? "").slice(0, 5000),
      status: "open",
      priority: priority ?? "normal",
      ...(dueAt ? { dueAt } : {}),
      createdAt: new Date().toISOString(),
      source: "user",
    });
    const doc = await ctx.db.get(id);
    return toTask(doc!);
  },
});

export const updateTask = mutation({
  args: {
    id: v.string(),
    title: v.optional(v.string()),
    notes: v.optional(v.string()),
    status: v.optional(STATUS),
    priority: v.optional(PRIORITY),
    dueAt: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { id, title, notes, status, priority, dueAt }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const doc = await ctx.db.get(id as GenericId<"tasks">);
    if (!doc || doc.userId !== String(userId)) throw new Error("Task not found");

    const patch: Record<string, unknown> = {};
    if (title !== undefined) patch.title = title.slice(0, 500);
    if (notes !== undefined) patch.notes = notes.slice(0, 5000);
    if (priority !== undefined) patch.priority = priority;
    if (dueAt !== undefined) patch.dueAt = dueAt ?? undefined;
    if (status !== undefined) {
      patch.status = status;
      // Stamp/clear completedAt on the open⇄done transition.
      patch.completedAt = status === "done" ? new Date().toISOString() : undefined;
    }

    await ctx.db.patch(doc._id, patch);
    const updated = await ctx.db.get(doc._id);
    return toTask(updated!);
  },
});

export const deleteTask = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const doc = await ctx.db.get(id as GenericId<"tasks">);
    if (!doc || doc.userId !== String(userId)) throw new Error("Task not found");

    await ctx.db.delete(doc._id);
    return { deleted: true };
  },
});
