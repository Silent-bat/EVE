/**
 * Migration: Remove array fields from users table
 */
import { internalMutation } from "../_generated/server";

export const migrate = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    let migratedUsers = 0;
    let migratedMessages = 0;
    let migratedThoughts = 0;

    for (const user of users) {
      let needsUpdate = false;

      // Migrate knownMessageIds to knownGmailMessages table
      if (Array.isArray((user as any).knownMessageIds)) {
        const messageIds = (user as any).knownMessageIds as string[];
        const now = new Date().toISOString();
        
        for (const messageId of messageIds) {
          await ctx.db.insert("knownGmailMessages", {
            userId: user.userId || user._id,
            messageId,
            seenAt: now,
          });
          migratedMessages++;
        }
        
        needsUpdate = true;
      }

      // Migrate proactiveInbox to proactiveThoughts table
      if (Array.isArray((user as any).proactiveInbox)) {
        const inbox = (user as any).proactiveInbox as any[];
        
        for (const thought of inbox) {
          if (thought && typeof thought === 'object') {
            await ctx.db.insert("proactiveThoughts", {
              userId: user.userId || user._id,
              thoughtId: thought.id || `migrated-${Date.now()}-${Math.random()}`,
              category: thought.category || "urgent_email",
              title: thought.title || "",
              body: thought.body || "",
              status: thought.status || "new",
              urgency: thought.urgency || "medium",
              data: thought.data,
              createdAt: thought.createdAt || new Date().toISOString(),
              expiresAt: thought.expiresAt,
              feedback: thought.feedback,
              feedbackAt: thought.feedbackAt,
              pushSuppressedReason: thought.pushSuppressedReason,
            });
            migratedThoughts++;
          }
        }
        
        needsUpdate = true;
      }

      if (needsUpdate) {
        await ctx.db.patch(user._id, {
          knownMessageIds: undefined as any,
          proactiveInbox: undefined as any,
          priorityInbox: undefined as any,
          pushTokens: undefined as any,
        });
        migratedUsers++;
      }
    }

    return {
      migratedUsers,
      migratedMessages,
      migratedThoughts,
      message: `Migrated ${migratedUsers} users, ${migratedMessages} Gmail messages, ${migratedThoughts} proactive thoughts`,
    };
  },
});
