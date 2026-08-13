/**
 * One-shot debug: print Google token state for each authenticated user.
 * Useful for diagnosing "briefing is empty" / "have to log out + back in
 * to refresh" symptoms — tells you whether the refresh_token survived
 * the last sign-in.
 */
import { initialize, state } from "../src/storage/index.mjs";

await initialize();

for (const [userID, user] of Object.entries(state.users)) {
  if (userID === "local-user" || !user.googleConnected) continue;
  const tokens = user.googleTokens || {};
  console.log("---");
  console.log("userID         :", userID);
  console.log("email          :", user.email);
  console.log("connectionMode :", user.connectionMode);
  console.log("hasAccessToken :", Boolean(tokens.access_token));
  console.log("hasRefreshToken:", Boolean(tokens.refresh_token));
  console.log(
    "expires_at     :",
    tokens.expires_at ? new Date(tokens.expires_at).toISOString() : "n/a",
    tokens.expires_at && tokens.expires_at < Date.now() ? "(EXPIRED)" : "",
  );
  console.log("scope          :", tokens.scope || "n/a");
  console.log("client_id used :", tokens.client_id || "n/a");
  console.log("gmailPoll      :", user.gmailPoll || "(never)");
}

process.exit(0);
