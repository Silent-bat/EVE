/**
 * EVE API Client: Convex version
 *
 * Replaces the REST API calls with Convex queries, mutations, and the
 * Convex Auth providers. Drop-in replacement for src/api/client.ts — the
 * rest of the app keeps calling apiFetch(path, init, token).
 *
 * Voice still talks to the Node server (see voice/api.ts).
 */
import { convex } from "./convexClient";
import {
  getRegisteredSignIn,
  type SignInFn,
} from "./authSignInRegistry";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

/**
 * Error thrown by apiFetch for a failed request, carrying an HTTP-like status
 * so call sites that used the old REST client's `ApiError` keep working.
 */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Compatibility layer: apiFetch-like interface for existing code. Every path is
 * served by Convex — there is no Node fallback.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  _token?: string | null,
): Promise<T> {
  const method = init.method ?? "GET";

  // --- Auth -------------------------------------------------------------
  if ((path === "/v1/auth/signup" || path === "/v1/auth/login") && method === "POST") {
    const { email, password } = parseBody(init);
    const flow = path === "/v1/auth/signup" ? "signUp" : "signIn";
    const session = await convexAuthSignIn("password", { email, password, flow });
    if (!session) {
      throw new Error("Signed in, but the session could not be loaded. Try again.");
    }
    return { token: "convex-session", session } as unknown as T;
  }

  if (path === "/v1/auth/logout" && method === "POST") {
    await convex.action(api.auth.signOut, {});
    return { ok: true } as unknown as T;
  }

  // Native Google sign-in: the client verified with Google and hands us an
  // access token; Convex Auth's ConvexCredentials provider exchanges it.
  if (path === "/v1/auth/google-native" && method === "POST") {
    // Forward the serverAuthCode too: Convex exchanges it for a refresh token
    // so background Gmail polling survives past the ~1h access-token lifetime.
    const { accessToken, serverAuthCode } = parseBody(init);
    const session = await convexAuthSignIn("google", { accessToken, serverAuthCode });
    if (!session) {
      throw new Error("Google sign-in succeeded, but the session could not be loaded.");
    }
    return { token: "convex-session", session } as unknown as T;
  }

  // --- Session & preferences -------------------------------------------
  if (path === "/v1/session" && method !== "POST") {
    // Only reached once the boot has decided a session exists, so a null here
    // means the freshly-restored token has not reached the client yet rather
    // than "signed out". Wait for it before giving up.
    const user = await waitForCurrentUser();
    return (user ? shapeSession(user) : null) as unknown as T;
  }

  if (path === "/v1/preferences" && method === "GET") {
    return (await convex.query(api.assistant.getPreferences)) as unknown as T;
  }

  if (path === "/v1/preferences" && method === "PUT") {
    const body = parseBody(init);
    return (await convex.mutation(api.assistant.updatePreferences, {
      preferences: body,
    })) as unknown as T;
  }

  // --- Briefings --------------------------------------------------------
  if (path === "/v1/briefings/generate" && method === "POST") {
    const { range = "day" } = parseBody(init);
    const briefing = await convex.action(api.briefings.generateBriefing, { range });
    const audit = { action: "generate", range };
    return { briefing, audit } as unknown as T;
  }

  if (path.startsWith("/v1/briefings/today")) {
    const raw = new URLSearchParams(path.split("?")[1] ?? "").get("range") ?? "day";
    const range = raw === "week" || raw === "month" ? raw : "day";
    return (await convex.query(api.briefings.getTodayBriefing, { range })) as unknown as T;
  }

  if (path.startsWith("/v1/emails/") && path.endsWith("/body")) {
    const id = path.split("/")[3];
    if (!id) throw new Error("invalid email id");
    return (await convex.action(api.briefings.getEmailBody, { id })) as unknown as T;
  }

  if (path === "/v1/audit") {
    const audit = await convex.query(api.briefings.getAuditLog, {});
    return { entries: audit } as unknown as T;
  }

  // --- Drafts -----------------------------------------------------------
  const draftActionMatch = path.match(/^\/v1\/drafts\/([^/]+)\/action$/);
  if (draftActionMatch && method === "POST") {
    const id = decodeURIComponent(draftActionMatch[1] ?? "");
    if (!id) throw new Error("invalid draft id");
    const { action, draftReply, idempotencyKey } = parseBody(init);
    if (action === "approve") {
      await convex.mutation(api.briefings.approveDraft, { id, draftReply, idempotencyKey });
    } else if (action === "reject") {
      await convex.mutation(api.briefings.rejectDraft, { id, idempotencyKey });
    } else {
      throw new Error("action must be approve or reject");
    }
    const briefing = await convex.query(api.briefings.getTodayBriefing, {});
    return {
      briefing,
      audit: { action, id },
    } as unknown as T;
  }

  // --- Device notifications --------------------------------------------
  if (path === "/v1/device-notifications" && method === "GET") {
    return (await convex.query(api.notifications.getDeviceNotifications, {})) as unknown as T;
  }

  if (path === "/v1/device-notifications" && method === "DELETE") {
    return (await convex.mutation(api.notifications.clearDeviceNotifications)) as unknown as T;
  }

  // --- Gmail ------------------------------------------------------------
  if (path === "/v1/gmail/poll" && method === "POST") {
    // The Convex poller is cron-driven; trigger an immediate user poll.
    await convex.action(api.briefings.generateBriefing, {});
    return { ok: true } as unknown as T;
  }

  // --- Push tokens ------------------------------------------------------
  if (path === "/v1/notifications/push-token" && method === "POST") {
    const { token, platform } = parseBody(init);
    return (await convex.mutation(api.notifications.registerPushToken, {
      token,
      platform,
    })) as unknown as T;
  }

  if (path.startsWith("/v1/notifications/push-token") && method === "DELETE") {
    // push.ts sends the token in the query string; older callers used the body.
    const query = new URLSearchParams(path.split("?")[1] ?? "");
    const token = query.get("token") ?? parseBody(init).token;
    // Convex has no account-wide clear (token required); the token-less legacy
    // fallback simply no-ops rather than erroring.
    if (!token) return { ok: true } as unknown as T;
    return (await convex.mutation(api.notifications.unregisterPushToken, { token })) as unknown as T;
  }

  // --- Account ----------------------------------------------------------
  if (path === "/v1/account/name" && method === "PUT") {
    const { displayName } = parseBody(init);
    return (await convex.mutation(api.users.updateDisplayName, { displayName })) as unknown as T;
  }

  // --- Assistant --------------------------------------------------------
  if (path === "/v1/assistant/ask" && method === "POST") {
    const { prompt } = parseBody(init);
    return (await convex.action(api.assistant.ask, { prompt })) as unknown as T;
  }

  // --- Profile ----------------------------------------------------------
  if (path === "/v1/profile" && method === "GET") {
    return (await convex.query(api.profile.getProfile, {})) as unknown as T;
  }

  if (path === "/v1/profile" && method === "PUT") {
    const body = parseBody(init);
    // Forward only the fields updateProfile validates; drop anything else
    // (e.g. userId) so Convex arg validation doesn't reject the call.
    const patch: Record<string, unknown> = {};
    for (const key of ["role", "industry", "goals", "keyContacts", "tonePreference"]) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    return (await convex.mutation(api.profile.updateProfile, patch)) as unknown as T;
  }

  // --- Account (password / sessions / google) --------------------------
  if (path === "/v1/account/password" && method === "PUT") {
    const { currentPassword, newPassword } = parseBody(init);
    return (await convex.action(api.account.changePassword, {
      currentPassword,
      newPassword,
    })) as unknown as T;
  }
  if (path === "/v1/account/sessions/revoke-all" && method === "POST") {
    return (await convex.action(api.account.revokeAllSessions, {})) as unknown as T;
  }
  if (path === "/v1/account/disconnect-google" && method === "POST") {
    return (await convex.action(api.account.disconnectGoogle, {})) as unknown as T;
  }
  if (path === "/v1/account" && method === "DELETE") {
    return (await convex.action(api.account.deleteAccount, {})) as unknown as T;
  }

  // --- Tasks ------------------------------------------------------------
  if (path.startsWith("/v1/tasks")) {
    const pathname = path.split("?")[0] ?? "";
    const afterId = pathname.slice("/v1/tasks".length).replace(/^\//, "");
    const id = afterId ? decodeURIComponent(afterId) : "";
    if (!id && method === "GET") {
      const query = new URLSearchParams(path.split("?")[1] ?? "");
      const status = query.get("status");
      const limit = query.get("limit");
      return (await convex.query(api.tasks.listTasks, {
        status: status === "open" || status === "done" ? status : undefined,
        limit: limit ? Number(limit) : undefined,
      })) as unknown as T;
    }
    if (!id && method === "POST") {
      return (await convex.mutation(api.tasks.createTask, parseBody(init) as any)) as unknown as T;
    }
    if (id && method === "PATCH") {
      return (await convex.mutation(api.tasks.updateTask, { id, ...parseBody(init) } as any)) as unknown as T;
    }
    if (id && method === "DELETE") {
      return (await convex.mutation(api.tasks.deleteTask, { id })) as unknown as T;
    }
  }

  // --- Proactive --------------------------------------------------------
  if (path === "/v1/proactive/preferences" && method === "GET") {
    return (await convex.query(api.proactive.getPreferences, {})) as unknown as T;
  }
  if (path === "/v1/proactive/preferences" && method === "PUT") {
    return (await convex.mutation(api.proactive.updatePreferences, { patch: parseBody(init) })) as unknown as T;
  }
  if (path.startsWith("/v1/proactive/inbox")) {
    const markMatch = (path.split("?")[0] ?? "").match(/^\/v1\/proactive\/inbox\/([^/]+)\/mark$/);
    if (markMatch && method === "POST") {
      const id = decodeURIComponent(markMatch[1] ?? "");
      const { status, feedback } = parseBody(init);
      return (await convex.mutation(api.proactive.markThought, { id, status, feedback })) as unknown as T;
    }
    if (method === "GET") {
      const query = new URLSearchParams(path.split("?")[1] ?? "");
      return (await convex.query(api.proactive.listInbox, {
        status: query.get("status") ?? undefined,
        limit: query.get("limit") ? Number(query.get("limit")) : undefined,
        since: query.get("since") ?? undefined,
      })) as unknown as T;
    }
  }
  if (path === "/v1/proactive/available-now" && method === "POST") {
    return (await convex.mutation(api.proactive.startAvailableNow, parseBody(init))) as unknown as T;
  }
  if (path === "/v1/proactive/available-now" && method === "DELETE") {
    return (await convex.mutation(api.proactive.stopAvailableNow, {})) as unknown as T;
  }

  // No Node fallback: the backend is Convex-only. An unmatched path is a bug
  // (a call site that still assumes the retired Node server), so fail loudly
  // instead of silently reaching for a server that isn't there in production.
  throw new ApiError(404, `No Convex route for ${method} ${path}`);
}


/**
 * Token store (compatibility).
 *
 * Convex Auth owns the session token; the app's call sites still read
 * tokenStore.current to decide whether a session is loaded. We keep a
 * lightweight mirror so those checks keep working during the migration.
 */
class TokenStore {
  #token: string | null = null;
  #listeners = new Set<(token: string | null) => void>();

  get current(): string | null {
    return this.#token;
  }

  async set(token: string): Promise<void> {
    this.#token = token;
    this.#emit();
  }

  async clear(): Promise<void> {
    this.#token = null;
    this.#emit();
  }

  async hydrate(): Promise<string | null> {
    this.#emit();
    return this.#token;
  }

  subscribe(listener: (token: string | null) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#token);
  }
}

export const tokenStore = new TokenStore();

/**
/**
 * signIn lives on the ConvexAuthProvider context, not the client. The auth
 * screens call this through a hook; here we shell out to the provider's
 * actions via the module-level reference set by <ConvexProvider>.
 */
async function convexAuthSignIn(provider: string, args?: Record<string, any>): Promise<any> {
  const registeredSignIn = getRegisteredSignIn();
  if (!registeredSignIn) {
    throw new Error("Convex auth is not initialized yet — try again in a moment.");
  }
  const ok = await registeredSignIn(provider, args);
  if (!ok) throw new Error("Sign-in failed. Check your email and password.");

  // The provider's `signIn` resolves *before* the client completes its token
  // handshake with the server, so an immediate `getCurrentUser` runs without
  // an authenticated context and comes back null. Poll briefly until the
  // token lands, otherwise the caller gets a null session.
  const user = await waitForCurrentUser();
  return user ? shapeSession(user) : null;
}

/**
 * Wait for the Convex client to pick up the freshly issued auth token.
 */
async function waitForCurrentUser(): Promise<any> {
  const ATTEMPTS = 15;
  const DELAY_MS = 400;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const user = await convex.query(api.users.getCurrentUser);
    if (user) return user;
    if (attempt < ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }
  return null;
}

function shapeSession(user: any): any {
  return {
    userId: user.userId,
    email: user.email,
    displayName: user.displayName ?? null,
    photoURL: user.photoURL ?? null,
    connectionMode: user.connectionMode ?? "none",
    googleConnected: user.googleConnected ?? false,
    preferences: user.preferences ?? {},
    integrations: user.integrations ?? {},
  };
}

function parseBody(init: RequestInit): Record<string, any> {
  if (typeof init.body !== "string") return {};
  try {
    return JSON.parse(init.body) as Record<string, any>;
  } catch {
    return {};
  }
}

/**
 * Convenience hooks for screens that prefer reactive data over imperative
 * fetches.
 */
export { convex, api };
export type { Id };
