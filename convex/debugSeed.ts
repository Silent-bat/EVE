/** TEMPORARY — seed realistic test data for one user so every surface renders.
 * Delete this file after use.
 *
 *   npx convex run debugSeed:listUsers                          # find the userId
 *   npx convex run debugSeed:seedForUser   '{"userId":"<id>"}'  # seed everything
 *   npx convex run debugSeed:verifyForUser '{"userId":"<id>"}'  # prove reads
 *
 * The userId is the users-document _id — that is what getAuthUserId returns and
 * what every query filters on. listUsers prints it next to each email.
 *
 * All seeded rows are namespaced ("seed-*" ids, sourceEmailId "seed", a `seed`
 * marker on audit entries) so a re-run replaces its own data and never touches
 * the user's real rows. The one exception is the day briefing + proactive inbox,
 * which are upserted/overwritten wholesale — fine for a test account.
 */
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { openRouterChat, openRouterConfigured } from "./lib/openrouter";
import { analyzeMessages } from "./lib/gemini";
import { getFreshGoogleTokens } from "./lib/googleTokens";
import { listGmailMessageIds, fetchGmailMessagesByIds } from "./lib/google";
import { urgencyScore } from "./lib/scoring";

/** yyyy-mm-dd in a timezone — mirrors briefings.ts dayKeyInZone. */
function dayKeyInZone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Every user with the fields you need to pick a seed target. */
export const listUsers = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users.map((u) => ({
      _id: u._id,
      userId: u.userId ?? null,
      email: u.email,
      displayName: u.displayName ?? null,
      connectionMode: u.connectionMode ?? "none",
      googleConnected: u.googleConnected ?? false,
    }));
  },
});

