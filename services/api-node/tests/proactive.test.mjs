/**
 * Tests for the proactive inbox + push-gating layer.
 *
 * shouldPush() is pure, so most tests pass it constructed inputs and assert
 * the {allow, reason} outcome. The dispatcher and inbox helpers are
 * exercised through the shared `state` object, with each test seeding its
 * own user to avoid cross-test bleed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROACTIVE_CATEGORIES,
  appendThought,
  defaultProactivePrefs,
  dispatchProactive,
  getProactivePrefs,
  inQuietHours,
  isAvailableNowActive,
  listThoughts,
  markThought,
  normalizeProactivePrefs,
  setAvailableNow,
  shouldPush,
} from "../src/notifications/proactive.mjs";
import { state } from "../src/storage/index.mjs";
import { ensureUserIn } from "../src/storage/state.mjs";

const USER = "proactive-test-user";

function seed() {
  ensureUserIn(state, USER);
  state.users[USER].email = "proactive@example.com";
  state.users[USER].pushTokens = [];
  state.users[USER].proactiveInbox = [];
  state.users[USER].preferences = {
    userId: USER,
    briefingTime: "08:00",
    pushEnabled: true,
    timezone: "Africa/Douala",
    proactive: defaultProactivePrefs(),
  };
}

/**
 * @param {Object} [overrides]
 * @param {import("../src/notifications/proactive.mjs").ProactivePrefs} [overrides.prefs]
 * @param {{ category?: string, urgency?: string }} [overrides.thought]
 * @param {string[]} [overrides.recentPushTimestamps]
 * @param {Date} [overrides.now]
 * @param {string} [overrides.timezone]
 * @param {boolean} [overrides.hasPushTokens]
 */
function baseArgs(overrides = {}) {
  const thoughtInput = overrides.thought || {};
  return {
    prefs: overrides.prefs || defaultProactivePrefs(),
    thought: {
      category: /** @type {import("../src/notifications/proactive.mjs").ProactiveCategory} */ (thoughtInput.category || "briefing_ready"),
      urgency: /** @type {import("../src/notifications/proactive.mjs").Urgency} */ (thoughtInput.urgency || "low"),
    },
    recentPushTimestamps: overrides.recentPushTimestamps || [],
    now: overrides.now || new Date("2026-06-15T12:00:00Z"),
    timezone: overrides.timezone || "UTC",
    hasPushTokens: overrides.hasPushTokens ?? true,
  };
}

// ---------- defaults & normalization ----------

test("PROACTIVE_CATEGORIES covers every category referenced by default prefs", () => {
  const defaults = defaultProactivePrefs();
  for (const name of PROACTIVE_CATEGORIES) {
    assert.ok(defaults.categories[name], `missing default category ${name}`);
  }
  // Defensive: no extras snuck in
  assert.equal(Object.keys(defaults.categories).length, PROACTIVE_CATEGORIES.length);
});

test("defaults are conservative: only briefing_ready may push out of the box", () => {
  const defaults = defaultProactivePrefs();
  const allowedToPush = Object.entries(defaults.categories).filter(
    ([, cfg]) => cfg.enabled && cfg.deliveryMode !== "silent",
  );
  assert.deepEqual(
    allowedToPush.map(([name]) => name),
    ["briefing_ready"],
  );
});

test("normalizeProactivePrefs rejects invalid quiet hours and falls back", () => {
  const base = defaultProactivePrefs();
  const next = normalizeProactivePrefs(
    { quietHoursStart: "not-a-time", quietHoursEnd: "99:99" },
    base,
  );
  assert.equal(next.quietHoursStart, base.quietHoursStart);
  assert.equal(next.quietHoursEnd, base.quietHoursEnd);
});

test("normalizeProactivePrefs clamps frequency caps", () => {
  const base = defaultProactivePrefs();
  const next = normalizeProactivePrefs({ maxPushesPerDay: 9999, maxPushesPerHour: -3 }, base);
  assert.equal(next.maxPushesPerDay, 50);
  assert.equal(next.maxPushesPerHour, 0);
});

