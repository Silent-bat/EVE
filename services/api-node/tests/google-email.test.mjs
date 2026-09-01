import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSender } from "../src/google/api.mjs";
import { deliverApprovedReply, encodeBase64URL, replyRFC822 } from "../src/google/email.mjs";
import { state } from "../src/storage/index.mjs";
import { ensureUserIn } from "../src/storage/state.mjs";

test("parseSender validates mailbox syntax and strips header controls", () => {
  assert.deepEqual(parseSender('"Ada Lovelace" <ada@example.com>'), {
    name: "Ada Lovelace",
    email: "ada@example.com",
  });
  assert.deepEqual(parseSender("ada@example.com"), { name: "ada", email: "ada@example.com" });
  const malformed = parseSender("Attacker\r\nBcc: evil@example.com <not-an-address>");
  assert.equal(malformed.email, "");
  assert.ok(!/[\r\n]/.test(malformed.name));
});

test("replyRFC822 uses UTF-8-safe base64 body encoding and sanitizes headers", () => {
  const raw = replyRFC822({
    senderName: 'Mère "A"',
    senderEmail: "mom@example.com",
    subject: "Réunion\r\nBcc: evil@example.com",
    draftReply: "Bonjour, voici la réponse: déjà fait ✓",
  });
  assert.match(raw, /^To: /m);
  assert.match(raw, /Content-Transfer-Encoding: base64/);
  assert.ok(!raw.includes("Bcc: evil@example.com"));
  const body = raw.split("\r\n\r\n")[1].replaceAll("\r\n", "");
  assert.equal(Buffer.from(body, "base64").toString("utf8"), "Bonjour, voici la réponse: déjà fait ✓");
  assert.equal(encodeBase64URL("✓"), "4pyT");
});

test("approved delivery refuses a malformed recipient instead of guessing one", async () => {
  const userID = "email-recipient-test";
  ensureUserIn(state, userID);
  state.users[userID].connectionMode = "google";
  state.users[userID].googleTokens = { access_token: "offline-token", expires_at: Date.now() + 3_600_000 };
  try {
    const result = await deliverApprovedReply(userID, {
      id: "draft-invalid-recipient",
      senderName: "Unknown",
      senderEmail: "not-an-email",
      subject: "Hello",
      draftReply: "Hi",
    });
    assert.deepEqual(result, { status: "send-failed", error: "draft recipient email is invalid" });
  } finally {
    delete state.users[userID];
    delete state.briefings[userID];
    delete state.audit[userID];
    delete state.deviceNotifications[userID];
  }
});