export const seedForUser = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }): Promise<any> => {
    const now = Date.now();
    const H = 3600_000;
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

    const user = await ctx.db
      .query("users")
      .withIndex("byUserId", (q) => q.eq("userId", userId))
      .first();
    const timezone = user?.preferences?.timezone || "UTC";

    // --- Emails / drafts -------------------------------------------------
    // One row per mail. `id` on the briefing email is the DRAFT id so approve/
    // reject round-trips; the matching draft row backs Email insights + actions.
    const mail = [
      { n: 1, name: "Sarah Johnson", email: "sarah.johnson@acme.com", subject: "Re: Proposal for Q3", score: 88, status: "pending" as const,
        summary: "Sarah needs the revised proposal before Thursday's meeting.",
        reason: "Direct ask from a key contact with a deadline",
        reply: "Hi Sarah,\n\nThanks for the nudge — the revised proposal with the updated pricing table is attached. Happy to walk through it before Thursday if useful.\n\nBest,\nRosnel" },
      { n: 2, name: "Michael Chen", email: "m.chen@brightpath.io", subject: "Partnership opportunity", score: 66, status: "pending" as const,
        summary: "Quick follow-up on the partnership discussion.",
        reason: "Warm lead awaiting a reply",
        reply: "Hi Michael,\n\nGreat speaking earlier. I'd love to keep this moving — are you free for 30 minutes next week to scope a pilot?\n\nBest,\nRosnel" },
      { n: 3, name: "James Patel", email: "james@northwind.vc", subject: "Re: Investment follow-up", score: 80, status: "pending" as const,
        summary: "James hasn't replied to last week's email about the round.",
        reason: "Investor thread going quiet",
        reply: "Hi James,\n\nFollowing up on my note from last week — would love your thoughts on the deck whenever you get a moment. Happy to jump on a call.\n\nBest,\nRosnel" },
      { n: 4, name: "Alyssa Wong", email: "alyssa@studio.design", subject: "Design review notes", score: 52, status: "pending" as const,
        summary: "Alyssa shared the design review notes for EVE's onboarding.",
        reason: "Actionable feedback on active work",
        reply: "Hi Alyssa,\n\nThese are really helpful — I'll fold the onboarding changes in this week and send you a build to look at.\n\nThanks,\nRosnel" },
      { n: 5, name: "Stripe", email: "receipts@stripe.com", subject: "Your payout is on the way", score: 30, status: "approved" as const,
        summary: "A payout of $2,400 is scheduled to your account.",
        reason: "Finance notice, no action needed",
        reply: "Thanks — noted." },
      { n: 6, name: "Notion", email: "digest@mail.notion.so", subject: "Your weekly digest", score: 12, status: "rejected" as const,
        summary: "Weekly activity digest from your workspace.",
        reason: "Low-signal product digest",
        reply: "No reply needed." },
    ];

    // Triage category per seed mail (what the classifier would assign).
    const seedCat: Record<number, string> = {
      1: "action", 2: "work", 3: "action", 4: "work", 5: "finance", 6: "newsletter",
    };

    // Wipe prior seed drafts, then insert fresh ones.
    const oldDrafts = await ctx.db.query("drafts").withIndex("byUserId", (q) => q.eq("userId", userId)).collect();
    for (const d of oldDrafts) if (d.draftId.startsWith("seed-")) await ctx.db.delete(d._id);
    for (const m of mail) {
      await ctx.db.insert("drafts", {
        userId,
        draftId: `seed-draft-${m.n}`,
        emailId: `seed-email-${m.n}`,
        subject: m.subject,
        senderEmail: m.email,
        senderName: m.name,
        draftReply: m.reply,
        threadId: `seed-thread-${m.n}`,
        status: m.status,
        urgencyScore: m.score,
        category: seedCat[m.n],
        createdAt: iso(m.n * 900_000),
        updatedAt: m.status === "pending" ? undefined : iso(m.n * 600_000),
      });
    }

    // Briefing emails mirror the drafts (id = draft id).
    const briefingEmails = mail.map((m) => ({
      id: `seed-draft-${m.n}`,
      threadId: `seed-thread-${m.n}`,
      senderName: m.name,
      senderEmail: m.email,
      subject: m.subject,
      receivedAt: iso(m.n * 900_000),
      urgencyScore: m.score,
      urgencyReason: m.reason,
      summary: m.summary,
      draftReply: m.reply,
      status: m.status,
      category: seedCat[m.n],
    }));

    // --- Calendar (today) ------------------------------------------------
    // Anchored to "now" so there is always a past item, one in progress (the
    // Home hero), and several upcoming — and they all land on today's date.
    const ev = (offsetH: number, durH: number, title: string, location: string) => ({
      id: `seed-ev-${title.replace(/\s+/g, "-").toLowerCase()}`,
      title,
      location,
      startsAt: new Date(now + offsetH * H).toISOString(),
      endsAt: new Date(now + (offsetH + durH) * H).toISOString(),
    });
    const calendar = [
      ev(-2, 1, "Daily planning", "Focus time"),
      ev(-0.4, 1, "Client proposal", "Meeting · Sarah Johnson"),
      ev(1.5, 0.5, "Team standup", "Google Meet"),
      ev(3, 1, "Product sync", "Zoom"),
      ev(5, 1, "Review Q3 roadmap", "Google Meet"),
      ev(7, 1, "Gym", "Personal"),
    ];

    // --- Briefing (today, range "day") — upserted -----------------------
    const dayKey = dayKeyInZone(new Date(now), timezone);
    const briefing = {
      id: `briefing-${dayKey}-day`,
      userId,
      generatedAt: new Date(now).toISOString(),
      range: "day",
      stats: {
        priorityEmails: briefingEmails.filter((e) => e.status === "pending" && e.urgencyScore >= 70).length,
        meetingsToday: calendar.length,
        approvedReplies: briefingEmails.filter((e) => e.status === "approved").length,
      },
      emails: briefingEmails,
      calendar,
    };
    const existingBriefing = await ctx.db
      .query("briefings")
      .withIndex("byUserDayRange", (q) => q.eq("userId", userId).eq("dayKey", dayKey).eq("range", "day"))
      .first();
    if (existingBriefing) await ctx.db.patch(existingBriefing._id, { briefing, generatedAt: new Date(now).toISOString() });
    else await ctx.db.insert("briefings", { userId, dayKey, range: "day", briefing, generatedAt: new Date(now).toISOString() });

    // --- Audit log (receipts for the non-pending drafts) ----------------
    const oldAudit = await ctx.db.query("audit").withIndex("byUserId", (q) => q.eq("userId", userId)).collect();
    for (const a of oldAudit) if ((a.entry as any)?.seed) await ctx.db.delete(a._id);
    const auditEntries = [
      { draftId: "seed-draft-5", action: "approve", subject: "Your payout is on the way", deliveryStatus: "sent" },
      { draftId: "seed-draft-6", action: "reject", subject: "Your weekly digest", deliveryStatus: "n/a" },
    ];
    for (const [i, a] of auditEntries.entries()) {
      await ctx.db.insert("audit", {
        userId,
        timestamp: iso(i * 300_000),
        entry: {
          id: `seed-audit-${i + 1}`,
          userId,
          draftId: a.draftId,
          action: a.action,
          subject: a.subject,
          createdAt: iso(i * 300_000),
          deliveryStatus: a.deliveryStatus,
          seed: true,
        },
      });
    }

    // --- Proactive inbox (Today "EVE suggestions") — overwritten -------
    const mkThought = (n: number, category: string, urgency: string, title: string, body: string) => ({
      id: `seed-thought-${n}`,
      userId,
      category,
      urgency,
      title,
      body,
      data: {},
      createdAt: iso(n * 600_000),
      status: "new",
      pushed: false,
      pushedAt: null,
      feedback: null,
      feedbackAt: null,
      pushSuppressedReason: null,
    });
    if (user) {
      await ctx.db.patch(user._id, {
        proactiveInbox: [
          mkThought(1, "urgent_email", "high", "Reply to Sarah about the proposal", "She needs the revised version before your 10:00 meeting. Want me to send the draft?"),
          mkThought(2, "interview_prep", "medium", "Prepare for the product sync", "It's at 2:00 PM. I can pull the two updates you owe the team."),
          mkThought(3, "project_checkin", "medium", "Follow up with James", "It's been a week since your last email about the round. Draft a nudge?"),
        ],
      });
    }

    // --- Device notifications (Captured page) ---------------------------
    const oldNotifs = await ctx.db.query("deviceNotifications").withIndex("byUserId", (q) => q.eq("userId", userId)).collect();
    for (const nrow of oldNotifs) if ((nrow.notification as any)?.id?.startsWith?.("seed-")) await ctx.db.delete(nrow._id);
    const notifs = [
      { id: "seed-notif-1", appName: "WhatsApp", title: "Sarah Johnson", body: "Can you send the contract before 5pm?", verdict: "attention" as const, category: "personal message" },
      { id: "seed-notif-2", appName: "Revolut", title: "Payment received", body: "You received £2,400 from Acme Corp.", verdict: "attention" as const, category: "finance" },
      { id: "seed-notif-3", appName: "Calendar", title: "Product sync in 30 min", body: "Zoom · with the team", verdict: "attention" as const, category: "reminder" },
      { id: "seed-notif-4", appName: "Temu", title: "90% OFF flash sale", body: "Shop now before it's gone!", verdict: "useless" as const, category: "promo" },
      { id: "seed-notif-5", appName: "Candy Crush", title: "Lives refilled", body: "Come back and play now", verdict: "useless" as const, category: "game" },
    ];
    for (const nrow of notifs) {
      await ctx.db.insert("deviceNotifications", {
        userId,
        notification: { id: nrow.id, packageName: `com.${nrow.appName.toLowerCase().replace(/\s+/g, "")}`, appName: nrow.appName, title: nrow.title, body: nrow.body, postedAt: iso(300_000) },
        receivedAt: iso(300_000),
        triage: { verdict: nrow.verdict, category: nrow.category, reason: "seeded", classifiedAt: iso(0), engine: "seed" },
      });
    }

    // --- Tasks (only prior seed tasks are removed) ----------------------
    const oldTasks = await ctx.db.query("tasks").withIndex("byUserId", (q) => q.eq("userId", userId)).collect();
    for (const t of oldTasks) if (t.sourceEmailId === "seed") await ctx.db.delete(t._id);
    const tasks = [
      { title: "Send revised proposal to Sarah", priority: "high" as const, status: "open" as const, notes: "Include the updated pricing table." },
      { title: "Prep the two updates for the product sync", priority: "normal" as const, status: "open" as const, notes: "" },
      { title: "Follow up with James on the round", priority: "high" as const, status: "open" as const, notes: "No reply to last week's email." },
      { title: "Book flights for the offsite", priority: "low" as const, status: "done" as const, notes: "" },
    ];
    for (const t of tasks) {
      await ctx.db.insert("tasks", {
        userId,
        title: t.title,
        notes: t.notes,
        status: t.status,
        priority: t.priority,
        createdAt: iso(H),
        source: "user",
        sourceEmailId: "seed",
        ...(t.status === "done" ? { completedAt: iso(H / 2) } : {}),
      });
    }

    // --- Memories (idempotent by exact fact) ----------------------------
    const memFacts = [
      { fact: "Prefers concise, bullet-first summaries.", kind: "preference" as const },
      { fact: "Works primarily in TypeScript, React Native, and Convex.", kind: "general" as const },
      { fact: "Sarah is the cofounder and main decision partner.", kind: "contact" as const },
      { fact: "Building EVE, a proactive AI assistant.", kind: "project" as const },
    ];
    const factSet = new Set(memFacts.map((m) => m.fact));
    const oldMems = await ctx.db.query("memories").withIndex("byUserId", (q) => q.eq("userId", userId)).collect();
    for (const m of oldMems) if (factSet.has(m.fact)) await ctx.db.delete(m._id);
    for (const m of memFacts) await ctx.db.insert("memories", { userId, fact: m.fact, kind: m.kind, savedAt: iso(0) });

    // --- Profile (upsert) ------------------------------------------------
    const profileFields = {
      userId,
      role: "Founder & full-stack engineer",
      industry: "AI / SaaS",
      goals: ["Ship EVE to production", "Close the seed round", "Hire 2 engineers"],
      keyContacts: ["Sarah (cofounder)", "James (investor)", "Alyssa (design)"],
      tonePreference: "Direct and warm",
    };
    const existingProfile = await ctx.db.query("profiles").withIndex("byUserId", (q) => q.eq("userId", userId)).first();
    if (existingProfile) await ctx.db.patch(existingProfile._id, profileFields);
    else await ctx.db.insert("profiles", profileFields);

    return {
      userId,
      dayKey,
      drafts: mail.length,
      briefingEmails: briefingEmails.length,
      calendar: calendar.length,
      audit: auditEntries.length,
      thoughts: 3,
      notifications: notifs.length,
      tasks: tasks.length,
      memories: memFacts.length,
      profile: 1,
    };
  },
});