test("normalizeProactivePrefs merges a single category without touching others", () => {
  const base = defaultProactivePrefs();
  const next = normalizeProactivePrefs(
    /** @type {any} */ ({ categories: { interview_prep: { enabled: true, threshold: "medium", deliveryMode: "push" } } }),
    base,
  );
  assert.equal(next.categories.interview_prep.enabled, true);
  assert.equal(next.categories.interview_prep.threshold, "medium");
  assert.equal(next.categories.briefing_ready.enabled, true); // unchanged
  assert.equal(next.categories.urgent_email.enabled, false); // unchanged
});

test("normalizeProactivePrefs ignores invalid category fields, keeps current", () => {
  const base = defaultProactivePrefs();
  const next = normalizeProactivePrefs(
    /** @type {any} */ ({ categories: { urgent_email: { threshold: "ultra", deliveryMode: "yelp" } } }),
    base,
  );
  assert.equal(next.categories.urgent_email.threshold, base.categories.urgent_email.threshold);
  assert.equal(next.categories.urgent_email.deliveryMode, base.categories.urgent_email.deliveryMode);
});

test("normalizeProactivePrefs drops expired availableNow windows", () => {
  const base = defaultProactivePrefs();
  const next = normalizeProactivePrefs(
    {
      availableNow: {
        until: new Date(Date.now() - 1000).toISOString(),
        categories: ["interview_prep"],
        reason: "test",
      },
    },
    base,
  );
  assert.equal(next.availableNow, null);
});

// ---------- shouldPush decision matrix ----------

test("shouldPush refuses when user has no push tokens", () => {
  const result = shouldPush(baseArgs({ hasPushTokens: false }));
  assert.deepEqual(result, { allow: false, reason: "no_push_tokens" });
});

test("shouldPush refuses when proactive master switch is off", () => {
  const prefs = defaultProactivePrefs();
  prefs.enabled = false;
  const result = shouldPush(baseArgs({ prefs }));
  assert.equal(result.allow, false);
  assert.equal(result.reason, "proactive_disabled");
});

test("shouldPush refuses when the category is opted out", () => {
  const prefs = defaultProactivePrefs();
  // interview_prep is disabled by default
  const result = shouldPush(
    baseArgs({ prefs, thought: { category: "interview_prep", urgency: "high" } }),
  );
  assert.equal(result.allow, false);
  assert.equal(result.reason, "category_disabled");
});

test("shouldPush refuses silent-mode categories even when enabled", () => {
  const prefs = defaultProactivePrefs();
  prefs.categories.interview_prep = { enabled: true, threshold: "low", deliveryMode: "silent" };
  const result = shouldPush(
    baseArgs({ prefs, thought: { category: "interview_prep", urgency: "high" } }),
  );
  assert.equal(result.allow, false);
  assert.equal(result.reason, "category_silent");
});

test("shouldPush refuses when urgency is below the category threshold", () => {
  const prefs = defaultProactivePrefs();
  prefs.categories.urgent_email = { enabled: true, threshold: "high", deliveryMode: "push" };
  const result = shouldPush(
    baseArgs({ prefs, thought: { category: "urgent_email", urgency: "medium" } }),
  );
  assert.equal(result.allow, false);
  assert.equal(result.reason, "below_threshold");
});

test("shouldPush allows when all gates pass", () => {
  const prefs = defaultProactivePrefs();
  prefs.categories.urgent_email = { enabled: true, threshold: "medium", deliveryMode: "push" };
  const result = shouldPush(
    baseArgs({ prefs, thought: { category: "urgent_email", urgency: "high" } }),
  );
  assert.equal(result.allow, true);
  assert.equal(result.reason, "ok");
});

test("shouldPush suppresses non-critical pushes during quiet hours", () => {
  const prefs = defaultProactivePrefs();
  prefs.quietHoursStart = "22:00";
  prefs.quietHoursEnd = "08:00";
  prefs.categories.urgent_email = { enabled: true, threshold: "medium", deliveryMode: "push" };
  // 02:00 UTC falls inside the 22:00–08:00 window
  const result = shouldPush(
    baseArgs({
      prefs,
      thought: { category: "urgent_email", urgency: "high" },
      now: new Date("2026-06-15T02:00:00Z"),
    }),
  );
  assert.equal(result.allow, false);
  assert.equal(result.reason, "quiet_hours");
});

