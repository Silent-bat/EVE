import { mutation } from "./_generated/server";

export const clear = mutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    
    for (const user of users) {
      await ctx.db.patch(user._id, {
        knownMessageIds: undefined as any,
        proactiveInbox: undefined as any,
        priorityInbox: undefined as any,
        pushTokens: undefined as any,
        memory: undefined as any,
      });
    }
    
    return { cleared: users.length };
  },
});
