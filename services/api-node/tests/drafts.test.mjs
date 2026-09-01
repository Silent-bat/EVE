import assert from "node:assert/strict";
import { test } from "node:test";

import { actOnDraft } from "../src/briefing/drafts.mjs";
import { state } from "../src/storage/index.mjs";
import { ensureUserIn } from "../src/storage/state.mjs";
import { dayKeyInZone } from "../src/utils/dates.mjs";

test("draft action idempotency returns the original result on retry", async () => {
  const userID = "draft-idempotency-test";
  ensureUserIn(state, userID);
  const key = dayKeyInZone(new Date(), state.users[userID].preferences.timezone);
  state.briefings[userID][key] = {
    stats: { approvedReplies: 0 },
    emails: [
      {
        id: "draft-idempotency-1",
        threadId: "thread-1",
        senderName: "Alex",
        senderEmail: "alex@example.com",
        subject: "A request",
        draftReply: "Thanks, I will take a look.",
        status: "pending",
      },
    ],
  };
  state.audit[userID] = [];

  try {
    const first = await actOnDraft(userID, "draft-idempotency-1", {
      action: "approve",
      idempotencyKey: "request-123",
    });
    const retry = await actOnDraft(userID, "draft-idempotency-1", {
      action: "approve",
      idempotencyKey: "request-123",
    });

    assert.equal(first.audit.id, retry.audit.id);
    assert.equal(first.draft.status, "approved");
    assert.equal(state.audit[userID].length, 1);
  } finally {
    delete state.users[userID];
    delete state.briefings[userID];
    delete state.audit[userID];
    delete state.deviceNotifications[userID];
  }
});

test("an idempotency key cannot be reused for another action", async () => {
  const userID = "draft-idempotency-conflict-test";
  ensureUserIn(state, userID);
  const key = dayKeyInZone(new Date(), state.users[userID].preferences.timezone);
  state.briefings[userID][key] = {
    stats: { approvedReplies: 0 },
    emails: [
      {
        id: "draft-idempotency-2",
        senderName: "Sam",
        senderEmail: "sam@example.com",
        subject: "Another request",
        draftReply: "Noted.",
        status: "pending",
      },
    ],
  };
  state.audit[userID] = [
    {
      id: "audit-existing",
      draftId: "different-draft",
      action: "approve",
      idempotencyKey: "request-conflict",
    },
  ];

  try {
    await assert.rejects(
      () =>
        actOnDraft(userID, "draft-idempotency-2", {
          action: "approve",
          idempotencyKey: "request-conflict",
        }),
      (/** @type {any} */ error) => error?.status === 409,
    );
  } finally {
    delete state.users[userID];
    delete state.briefings[userID];
    delete state.audit[userID];
    delete state.deviceNotifications[userID];
  }
});