test("shouldPush bypasses quiet hours for critical urgency", () => {
  const prefs = defaultProactivePrefs();
  prefs.quietHoursStart = "22:00";
  prefs.quietHoursEnd = "08:00";
  prefs.categories.urgent_email = { enabled: true, threshold: "high", deliveryMode: "push" };
  const result = shouldPush(
    baseArgs({
      prefs,
      thought: { category: "urgent_email", urgency: "critical" },
      now: new Date("2026-06-15T02:00:00Z"),
    }),
  );
  assert.equal(result.allow, true);
});

test("shouldPush bypasses quiet hours when availableNow covers the category", () => {
  const prefs = defaultProactivePrefs();
  prefs.quietHoursStart = "22:00";
  prefs.quietHoursEnd = "08:00";
  prefs.categories.interview_prep = { enabled: true, threshold: "medium", deliveryMode: "push" };
  prefs.availableNow = {
    until: new Date("2026-06-15T03:00:00Z").toISOString(),
    categories: ["interview_prep"],
    reason: "test",
  };
  const result = shouldPush(
    baseArgs({
      prefs,
      thought: { category: "interview_prep", urgency: "medium" },
      now: new Date("2026-06-15T02:00:00Z"),
    }),
  );
  assert.equal(result.allow, true);
});

test("shouldPush respects availableNow scope: doesn't override quiet hours for other categories", () => {
  const prefs = defaultProactivePrefs();
  prefs.quietHoursStart = "22:00";
  prefs.quietHoursEnd = "08:00";
  prefs.categories.urgent_email = { enabled: true, threshold: "medium", deliveryMode: "push" };
  prefs.availableNow = {
    until: new Date("2026-06-15T03:00:00Z").toISOString(),
    categories: ["interview_prep"], // not urgent_email
    reason: "test",
  };
  const result = shouldPush(
    baseArgs({
      prefs,
      thought: { category: "urgent_email", urgency: "high" },
      now: new Date("2026-06-15T02:00:00Z"),
    }),
  );
  assert.equal(result.allow, false);
  assert.equal(result.reason, "quiet_hours");
});

test("shouldPush enforces daily push cap", () => {
  const prefs = defaultProactivePrefs();
  prefs.maxPushesPerDay = 2;
  prefs.maxPushesPerHour = 99;
  prefs.categories.urgent_email = { enabled: true, threshold: "medium", deliveryMode: "push" };
  const now = new Date("2026-06-15T12:00:00Z");
  const recent = [
    new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString(),
  ];
  const result = shouldPush(
    baseArgs({
      prefs,
      thought: { category: "urgent_email", urgency: "high" },
      now,
      recentPushTimestamps: recent,
    }),
  );
  assert.equal(result.allow, false);
  assert.equal(result.reason, "daily_cap");
});

test("shouldPush enforces hourly push cap", () => {
  const prefs = defaultProactivePrefs();
  prefs.maxPushesPerDay = 99;
  prefs.maxPushesPerHour = 1;
  prefs.categories.urgent_email = { enabled: true, threshold: "medium", deliveryMode: "push" };
  const now = new Date("2026-06-15T12:00:00Z");
  const recent = [new Date(now.getTime() - 10 * 60 * 1000).toISOString()];
  const result = shouldPush(
    baseArgs({
      prefs,
      thought: { category: "urgent_email", urgency: "high" },
      now,
      recentPushTimestamps: recent,
    }),
  );
  assert.equal(result.allow, false);
  assert.equal(result.reason, "hourly_cap");
});

test("shouldPush critical bypasses both caps", () => {
  const prefs = defaultProactivePrefs();
  prefs.maxPushesPerDay = 1;
  prefs.maxPushesPerHour = 1;
  prefs.categories.urgent_email = { enabled: true, threshold: "high", deliveryMode: "push" };
  const now = new Date("2026-06-15T12:00:00Z");
  const recent = [
    new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
    new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
  ];
  const result = shouldPush(
    baseArgs({
      prefs,
      thought: { category: "urgent_email", urgency: "critical" },
      now,
      recentPushTimestamps: recent,
    }),
  );
  assert.equal(result.allow, true);
});

test("shouldPush ignores push timestamps older than 24h for daily cap", () => {
  const prefs = defaultProactivePrefs();
  prefs.maxPushesPerDay = 1;
  prefs.maxPushesPerHour = 99;
  prefs.categories.urgent_email = { enabled: true, threshold: "medium", deliveryMode: "push" };
  const now = new Date("2026-06-15T12:00:00Z");
  const recent = [new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString()];
  const result = shouldPush(
    baseArgs({
      prefs,
      thought: { category: "urgent_email", urgency: "high" },
      now,
      recentPushTimestamps: recent,
    }),
  );
  assert.equal(result.allow, true);
});

