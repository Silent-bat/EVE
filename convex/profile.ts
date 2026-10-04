/**
 * User profile management for Convex
 *
 * Ports logic from services/api-node/src/profile/index.mjs
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

/**
 * Get the current user's profile.
 */
export const getProfile = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const profile = await ctx.db
      .query("profiles")
      .withIndex("byUserId", (q) => q.eq("userId", userId))
      .first();

    if (!profile) {
      // Return default empty profile
      return {
        userId,
        role: null,
        industry: null,
        goals: [],
        keyContacts: [],
        tonePreference: null,
      };
    }

    return {
      userId: profile.userId,
      role: profile.role || null,
      industry: profile.industry || null,
      goals: profile.goals || [],
      keyContacts: profile.keyContacts || [],
      tonePreference: profile.tonePreference || null,
    };
  },
});

/**
 * Update the current user's profile.
 */
export const updateProfile = mutation({
  args: {
    role: v.optional(v.string()),
    industry: v.optional(v.string()),
    goals: v.optional(v.array(v.string())),
    keyContacts: v.optional(v.array(v.any())),
    tonePreference: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const existing = await ctx.db
      .query("profiles")
      .withIndex("byUserId", (q) => q.eq("userId", userId))
      .first();

    if (existing) {
      // Update existing profile
      await ctx.db.patch(existing._id, {
        ...(args.role !== undefined && { role: args.role }),
        ...(args.industry !== undefined && { industry: args.industry }),
        ...(args.goals !== undefined && { goals: args.goals }),
        ...(args.keyContacts !== undefined && { keyContacts: args.keyContacts }),
        ...(args.tonePreference !== undefined && { tonePreference: args.tonePreference }),
      });

      return await ctx.db.get(existing._id);
    } else {
      // Create new profile
      const id = await ctx.db.insert("profiles", {
        userId,
        role: args.role,
        industry: args.industry,
        goals: args.goals,
        keyContacts: args.keyContacts,
        tonePreference: args.tonePreference,
      });

      return await ctx.db.get(id);
    }
  },
});
