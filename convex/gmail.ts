/**
 * Gmail polling + delivery for Convex
 *
 * Ports the logic from services/api-node/src/briefing/gmail-poller.mjs and
 * services/api-node/src/google/email.mjs.
 */
import { action, internalAction, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { decryptSecret, encryptSecret } from "./lib/secrets";
import { refreshAccessToken, type GoogleTokenBundle } from "./lib/googleOAuth";
import { getFreshGoogleTokens } from "./lib/googleTokens";
import { listGmailMessageIds, fetchGmailMessagesByIds } from "./lib/google";
import { urgencyScore } from "./lib/scoring";
import { analyzeMessages } from "./lib/gemini";

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
/** An inFlight flag older than this is treated as a crashed poll and cleared. */
const STALE_INFLIGHT_MS = 30 * 60 * 1000;
const NOTIFY_THRESHOLD = 75;

/**
 * Public: pull new mail on demand (the Refresh button). Runs a fresh poll for
 * the signed-in user, ignoring the 15-minute cadence, then returns so the
 * client can reload the briefing. No-op for users without Google connected.
 */
export const refreshNow = action({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; reason?: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const me = await ctx.runQuery(api.users.getCurrentUser, {});
    if (!me || me.connectionMode !== "google") {
      return { ok: false, reason: "Gmail is not connected" };
    }
    // pollOneUser polls unconditionally when invoked directly (the 15-min
    // cadence lives in sweepGmailPollers), so this is a true on-demand refresh.
    await ctx.runAction(internal.gmail.pollOneUser, { userId: String(userId) });
    return { ok: true };
  },
});

/**
 * Sweep all users and poll Gmail for those due.
 *
 * Called by the cron job every 15 minutes.
 */
export const sweepGmailPollers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Query all Google-connected users
    const users = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("connectionMode"), "google"))
      .collect();

    console.log(`[gmail-poller] Sweeping ${users.length} Google-connected users`);

    for (const user of users) {
      // Skip if no access token
      if (!user.googleTokens) continue;

      const poll = user.gmailPoll || {};
      const last = poll.lastPollAt ? new Date(poll.lastPollAt).getTime() : 0;
      const due = !last || now - last >= POLL_INTERVAL_MS;

      if (!due) continue;
      // Skip users already being polled — unless the flag is stale (a prior
      // poll crashed before clearing it), which would otherwise strand them.
      const inFlightStale = !last || now - last >= STALE_INFLIGHT_MS;
      if (poll.inFlight && !inFlightStale) continue;

      // Mark in-flight
      await ctx.db.patch(user._id, {
        gmailPoll: { ...poll, inFlight: true },
      });

      try {
        await ctx.scheduler.runAfter(0, internal.gmail.pollOneUser, {
          userId: user.userId ?? user._id,
        });
      } catch (error) {
        console.error(`[gmail-poller] Failed to schedule poll for ${user.userId}:`, error);
        await ctx.db.patch(user._id, {
          gmailPoll: { ...poll, inFlight: false },
        });
      }
    }
  },
});

/**
 * Poll Gmail for one user. Runs as an action so it can call the Gmail API.
 */
export const pollOneUser = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const user = await ctx.runQuery(internal.users.getUserByUserId, { userId });
    if (!user) {
      console.error(`[gmail-poller] User ${userId} not found`);
      return;
    }

    const now = new Date();
    const poll = user.gmailPoll || {};

    try {
      if (!user.googleTokens) throw new Error("no Google tokens");

      const tokens = await getFreshGoogleTokens(ctx, user);
      const knownIds = new Set(user.knownMessageIds || []);

      const allIds = await listGmailMessageIds(tokens);
      const newIds = allIds.filter((id) => !knownIds.has(id));

      // Bound the work per poll. Fetching hundreds of full message bodies at
      // once (e.g. the whole inbox on the first poll after connecting) blows
      // past the action's 64 MB memory limit and the process is hard-killed
      // before it can even clear its in-flight flag. Process only the most
      // recent N new messages (the list API returns newest-first); all ids are
      // still marked known below so the backlog is not re-scanned next time.
      const MAX_MESSAGES_PER_POLL = 20;
      const toProcess = newIds.slice(0, MAX_MESSAGES_PER_POLL);

      let newPriorityCount = 0;

      if (toProcess.length > 0) {
        const messages = await fetchGmailMessagesByIds(tokens, toProcess);
        const scored = messages.map((message: any) => ({ message, score: urgencyScore(message) }));

        const geminiKey = process.env.GEMINI_API_KEY;
        const analyzed = geminiKey
          ? await analyzeMessages(scored, {}, geminiKey)
          : scored.map(({ message, score }) => ({
              id: message.id,
              urgencyScore: score,
              reasoning: "Local scoring",
              category: "other",
              actionable: false,
            }));

        const drafts = analyzed.map((a: any) => {
          const source = scored.find((s) => s.message.id === a.id)?.message;
          const headers = source?.payload?.headers ?? [];
          const getHeader = (name: string) =>
            headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

          return {
            draftId: `draft-${a.id}`,
            emailId: a.id,
            subject: getHeader("subject"),
            senderEmail: getHeader("from"),
            senderName: getHeader("from"),
            threadId: source?.threadId,
            urgencyScore: a.urgencyScore,
          };
        });

        await ctx.runMutation(internal.briefings.upsertDrafts, { userId, drafts });
        await ctx.runMutation(internal.users.updateKnownMessageIds, {
          userId,
          messageIds: allIds,
        });

        newPriorityCount = analyzed.filter((a: any) => a.urgencyScore >= NOTIFY_THRESHOLD).length;

        // Notify on high-priority new mail.
        if (newPriorityCount > 0) {
          await ctx.runMutation(internal.notifications.notifyUser, {
            userId,
            title: `${newPriorityCount} new priority email${newPriorityCount > 1 ? "s" : ""}`,
            body: "Open EVE to review your inbox.",
          });
        }
      }

      await ctx.runMutation(internal.users.setPollResult, {
        userId,
        lastPollAt: now.toISOString(),
        lastPollCount: newIds.length,
        lastNewPriorityCount: newPriorityCount,
      });
    } catch (error) {
      console.error(`[gmail-poller] Poll failed for ${userId}:`, error);
      await ctx.runMutation(internal.users.clearPollInFlight, { userId });
    }
  },
});

