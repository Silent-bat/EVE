/**
 * Google OAuth token helpers for Convex.
 *
 * Ports the token-exchange / refresh logic from
 * services/api-node/src/google/oauth.mjs so the backend can run entirely on
 * Convex — no Node bridge needed to mint or renew Gmail credentials.
 *
 * The mobile app signs in natively (@react-native-google-signin, offlineAccess)
 * and hands us a one-time `serverAuthCode`. We exchange it here for a
 * refresh_token so the Gmail cron can keep working long after the initial
 * ~1h access token expires.
 */

/** Google's OAuth 2.0 token endpoint (code exchange + refresh both post here). */
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * The normalized token bundle we persist (encrypted) in users.googleTokens.
 * `expiry_date` is an absolute epoch-ms timestamp so the poller can decide
 * whether a refresh is due without tracking when it was issued.
 */
export interface GoogleTokenBundle {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}

function requireOAuthClient(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in the Convex deployment to exchange/refresh Google tokens",
    );
  }
  return { clientId, clientSecret };
}

/**
 * Turn Google's token response into our bundle, computing an absolute expiry.
 * Google returns `expires_in` (seconds); a refresh response omits
 * `refresh_token`, so callers merge the prior one back in.
 */
function normalizeTokenResponse(payload: any): GoogleTokenBundle {
  const accessToken = String(payload?.access_token ?? "");
  if (!accessToken) throw new Error("Google token response had no access_token");
  const expiresInSec = Number(payload?.expires_in);
  const bundle: GoogleTokenBundle = {
    access_token: accessToken,
    token_type: typeof payload?.token_type === "string" ? payload.token_type : "Bearer",
  };
  if (typeof payload?.refresh_token === "string" && payload.refresh_token) {
    bundle.refresh_token = payload.refresh_token;
  }
  if (typeof payload?.scope === "string" && payload.scope) {
    bundle.scope = payload.scope;
  }
  if (Number.isFinite(expiresInSec) && expiresInSec > 0) {
    bundle.expiry_date = Date.now() + expiresInSec * 1000;
  }
  return bundle;
}

/**
 * Exchange a native `serverAuthCode` for a token bundle including a
 * refresh_token. Codes obtained via the native Google Sign-In SDK are
 * exchanged against the WEB client credentials with an empty redirect_uri.
 */
export async function exchangeAuthCode(code: string): Promise<GoogleTokenBundle> {
  const { clientId, clientSecret } = requireOAuthClient();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    // Native serverAuthCodes are not tied to a web redirect URI; Google
    // expects an empty value here (not the app deep link).
    redirect_uri: "",
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google auth-code exchange failed: ${response.status} ${detail.slice(0, 500)}`);
  }
  return normalizeTokenResponse(await response.json());
}

/**
 * Mint a fresh access token from a stored refresh_token. Google does not
 * return a new refresh_token here, so the caller keeps the existing one.
 */
export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenBundle> {
  const { clientId, clientSecret } = requireOAuthClient();
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google token refresh failed: ${response.status} ${detail.slice(0, 500)}`);
  }
  const refreshed = normalizeTokenResponse(await response.json());
  // Carry the refresh token forward — a refresh response never repeats it.
  if (!refreshed.refresh_token) refreshed.refresh_token = refreshToken;
  return refreshed;
}
