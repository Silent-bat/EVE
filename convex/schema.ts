/**
 * EVE Data Model for Convex
 *
 * Maps 1:1 with the current state shape but using Convex tables.
 */
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export default defineSchema({
  ...authTables,

  // Core users table (from state.users)
  users: defineTable({
    userId: v.optional(v.string()),
    email: v.string(),
    displayName: v.optional(v.string()),
    photoURL: v.optional(v.string()),
    passwordHash: v.optional(v.string()),
    passwordAuthEnabled: v.optional(v.boolean()),
    googleConnected: v.optional(v.boolean()),
    connectionMode: v.optional(
      v.union(
        v.literal("none"),
        v.literal("google")
      )
    ),
    googleTokens: v.optional(v.string()),
    preferences: v.optional(
      v.object({
        timezone: v.optional(v.string()),
        briefingTime: v.optional(v.string()),
        proactive: v.optional(v.any()),
      })
    ),
    integrations: v.optional(v.any()),
    gmailPoll: v.optional(v.object({
      lastPollAt: v.optional(v.string()),
      lastPollCount: v.optional(v.number()),
      lastNewPriorityCount: v.optional(v.number()),
      inFlight: v.optional(v.boolean()),
    })),
  })
    .index("byUserId", ["userId"])
    .index("byEmail", ["email"]),

  briefings: defineTable({
    userId: v.string(),
    dayKey: v.string(),
    range: v.union(
      v.literal("day"),
      v.literal("week"),
      v.literal("month")
    ),
    briefing: v.any(),
    generatedAt: v.string(),
  })
    .index("byUserDayRange", ["userId", "dayKey", "range"])
    .index("byUserId", ["userId"]),

  audit: defineTable({
    userId: v.string(),
    entry: v.any(),
    timestamp: v.string(),
  })
    .index("byUserId", ["userId"])
    .index("byUserTimestamp", ["userId", "timestamp"]),

  deviceNotifications: defineTable({
    userId: v.string(),
    notification: v.any(),
    receivedAt: v.string(),
    triage: v.optional(
      v.object({
        verdict: v.union(v.literal("attention"), v.literal("useless"), v.literal("pending")),
        category: v.optional(v.string()),
        reason: v.optional(v.string()),
        classifiedAt: v.optional(v.string()),
        engine: v.optional(v.string()),
      }),
    ),
  })
    .index("byUserId", ["userId"])
    .index("byUserReceived", ["userId", "receivedAt"]),

  oauthStates: defineTable({
    stateKey: v.string(),
    userId: v.optional(v.string()),
    mode: v.union(
      v.literal("login"),
      v.literal("connect"),
      v.literal("handoff")
    ),
    returnTo: v.optional(v.string()),
    expiresAt: v.string(),
  })
    .index("byStateKey", ["stateKey"])
    .index("byUserMode", ["userId", "mode"]),

  profiles: defineTable({
    userId: v.string(),
    role: v.optional(v.string()),
    industry: v.optional(v.string()),
    goals: v.optional(v.array(v.string())),
    keyContacts: v.optional(v.array(v.any())),
    tonePreference: v.optional(v.string()),
  })
    .index("byUserId", ["userId"]),

  memories: defineTable({
    userId: v.string(),
    fact: v.string(),
    kind: v.union(
      v.literal("profile"),
      v.literal("contact"),
      v.literal("project"),
      v.literal("preference"),
      v.literal("general")
    ),
    savedAt: v.string(),
  })
    .index("byUserId", ["userId"])
    .index("byUserKind", ["userId", "kind"]),

  drafts: defineTable({
    userId: v.string(),
    draftId: v.string(),
    emailId: v.string(),
    subject: v.optional(v.string()),
    senderEmail: v.optional(v.string()),
    senderName: v.optional(v.string()),
    draftReply: v.string(),
    threadId: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected")
    ),
    urgencyScore: v.optional(v.number()),
    category: v.optional(v.string()),
    actionId: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.optional(v.string()),
  })
    .index("byUserId", ["userId"])
    .index("byDraftId", ["draftId"])
    .index("byUserStatus", ["userId", "status"]),

  tasks: defineTable({
    userId: v.string(),
    title: v.string(),
    notes: v.string(),
    status: v.union(v.literal("open"), v.literal("done")),
    priority: v.union(v.literal("low"), v.literal("normal"), v.literal("high")),
    dueAt: v.optional(v.string()),
    createdAt: v.string(),
    completedAt: v.optional(v.string()),
    source: v.union(v.literal("eve"), v.literal("user")),
    sourceEmailId: v.optional(v.string()),
  })
    .index("byUserId", ["userId"])
    .index("byUserStatus", ["userId", "status"]),

  pushTokens: defineTable({
    userId: v.string(),
    token: v.string(),
    platform: v.optional(v.union(
      v.literal("ios"),
      v.literal("android"),
      v.literal("web")
    )),
    createdAt: v.string(),
  })
    .index("byUserId", ["userId"])
    .index("byToken", ["token"]),

  proactiveThoughts: defineTable({
    userId: v.string(),
    thoughtId: v.string(),
    category: v.union(
      v.literal("urgent_email"),
      v.literal("interview_prep"),
      v.literal("project_checkin"),
      v.literal("brainstorm_idea"),
      v.literal("briefing_ready")
    ),
    title: v.string(),
    body: v.string(),
    status: v.union(
      v.literal("new"),
      v.literal("seen"),
      v.literal("dismissed"),
      v.literal("acted_on")
    ),
    urgency: v.union(
      v.literal("low"),
      v.literal("medium"),
      v.literal("high"),
      v.literal("critical")
    ),
    data: v.optional(v.any()),
    createdAt: v.string(),
    expiresAt: v.optional(v.string()),
    feedback: v.optional(v.union(
      v.literal("helpful"),
      v.literal("not_now"),
      v.literal("never_again"),
      v.null()
    )),
    feedbackAt: v.optional(v.union(v.string(), v.null())),
    pushSuppressedReason: v.optional(v.union(v.string(), v.null())),
  })
    .index("byUserId", ["userId"])
    .index("byThoughtId", ["thoughtId"])
    .index("byUserStatus", ["userId", "status"])
    .index("byUserCreated", ["userId", "createdAt"]),

  knownGmailMessages: defineTable({
    userId: v.string(),
    messageId: v.string(),
    seenAt: v.string(),
  })
    .index("byUserId", ["userId"])
    .index("byUserMessage", ["userId", "messageId"]),

  priorityMail: defineTable({
    userId: v.string(),
    emailId: v.string(),
    threadId: v.optional(v.string()),
    subject: v.optional(v.string()),
    senderEmail: v.optional(v.string()),
    senderName: v.optional(v.string()),
    snippet: v.optional(v.string()),
    urgencyScore: v.number(),
    category: v.optional(v.string()),
    addedAt: v.string(),
    readAt: v.optional(v.string()),
  })
    .index("byUserId", ["userId"])
    .index("byUserAdded", ["userId", "addedAt"])
    .index("byEmailId", ["emailId"]),
});