/** Read every table the way the public queries do (by userId) and report
 * counts, so you can confirm each screen's endpoint will return data. */
export const verifyForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("byUserId", (q) => q.eq("userId", userId))
      .first();
    const timezone = user?.preferences?.timezone || "UTC";
    const dayKey = dayKeyInZone(new Date(), timezone);

    const drafts = await ctx.db.query("drafts").withIndex("byUserId", (q) => q.eq("userId", userId)).collect();
    const tasks = await ctx.db.query("tasks").withIndex("byUserId", (q) => q.eq("userId", userId)).collect();
    const audit = await ctx.db.query("audit").withIndex("byUserId", (q) => q.eq("userId", userId)).collect();
    const notifs = await ctx.db.query("deviceNotifications").withIndex("byUserId", (q) => q.eq("userId", userId)).collect();
    const memories = await ctx.db.query("memories").withIndex("byUserId", (q) => q.eq("userId", userId)).collect();
    const profile = await ctx.db.query("profiles").withIndex("byUserId", (q) => q.eq("userId", userId)).first();
    const briefingRow = await ctx.db
      .query("briefings")
      .withIndex("byUserDayRange", (q) => q.eq("userId", userId).eq("dayKey", dayKey).eq("range", "day"))
      .first();
    const b: any = briefingRow?.briefing ?? null;
    const inbox = Array.isArray(user?.proactiveInbox) ? user!.proactiveInbox : [];

    const counts = {
      userFound: Boolean(user),
      dayKey,
      "session (getCurrentUser)": Boolean(user),
      "email insights (listInboxEmails)": drafts.length,
      "  pending drafts": drafts.filter((d) => d.status === "pending").length,
      "today briefing emails (getTodayBriefing)": Array.isArray(b?.emails) ? b.emails.length : 0,
      "today calendar": Array.isArray(b?.calendar) ? b.calendar.length : 0,
      "tasks (listTasks)": tasks.length,
      "activity (getAuditLog)": audit.length,
      "captured (getDeviceNotifications)": notifs.length,
      "suggestions (proactive.listInbox)": inbox.length,
      "profile (getProfile)": Boolean(profile),
      "memories": memories.length,
    };
    const empties = Object.entries(counts)
      .filter(([k, v]) => k !== "dayKey" && k !== "userFound" && (v === 0 || v === false))
      .map(([k]) => k);
    return { counts, allNonEmpty: empties.length === 0, empties };
  },
});