// ---------- inQuietHours edge cases ----------

test("inQuietHours: window that wraps midnight", () => {
  // 22:00 → 08:00 includes 23:00, 02:00, 07:59 but not 12:00, 21:00, 08:00 sharp
  assert.equal(inQuietHours("22:00", "08:00", new Date("2026-06-15T23:00:00Z"), "UTC"), true);
  assert.equal(inQuietHours("22:00", "08:00", new Date("2026-06-15T02:00:00Z"), "UTC"), true);
  assert.equal(inQuietHours("22:00", "08:00", new Date("2026-06-15T07:59:00Z"), "UTC"), true);
  assert.equal(inQuietHours("22:00", "08:00", new Date("2026-06-15T12:00:00Z"), "UTC"), false);
  assert.equal(inQuietHours("22:00", "08:00", new Date("2026-06-15T21:00:00Z"), "UTC"), false);
  assert.equal(inQuietHours("22:00", "08:00", new Date("2026-06-15T08:00:00Z"), "UTC"), false);
});

test("inQuietHours: non-wrapping window", () => {
  // 13:00 → 14:00 only covers that hour
  assert.equal(inQuietHours("13:00", "14:00", new Date("2026-06-15T13:30:00Z"), "UTC"), true);
  assert.equal(inQuietHours("13:00", "14:00", new Date("2026-06-15T14:00:00Z"), "UTC"), false);
  assert.equal(inQuietHours("13:00", "14:00", new Date("2026-06-15T12:59:00Z"), "UTC"), false);
});

test("inQuietHours: empty window (start === end) is never quiet", () => {
  assert.equal(inQuietHours("00:00", "00:00", new Date(), "UTC"), false);
});

test("inQuietHours: bad timezone falls back to server local, doesn't throw", () => {
  // Use a non-wrapping window so the local-time fallback is deterministic.
  assert.doesNotThrow(() =>
    inQuietHours("00:00", "23:59", new Date(), "Mars/Olympus_Mons"),
  );
});

test("inQuietHours: respects the user's timezone", () => {
  // 02:00 UTC === 03:00 in Africa/Douala (UTC+1, no DST). Quiet window
  // 22:00–08:00 in user tz should match 03:00 local.
  const at = new Date("2026-06-15T02:00:00Z");
  assert.equal(inQuietHours("22:00", "08:00", at, "Africa/Douala"), true);
  // Same instant in Asia/Tokyo (UTC+9) is 11:00 local — outside the window.
  assert.equal(inQuietHours("22:00", "08:00", at, "Asia/Tokyo"), false);
});

// ---------- isAvailableNowActive ----------

test("isAvailableNowActive: null window is never active", () => {
  assert.equal(isAvailableNowActive(null, "interview_prep", new Date()), false);
});

test("isAvailableNowActive: expired window is not active", () => {
  const window = {
    until: new Date(Date.now() - 1000).toISOString(),
    categories: /** @type {import("../src/notifications/proactive.mjs").ProactiveCategory[]} */ (["interview_prep"]),
    reason: "test",
  };
  assert.equal(isAvailableNowActive(window, "interview_prep", new Date()), false);
});

test("isAvailableNowActive: empty categories array means all categories", () => {
  const window = {
    until: new Date(Date.now() + 60_000).toISOString(),
    categories: [],
    reason: "test",
  };
  assert.equal(isAvailableNowActive(window, "interview_prep", new Date()), true);
  assert.equal(isAvailableNowActive(window, "brainstorm_idea", new Date()), true);
});

// ---------- inbox + dispatcher ----------

test("appendThought writes to inbox, newest first, capped", () => {
  seed();
  for (let i = 0; i < 5; i++) {
    appendThought(USER, {
      category: "interview_prep",
      urgency: "medium",
      title: `t${i}`,
      body: `b${i}`,
    });
  }
  const inbox = state.users[USER].proactiveInbox;
  assert.equal(inbox.length, 5);
  assert.equal(inbox[0].title, "t4");
  assert.equal(inbox[4].title, "t0");
});

