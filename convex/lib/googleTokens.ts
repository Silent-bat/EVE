/**
 * Google token access with automatic refresh.
 *
 * Shared by the Gmail poller, the send path, briefing generation, and the
 * single-message body fetch — anything that needs a usable access token. It
 * decrypts the stored bundle and, when the access token is expired (or within
 * 2 minutes of it) and a refresh_token exists, mints a fresh one, re-encrypts,
 * and persists it so the next caller reuses it.
 *
 * Users who signed in before refresh tokens were captured have no
 * refresh_token; they get their (possibly stale) access token back and must
 * re-sign-in once, after which auth.ts stores a refresh-capable bundle.
 */
import { decryptSecret, encryptSecret } from "./secrets";
import { refreshAccessToken, type GoogleTokenBundle } from "./googleOAuth";
import { internal } from "../_generated/api";

export async function decryptGoogleTokens(encrypted: string): Promise<GoogleTokenBundle> {
  const key = process.env.STATE_ENCRYPTION_KEY;
  if (!key) throw new Error("STATE_ENCRYPTION_KEY not configured");
  const decrypted = await decryptSecret(encrypted, key);
  return JSON.parse(decrypted) as GoogleTokenBundle;
}

export async function getFreshGoogleTokens(
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  user: { _id: unknown; userId?: string; googleTokens?: string },
): Promise<GoogleTokenBundle> {
  if (!user.googleTokens) throw new Error("no Google tokens");
  const bundle = await decryptGoogleTokens(user.googleTokens);

  const expiryDate = typeof bundle.expiry_date === "number" ? bundle.expiry_date : 0;
  const expiresSoon = !expiryDate || expiryDate - Date.now() < 120_000;
  if (!expiresSoon || !bundle.refresh_token) {
    return bundle;
  }

  const refreshed = await refreshAccessToken(bundle.refresh_token);
  const key = process.env.STATE_ENCRYPTION_KEY;
  if (key) {
    const encrypted = await encryptSecret(JSON.stringify(refreshed), key);
    await ctx.runMutation(internal.users.updateGoogleTokens, {
      userId: user.userId ?? String(user._id),
      googleTokens: encrypted,
    });
  }
  return refreshed;
}
