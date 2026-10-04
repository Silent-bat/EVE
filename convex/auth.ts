/**
 * Convex Auth configuration for EVE
 *
 * EVE's existing flow is email/password plus a server-side Google OAuth
 * grant for Gmail/Calendar. Convex Auth 0.0.95 ships Password and
 * ConvexCredentials providers; the native Google sign-in path hands us an
 * access token that we exchange for a verified profile here.
 */
import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { internal } from "./_generated/api";
import { encryptSecret } from "./lib/secrets";
import { exchangeAuthCode, type GoogleTokenBundle } from "./lib/googleOAuth";

/**
 * Build the encrypted googleTokens blob we persist for a Google sign-in.
 *
 * The mobile app sends a one-time `serverAuthCode` (offlineAccess); exchanging
 * it yields a refresh_token so the Gmail cron survives past the ~1h access
 * token. Everything is encrypted at rest with STATE_ENCRYPTION_KEY — the same
 * format convex/gmail.ts decryptGoogleTokens expects. Exchange failures are
 * non-fatal: we fall back to the bare access token so sign-in still succeeds.
 */
async function buildGoogleTokenBlob(
  accessToken: string,
  serverAuthCode: string,
): Promise<{ encrypted: string; hasRefresh: boolean }> {
  const key = process.env.STATE_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("STATE_ENCRYPTION_KEY must be set in the Convex deployment");
  }

  let bundle: GoogleTokenBundle = { access_token: accessToken, token_type: "Bearer" };
  const canExchange =
    serverAuthCode && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET;
  if (canExchange) {
    try {
      const exchanged = await exchangeAuthCode(serverAuthCode);
      // The exchanged access token is fresher; only fall back to the client's
      // if the exchange somehow omitted one.
      bundle = { ...exchanged, access_token: exchanged.access_token || accessToken };
    } catch (error) {
      console.error("[auth] Google serverAuthCode exchange failed:", error);
    }
  }

  const encrypted = await encryptSecret(JSON.stringify(bundle), key);
  return { encrypted, hasRefresh: Boolean(bundle.refresh_token) };
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  callbacks: {
    // Convex Auth owns the identity and `getAuthUserId` returns the `users`
    // document id. EVE keeps a denormalized `userId` field that the rest of
    // the backend indexes on, so populate it with the canonical id whenever
    // a user is created. Idempotent, so it is safe on repeat sign-ins.
    afterUserCreatedOrUpdated: async (ctx, { userId }) => {
      const user = await ctx.db.get(userId);
      if (user && !user.userId) {
        await ctx.db.patch(userId, { userId });
      }
    },
  },

  providers: [
    // Email + password. Mirrors /v1/auth/signup and /v1/auth/login.
    // EVE requires at least 8 characters; the default validator already does.
    Password({
      profile(params, ctx) {
        const email = String(params.email ?? "").trim().toLowerCase();
        if (!email) throw new Error("email is required");
        return {
          email,
          // EVE stores the display name separately; seed it from the local part.
          displayName: email.split("@")[0] ?? "",
        };
      },
    }),

    // Google native sign-in (/v1/auth/google-native). The client verifies with
    // Google and hands us an access token (to look up the profile) plus a
    // one-time serverAuthCode (to mint a refresh token). We store the tokens
    // encrypted so the Gmail cron can renew them server-side.
    //
    // The provider id defaults to "credentials"; pin it to "google" so the
    // mobile client's signIn("google", ...) reaches this provider.
    ConvexCredentials({
      id: "google",
      authorize: async (credentials, ctx) => {
        const accessToken = String(credentials.accessToken ?? "");
        if (!accessToken) {
          throw new Error("Google access token is required");
        }
        const serverAuthCode = String(credentials.serverAuthCode ?? "");

        const response = await fetch(
          "https://openidconnect.googleapis.com/v1/userinfo",
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );

        if (!response.ok) {
          throw new Error("Google profile lookup failed");
        }

        const profile = (await response.json()) as {
          email?: string;
          name?: string;
          sub?: string;
          picture?: string;
        };
        const email = String(profile.email ?? "").trim().toLowerCase();
        if (!email) throw new Error("Google did not return an email");
        const photoURL = typeof profile.picture === "string" ? profile.picture : undefined;

        // Exchange the auth code for a refresh-capable, encrypted token bundle.
        const { encrypted, hasRefresh } = await buildGoogleTokenBlob(
          accessToken,
          serverAuthCode,
        );

        // Find or create the user record that carries EVE's Google state.
        const existing = await ctx.runQuery(internal.users.getByEmail, { email });
        if (existing) {
          // Link Google on first sign-in, and refresh stored creds whenever we
          // obtained a better (refresh-capable) bundle — this also heals older
          // records that were saved with a bare/plaintext access token.
          if (!existing.googleConnected || hasRefresh) {
            await ctx.runMutation(internal.users.markGoogleConnected, {
              userId: existing.userId ?? existing._id,
              googleTokens: encrypted,
              photoURL,
            });
          }
          return { userId: existing._id };
        }

        const created = await ctx.runMutation(internal.users.createGoogleUser, {
          email,
          displayName: profile.name ?? email.split("@")[0] ?? "",
          googleTokens: encrypted,
          photoURL,
        });

        return { userId: created };
      },
    }),
  ],
});