/** Prove the mail-sort classifier reaches the OpenRouter "jev" router with the
 * stored key, and that analyzeMessages routes through it. */
export const testMailSort = internalAction({
  args: {},
  handler: async () => {
    const sample = [
      {
        message: {
          id: "t1",
          snippet: "Can you send the revised proposal before our 10am?",
          payload: { headers: [
            { name: "From", value: "Sarah Johnson <sarah@acme.com>" },
            { name: "Subject", value: "Re: Proposal for Q3" },
          ] },
        },
        score: 40,
      },
      {
        message: {
          id: "t2",
          snippet: "90% OFF flash sale ends tonight!",
          payload: { headers: [
            { name: "From", value: "Temu <deals@temu.com>" },
            { name: "Subject", value: "Your deal is waiting" },
          ] },
        },
        score: 10,
      },
    ];

    let jevReply = "";
    let jevError: string | null = null;
    try {
      jevReply = await openRouterChat(
        [
          { role: "system", content: 'Sort this email. Return ONLY JSON {"urgencyScore":0-100,"category":"work|personal|finance|travel|other","actionable":true|false}.' },
          { role: "user", content: "From: Sarah Johnson\nSubject: Re: Proposal for Q3\nPreview: Can you send the revised proposal before our 10am?" },
        ],
        { maxTokens: 120 },
      );
    } catch (e) {
      jevError = e instanceof Error ? e.message : String(e);
    }

    const analyzed = await analyzeMessages(sample as any, {}, process.env.GEMINI_API_KEY ?? "");
    return {
      openRouterConfigured: openRouterConfigured(),
      model: process.env.OPENROUTER_MODEL ?? "typesafe/jev-router",
      jevReply,
      jevError,
      analyzed,
    };
  },
});

