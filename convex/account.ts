/**
 * Account actions for Convex: change password, revoke all sessions, disconnect
 * Google, delete account. Uses @convex-dev/auth's server helpers
 * (retrieveAccount / modifyAccountCredentials / invalidateSessions), which run
 * in an action context.
 */
import { action, mutation, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import {
  getAuthUserId,
  retrieveAccount,
  modifyAccountCredentials,
  invalidateSessions,
} from "@convex-dev/auth/server";
import { api, internal } from "./_generated/api";

/**
 * Change the email/password account's password. The current password is
 * required — a live session proves the device is unlocked, not that the holder
 * knows the password.
 */
export const changePassword = action({
  args: { currentPassword: v.string(), newPassword: v.string() },
  handler: async (ctx, { currentPassword, newPassword }): Promise<{ ok: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    if (!currentPassword || !newPassword) {
      throw new Error("currentPassword and newPassword are required");
    }
    if (newPassword.length < 8) throw new Error("newPassword must be at least 8 characters");
    if (newPassword === currentPassword) throw new Error("the new password matches the old one");

    const me = await ctx.runQuery(api.users.getCurrentUser, {});
    const email = me?.email;
    if (!email) throw new Error("User not found");

    // Verify the current password (throws if wrong / if this is a Google-only account).
    try {
      await retrieveAccount(ctx, {
        provider: "password",
        account: { id: email, secret: currentPassword },
      });
    } catch {
      throw new Error("current password is incorrect");
    }

    await modifyAccountCredentials(ctx, {
      provider: "password",
      account: { id: email, secret: newPassword },
    });
    return { ok: true };
  },
});

/** Sign out of every device, including this one. */
export const revokeAllSessions = action({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; revoked: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const revoked = await ctx.runQuery(internal.account.countUserSessions, {
      userId: String(userId),
    });
    await invalidateSessions(ctx, { userId });
    return { ok: true, revoked };
  },
});

export const countUserSessions = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query("authSessions")
      .filter((q) => q.eq(q.field("userId"), userId))
      .collect();
    return rows.length;
  },
});

/**
 * Withdraw the Google grant while staying signed in. Tokens are deleted (not
 * marked stale) so nothing keeps reading mail, and a best-effort revoke is sent
 * to Google. The briefing/audit history stays — disconnecting is not deletion.
 */
export const disconnectGoogle = action({
  args: {},
  handler: async (ctx): Promise<any> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const revokeToken = await ctx.runMutation(internal.account.clearGoogleConnection, {});
    if (revokeToken) {
      try {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: revokeToken }).toString(),
        });
      } catch {
        // best-effort — local deletion is the security boundary
      }
    }
    return await ctx.runQuery(api.users.getCurrentUser, {});
  },
});

/**
 * Internal: clear the Google connection on the current user and return the
 * access/refresh token (decrypted) so the action can revoke it at Google.
 */
export const clearGoogleConnection = internalMutation({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");

    let token: string | null = null;
    if (user.googleTokens) {
      try {
        const key = process.env.STATE_ENCRYPTION_KEY;
        if (key) {
          const { decryptSecret } = await import("./lib/secrets");
          const bundle = JSON.parse(await decryptSecret(user.googleTokens, key));
          token = bundle.refresh_token || bundle.access_token || null;
        }
      } catch {
        token = null;
      }
    }

    await ctx.db.patch(user._id, {
      googleTokens: undefined,
      googleConnected: false,
      connectionMode: "none",
    });
    return token;
  },
});

/**
 * Delete the account and its data (irreversible). Also invalidates sessions.
 */
export const deleteAccount = action({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; deleted: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await ctx.runMutation(internal.account.purgeUserData, {});
    await invalidateSessions(ctx, { userId });
    return { ok: true, deleted: true };
  },
});

export const purgeUserData = internalMutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const uid = String(userId);

    // Delete the user's owned rows across tables (best-effort, indexed).
    for (const table of ["briefings", "audit", "deviceNotifications", "profiles", "memories", "drafts", "pushTokens", "tasks"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("byUserId", (q) => q.eq("userId", uid))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }
    const user = await ctx.db.get(userId);
    if (user) await ctx.db.delete(user._id);
  },
});