test("appendThought rejects unknown category", () => {
  seed();
  assert.throws(
    () =>
      appendThought(USER, {
        category: /** @type {any} */ ("nonsense"),
        title: "t",
        body: "b",
      }),
    { status: 400 },
  );
});

test("appendThought defaults urgency to medium when missing", () => {
  seed();
  const thought = appendThought(USER, {
    category: "briefing_ready",
    title: "t",
    body: "b",
  });
  assert.equal(thought.urgency, "medium");
});

test("listThoughts filters by status and limit", () => {
  seed();
  for (let i = 0; i < 3; i++) {
    appendThought(USER, { category: "briefing_ready", title: `t${i}`, body: `b${i}` });
  }
  const inbox = state.users[USER].proactiveInbox;
  inbox[0].status = "seen";
  inbox[1].status = "dismissed";

  const allNew = listThoughts(USER, { status: "new" });
  assert.equal(allNew.length, 1);
  assert.equal(allNew[0].title, "t0");

  const limited = listThoughts(USER, { limit: 2 });
  assert.equal(limited.length, 2);
});

test("markThought updates status and feedback", () => {
  seed();
  const thought = appendThought(USER, {
    category: "interview_prep",
    title: "t",
    body: "b",
  });
  const updated = markThought(USER, thought.id, { status: "seen", feedback: "helpful" });
  assert.equal(updated.status, "seen");
  assert.equal(updated.feedback, "helpful");
  assert.ok(updated.feedbackAt);
});

test("markThought 404s on unknown id", () => {
  seed();
  assert.throws(() => markThought(USER, "nope", { status: "seen" }), { status: 404 });
});

test("setAvailableNow stores a bounded window", () => {
  seed();
  const window = setAvailableNow(USER, {
    minutes: 30,
    categories: ["interview_prep"],
    reason: "interview tomorrow",
  });
  const expectedUntil = Date.now() + 30 * 60 * 1000;
  const actualUntil = Date.parse(window.until);
  assert.ok(Math.abs(actualUntil - expectedUntil) < 2000, "until should be ~30min from now");
  assert.deepEqual(window.categories, ["interview_prep"]);
  assert.equal(window.reason, "interview tomorrow");
});

test("setAvailableNow clamps minutes to a sane range", () => {
  seed();
  const tooShort = setAvailableNow(USER, { minutes: 1 });
  const span = Date.parse(tooShort.until) - Date.now();
  assert.ok(span >= 5 * 60 * 1000 - 1000, "should be at least 5min");
  const tooLong = setAvailableNow(USER, { minutes: 9999 });
  const longSpan = Date.parse(tooLong.until) - Date.now();
  assert.ok(longSpan <= 12 * 60 * 60 * 1000 + 1000, "should cap at 12h");
});

test("getProactivePrefs returns defaults when nothing stored", () => {
  ensureUserIn(state, "fresh-user");
  state.users["fresh-user"].preferences = { userId: "fresh-user" };
  const prefs = getProactivePrefs("fresh-user");
  assert.equal(prefs.enabled, true);
  assert.equal(prefs.categories.briefing_ready.enabled, true);
  assert.equal(prefs.categories.urgent_email.enabled, false);
});

test("dispatchProactive always writes to inbox, even when push is suppressed", async () => {
  seed();
  // No push tokens registered → push must be suppressed
  const { thought, decision } = await dispatchProactive(USER, {
    category: "interview_prep",
    urgency: "high",
    title: "Interview tomorrow",
    body: "9am, Project Atlas",
  });
  assert.equal(thought.pushed, false);
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "no_push_tokens");
  assert.equal(thought.pushSuppressedReason, "no_push_tokens");

  const inbox = state.users[USER].proactiveInbox;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].title, "Interview tomorrow");
});

test("dispatchProactive records suppression reason when category is disabled", async () => {
  seed();
  state.users[USER].pushTokens = ["ExponentPushToken[FAKE]"]; // would normally send
  // interview_prep is disabled by default
  const { thought, decision } = await dispatchProactive(USER, {
    category: "interview_prep",
    urgency: "high",
    title: "t",
    body: "b",
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "category_disabled");
  assert.equal(thought.pushed, false);
  assert.equal(thought.pushSuppressedReason, "category_disabled");
});