/** Run the real mail sort: fetch this user's recent Gmail, score locally, then
 * classify through the jev router (analyzeMessages) — the exact path the poll
 * uses. Read-only; returns sender/subject + the sort result (no bodies). */
export const sortRealMail = internalAction({
  args: { userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { userId, limit = 8 }): Promise<any> => {
    const user = await ctx.runQuery(internal.users.getUserByUserId, { userId });
    if (!user) throw new Error("user not found");
    if (user.connectionMode !== "google" || !user.googleTokens) {
      return { error: "Gmail is not connected for this user", openRouterConfigured: openRouterConfigured() };
    }

    const tokens = await getFreshGoogleTokens(ctx, user);
    const ids = await listGmailMessageIds(tokens);
    const pick = ids.slice(0, Math.max(1, Math.min(limit, 20)));
    const msgs = await fetchGmailMessagesByIds(tokens, pick);
    const scored = msgs.map((m: any) => ({ message: m, score: urgencyScore(m) }));

    const analyzed = await analyzeMessages(scored, {}, process.env.GEMINI_API_KEY ?? "");
    const header = (m: any, name: string) =>
      String((m?.payload?.headers ?? []).find((h: any) => String(h?.name || "").toLowerCase() === name)?.value ?? "");

    const rows = analyzed
      .map((a: any) => {
        const m = scored.find((s) => s.message.id === a.id)?.message;
        return {
          from: header(m, "from").replace(/<[^>]*>/, "").trim().slice(0, 40) || header(m, "from").slice(0, 40),
          subject: header(m, "subject").slice(0, 70),
          local: scored.find((s) => s.message.id === a.id)?.score ?? 0,
          jev: a.urgencyScore,
          category: a.category,
          actionable: a.actionable,
          why: String(a.reasoning || "").slice(0, 90),
        };
      })
      .sort((x, y) => y.jev - x.jev);

    return {
      model: process.env.OPENROUTER_MODEL ?? "typesafe/jev-router",
      openRouterConfigured: openRouterConfigured(),
      sorted: rows.length,
      rows,
    };
  },
});

/** Backfill: run the user's existing inbox drafts back through the mail-sort
 * classifier (jev) in batches and write urgency + category onto each, so the
 * app immediately reflects the new classification. */
export const rescoreInbox = internalAction({
  args: { userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { userId, limit }): Promise<any> => {
    const drafts: any[] = await ctx.runQuery(internal.briefings.draftsForRescore, {
      userId,
      limit: limit ?? 300,
    });
    const CHUNK = 15;
    const byCategory: Record<string, number> = {};
    let updated = 0;

    for (let i = 0; i < drafts.length; i += CHUNK) {
      const batch = drafts.slice(i, i + CHUNK);
      const scored = batch.map((d) => ({
        message: {
          id: d.draftId,
          snippet: "",
          payload: {
            headers: [
              { name: "From", value: d.senderName || d.senderEmail || "" },
              { name: "Subject", value: d.subject || "" },
            ],
          },
        },
        score: d.urgencyScore ?? 0,
      }));
      const analyzed = await analyzeMessages(scored, {}, process.env.GEMINI_API_KEY ?? "");
      for (const a of analyzed) {
        await ctx.runMutation(internal.briefings.setDraftClassification, {
          draftId: a.id,
          urgencyScore: a.urgencyScore,
          category: a.category,
        });
        byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;
        updated++;
      }
    }
    return { drafts: drafts.length, updated, byCategory };
  },
});

