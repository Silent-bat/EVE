/**
 * One-time script to clear array fields from existing users.
 * Run via: npx convex run clearUserArrays:clear
 */
import { mutation } from "./_generated/server";

export const clear = mutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    
    for (const user of users) {
      const userAny = user as any;
      const needsClear = 
        Array.isArray(userAny.knownMessageIds) ||
        Array.isArray(userAny.proactiveInbox) ||
        Array.isArray(userAny.priorityInbox) ||
        Array.isArray(userAny.pushTokens) ||
        Array.isArray(userAny.memory);
      
      if (needsClear) {
        await ctx.db.patch(user._id, {
          knownMessageIds: undefined as any,
          proactiveInbox: undefined as any,
          priorityInbox: undefined as any,
          pushTokens: undefined as any,
          memory: undefined as any,
        });
      }
    }
    
    return { cleared: users.length };
  },
});
