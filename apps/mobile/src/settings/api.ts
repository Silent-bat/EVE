import { apiFetch } from "../api/client";
import type { Session } from "../types";

/**
 * Irreversible. The server drops the user row, which cascades to briefings,
 * the audit trail, captured notifications, stored Google tokens, and every
 * session — so the token in `tokenStore` is dead the moment this returns and
 * the caller must fall back to the sign-in screen.
 */
export async function deleteAccount(): Promise<void> {
  await apiFetch<{ ok: boolean; deleted: boolean }>("/v1/account", { method: "DELETE" });
}

/**
 * Rename the account. Returns the whole session because the name is one of the
 * fields the header and avatar read from it — re-rendering from the server's
 * copy avoids the app and the backend holding different names.
 *
 * Passing an empty string clears it, and the UI falls back to the email.
 */
export async function setDisplayName(displayName: string): Promise<Session> {
  return apiFetch<Session>("/v1/account/name", {
    method: "PUT",
    body: JSON.stringify({ displayName }),
  });
}

/**
 * Change the password on an email/password account. The current one is
 * required: holding a session proves the phone is unlocked, not that the person
 * holding it knows the password.
 */
export async function changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
  await apiFetch<{ ok: boolean }>("/v1/account/password", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/**
 * Withdraw the Google grant while staying signed in to EVE. Sign-out also
 * revokes it, but that ends the session too — this is the version for someone
 * who wants to keep their account and stop EVE reading their mail.
 */
export async function disconnectGoogle(): Promise<Session> {
  return apiFetch<Session>("/v1/account/disconnect-google", { method: "POST" });
}

/**
 * Sign out of every device, this one included. The caller must drop its token
 * and return to the sign-in screen — it was revoked along with the others.
 */
export async function revokeAllSessions(): Promise<{ revoked: number }> {
  return apiFetch<{ ok: boolean; revoked: number }>("/v1/account/sessions/revoke-all", {
    method: "POST",
  });
}
