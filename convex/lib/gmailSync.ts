/**
 * Gmail message ID tracking helpers.
 * Replaces the users.knownMessageIds array with the knownGmailMessages table.
 */
import type { QueryCtx, MutationCtx } from "../_generated/server";

/**
 * Check if message IDs are known (already processed).
 */
export async function getKnownMessageIds(
  ctx: QueryCtx,
  userId: string
): Promise<Set<string>> {
  const known = await ctx.db
    .query("knownGmailMessages")
    .withIndex("byUserId", (q) => q.eq("userId", userId))
    .collect();
  
  return new Set(known.map((k) => k.messageId));
}

/**
 * Mark message IDs as known (batch insert).
 */
export async function markMessagesAsKnown(
  ctx: MutationCtx,
  userId: string,
  messageIds: string[]
): Promise<void> {
  const now = new Date().toISOString();
  
  // Insert in batches to avoid overwhelming the database
  for (const messageId of messageIds) {
    await ctx.db.insert("knownGmailMessages", {
      userId,
      messageId,
      seenAt: now,
    });
  }
}

/**
 * Get all message IDs for a user (for migration purposes).
 */
export async function getAllKnownMessageIds(
  ctx: QueryCtx,
  userId: string
): Promise<string[]> {
  const known = await ctx.db
    .query("knownGmailMessages")
    .withIndex("byUserId", (q) => q.eq("userId", userId))
    .collect();
  
  return known.map((k) => k.messageId);
}