/**
 * Deliver an approved draft reply via Gmail. Scheduled by briefings.approveDraft
 * so the mutation returns immediately.
 */
export const deliverApprovedDraft = internalAction({
  args: {
    userId: v.string(),
    draftId: v.string(),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, { userId, draftId, idempotencyKey }) => {
    const draft = await ctx.runQuery(internal.briefings.getDraftForDelivery, { draftId });
    if (!draft || draft.userId !== userId) {
      throw new Error("Draft not found");
    }
    if (draft.status !== "approved") {
      throw new Error("Draft is not approved");
    }

    const user = await ctx.runQuery(internal.users.getUserByUserId, { userId });

    const entry: Record<string, unknown> = {
      id: `audit-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      userId,
      draftId: draft.draftId,
      action: "approve",
      subject: draft.subject,
      createdAt: new Date().toISOString(),
      before: "",
      after: draft.draftReply,
    };
    if (idempotencyKey) entry.idempotencyKey = idempotencyKey;

    // Without a Google connection we record the action but send nothing.
    if (user?.connectionMode !== "google" || !user.googleTokens) {
      await ctx.runMutation(internal.briefings.recordAudit, {
        userId,
        entry: { ...entry, deliveryStatus: "audit-only" },
      });
      return { status: "audit-only" };
    }

    try {
      const tokens = await getFreshGoogleTokens(ctx, user);
      const status = await sendGmailReply(tokens, draft);

      const deliveryError = status.status === "send-failed" ? status.error : undefined;
      await ctx.runMutation(internal.briefings.recordAudit, {
        userId,
        entry: {
          ...entry,
          deliveryStatus: status.status,
          ...(deliveryError ? { deliveryError } : {}),
        },
      });
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : "gmail send failed";
      await ctx.runMutation(internal.briefings.recordAudit, {
        userId,
        entry: { ...entry, deliveryStatus: "send-failed", deliveryError: message },
      });
      return { status: "send-failed", error: message };
    }
  },
});

// --- Helpers ---

// Token access + refresh live in lib/googleTokens (shared with briefings.ts).

interface DraftForDelivery {
  draftId: string;
  userId: string;
  subject?: string;
  senderEmail?: string;
  senderName?: string;
  draftReply: string;
  threadId?: string;
  status: string;
}

/**
 * Send the raw RFC-2822 reply via Gmail's send API.
 * Returns the outcome — never throws, the caller records the audit entry.
 */
async function sendGmailReply(
  tokens: { access_token: string },
  draft: DraftForDelivery,
): Promise<{ status: "sent" } | { status: "send-failed"; error: string }> {
  if (!draft.senderEmail || !/^[^\s@]+@[^\s@]+$/.test(draft.senderEmail)) {
    return { status: "send-failed", error: "draft recipient email is invalid" };
  }
  if (typeof draft.draftReply !== "string" || !draft.draftReply.trim()) {
    return { status: "send-failed", error: "draft reply is empty" };
  }

  const rawSubject = (draft.subject ?? "(no subject)").slice(0, 998);
  const subject = rawSubject.toLowerCase().startsWith("re:") ? rawSubject : `Re: ${rawSubject}`;
  const reply = [
    `To: ${draft.senderEmail}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(draft.draftReply, "utf-8").toString("base64"),
  ].join("\r\n");

  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      raw: Buffer.from(reply, "utf-8").toString("base64url"),
      threadId: draft.threadId,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return { status: "send-failed", error: `gmail send failed: ${response.status} ${text}` };
  }

  return { status: "sent" };
}

// Kept for parity with the secrets module; Convex stores tokens encrypted at
// rest by the caller, so this is only used when re-rolling a key.
export async function reencryptTokens(plaintext: string, keyHex: string): Promise<string> {
  return encryptSecret(plaintext, keyHex);
}
