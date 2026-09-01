/**
 * Proactive inbox + gating layer.
 *
 * The agent is always allowed to "have a thought" — every proactive idea is
 * written to the user's `proactiveInbox` and visible when they open the app.
 * Whether that thought also turns into a push notification is a separate
 * decision, gated by `shouldPush()`: master switch, per-category opt-in,
 * urgency threshold, quiet hours, frequency caps. The split lets the agent
 * feel ambient and ready without becoming invasive.
 *
 * `shouldPush()` is intentionally pure — feed it (prefs, thought, recent
 * pushes, now) and it returns a decision. Side effects (writing to the
 * inbox, calling Expo) live in `dispatchProactive()` which composes the
 * decision with the storage + push transport.
 */
import { moduleLogger } from "../logger.mjs";
import { httpError } from "../http/responses.mjs";
import { save, state } from "../storage/index.mjs";
import { sanitizePlainText } from "../briefing/scoring.mjs";
import { boundedJSONValue } from "../briefing/prompt.mjs";
import { sendPushToUser } from "./push.mjs";

const log = moduleLogger("notifications.proactive");

const INBOX_LIMIT = 200;
// Thought metadata is shown in notifications and persisted with the inbox.
// Keep provider/model supplied objects small and JSON-safe before either path.
const MAX_THOUGHT_DATA_CHARS = 8_000;

/**
 * Canonical proactive categories. Each one is independently opt-in with its
 * own threshold and delivery mode so a single bad interruption can't poison
 * the whole feature.
 */
export const PROACTIVE_CATEGORIES = /** @type {const} */ ([
  "urgent_email", // a single email crossed the urgency threshold mid-day
  "interview_prep", // calendar item soon + related context in memory
  "project_checkin", // user mentioned a project, agent wants to follow up
  "brainstorm_idea", // agent noticed something worth riffing on
  "briefing_ready", // the daily briefing is generated and waiting
]);

/** @typedef {(typeof PROACTIVE_CATEGORIES)[number]} ProactiveCategory */

const URGENCY_RANK = /** @type {const} */ ({
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
});
/** @typedef {keyof typeof URGENCY_RANK} Urgency */

const DELIVERY_MODES = /** @type {const} */ (["silent", "soft", "push"]);
/** @typedef {(typeof DELIVERY_MODES)[number]} DeliveryMode */

/**
 * @typedef {Object} CategoryPrefs
 * @property {boolean} enabled
 * @property {Urgency} threshold      Min urgency that may push (low = anything)
 * @property {DeliveryMode} deliveryMode
 */

/**
 * @typedef {Object} ProactivePrefs
 * @property {boolean} enabled            Master switch
 * @property {string} quietHoursStart     "HH:MM" in user's timezone
 * @property {string} quietHoursEnd       "HH:MM" in user's timezone
 * @property {number} maxPushesPerDay
 * @property {number} maxPushesPerHour
 * @property {Record<ProactiveCategory, CategoryPrefs>} categories
 * @property {AvailableNow | null} availableNow
 */

/**
 * @typedef {Object} AvailableNow
 * @property {string} until               ISO timestamp
 * @property {ProactiveCategory[]} categories  Categories this override applies to
 * @property {string} reason
 */

/**
 * @typedef {Object} Thought
 * @property {string} id
 * @property {string} userId
 * @property {ProactiveCategory} category
 * @property {Urgency} urgency
 * @property {string} title
 * @property {string} body
 * @property {Record<string, unknown>} data
 * @property {string} createdAt
 * @property {'new' | 'seen' | 'dismissed' | 'acted_on'} status
 * @property {boolean} pushed
 * @property {string | null} pushedAt
 * @property {'helpful' | 'not_now' | 'never_again' | null} feedback
 * @property {string | null} feedbackAt
 * @property {string | null} pushSuppressedReason
 */

/**
 * Defaults are deliberately conservative: only the existing "briefing_ready"
 * notification is on by default. Everything else is silent-only until the
 * user explicitly opts in.
 *
 * @returns {ProactivePrefs}
 */
export function defaultProactivePrefs() {
  return {
    enabled: true, // master switch on, but per-category opt-in still required
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    maxPushesPerDay: 3,
    maxPushesPerHour: 1,
    categories: {
      urgent_email: { enabled: false, threshold: "high", deliveryMode: "silent" },
      interview_prep: { enabled: false, threshold: "high", deliveryMode: "silent" },
      project_checkin: { enabled: false, threshold: "high", deliveryMode: "silent" },
      brainstorm_idea: { enabled: false, threshold: "high", deliveryMode: "silent" },
      briefing_ready: { enabled: true, threshold: "low", deliveryMode: "push" },
    },
    availableNow: null,
  };
}

/**
 * Merge user input over current prefs with validation. Unknown keys are
 * dropped; bad values fall back to the current value.
 *
 * @param {Partial<ProactivePrefs> | undefined} input
 * @param {ProactivePrefs} [current]
 * @returns {ProactivePrefs}
 */
export function normalizeProactivePrefs(input, current) {
  const defaults = defaultProactivePrefs();
  const rawBase = /** @type {Record<string, any>} */ (
    current && typeof current === "object" && !Array.isArray(current) ? current : defaults
  );
  const baseCategories = /** @type {Record<string, any>} */ (
    rawBase.categories && typeof rawBase.categories === "object" && !Array.isArray(rawBase.categories)
      ? rawBase.categories
      : {}
  );
  /** @type {ProactivePrefs} */
  const base = {
    enabled: typeof rawBase.enabled === "boolean" ? rawBase.enabled : defaults.enabled,
    quietHoursStart: validHHMM(rawBase.quietHoursStart) ? rawBase.quietHoursStart : defaults.quietHoursStart,
    quietHoursEnd: validHHMM(rawBase.quietHoursEnd) ? rawBase.quietHoursEnd : defaults.quietHoursEnd,
    maxPushesPerDay: clampInt(rawBase.maxPushesPerDay, 0, 50, defaults.maxPushesPerDay),
    maxPushesPerHour: clampInt(rawBase.maxPushesPerHour, 0, 10, defaults.maxPushesPerHour),
    categories: /** @type {ProactivePrefs["categories"]} */ (
      Object.fromEntries(
        PROACTIVE_CATEGORIES.map((name) => [
          name,
          normalizeCategoryPrefs(baseCategories[name], defaults.categories[name]),
        ]),
      )
    ),
    availableNow: normalizeAvailableNow(rawBase.availableNow, defaults.availableNow),
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) return base;

  /** @type {ProactivePrefs} */
  const next = {
    enabled: typeof input.enabled === "boolean" ? input.enabled : base.enabled,
    quietHoursStart: validHHMM(input.quietHoursStart) ? input.quietHoursStart : base.quietHoursStart,
    quietHoursEnd: validHHMM(input.quietHoursEnd) ? input.quietHoursEnd : base.quietHoursEnd,
    maxPushesPerDay: clampInt(input.maxPushesPerDay, 0, 50, base.maxPushesPerDay),
    maxPushesPerHour: clampInt(input.maxPushesPerHour, 0, 10, base.maxPushesPerHour),
    categories: { ...base.categories },
    availableNow: normalizeAvailableNow(input.availableNow, base.availableNow),
  };

  if (input.categories && typeof input.categories === "object" && !Array.isArray(input.categories)) {
    for (const name of PROACTIVE_CATEGORIES) {
      const incoming = /** @type {any} */ (input.categories)[name];
      if (!incoming || typeof incoming !== "object") continue;
      const curCat = base.categories[name];
      next.categories[name] = {
        enabled: typeof incoming.enabled === "boolean" ? incoming.enabled : curCat.enabled,
        threshold: isUrgency(incoming.threshold) ? incoming.threshold : curCat.threshold,
        deliveryMode: isDeliveryMode(incoming.deliveryMode) ? incoming.deliveryMode : curCat.deliveryMode,
      };
    }
  }

  return next;
}

/**
 * @param {unknown} input
 * @param {AvailableNow | null} current
 * @returns {AvailableNow | null}
 */
function normalizeAvailableNow(input, current) {
  if (input === null) return null;
  if (!input || typeof input !== "object") return current;
  const obj = /** @type {Record<string, unknown>} */ (input);
  const until = typeof obj.until === "string" ? Date.parse(obj.until) : NaN;
  if (Number.isNaN(until) || until <= Date.now()) return null;
  const cats = Array.isArray(obj.categories) ? obj.categories.filter((c) => isCategory(c)) : [];
  return {
    until: new Date(until).toISOString(),
    categories: /** @type {ProactiveCategory[]} */ (cats),
    reason: sanitizePlainText(obj.reason, 120) || "available_now",
  };
}

/**
 * Get the user's proactive prefs, falling back to defaults if absent. Does
 * NOT persist defaults — that's `ensureUserIn`'s job at user creation.
 *
 * @param {string} userID
 * @returns {ProactivePrefs}
 */
export function getProactivePrefs(userID) {
  const user = state.users[userID];
  const stored = user?.preferences?.proactive;
  if (stored) return normalizeProactivePrefs(stored, defaultProactivePrefs());
  return defaultProactivePrefs();
}

/**
 * Append a thought to the user's inbox. Always succeeds — appending is the
 * "having a thought" half; deciding whether to push is `shouldPush`.
 *
 * @param {string} userID
 * @param {{ category: ProactiveCategory, urgency?: Urgency, title: string, body: string, data?: Record<string, unknown> }} input
 * @returns {Thought}
 */
export function appendThought(userID, input) {
  const user = state.users[userID];
  if (!user) throw httpError(404, "user not found");
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw httpError(400, "thought must be an object");
  }
  if (!isCategory(input.category)) throw httpError(400, `unknown category: ${input.category}`);
  const title = sanitizePlainText(input.title, 240);
  const body = sanitizePlainText(input.body, 2000);
  if (!title || !body) throw httpError(400, "title and body are required");

  /** @type {Thought} */
  const thought = {
    id: `thought-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    userId: userID,
    category: input.category,
    urgency: isUrgency(input.urgency) ? input.urgency : "medium",
    title,
    body,
    data: normalizeThoughtData(input.data),
    createdAt: new Date().toISOString(),
    status: "new",
    pushed: false,
    pushedAt: null,
    feedback: null,
    feedbackAt: null,
    pushSuppressedReason: null,
  };

  user.proactiveInbox ||= [];
  user.proactiveInbox.unshift(thought);
  user.proactiveInbox = user.proactiveInbox.slice(0, INBOX_LIMIT);
  return thought;
}

/**
 * Read the user's inbox (newest first). Optional filters for status and
 * since-cursor.
 *
 * @param {string} userID
 * @param {{ status?: Thought['status'], limit?: number, since?: string }} [opts]
 * @returns {Thought[]}
 */
export function listThoughts(userID, opts = {}) {
  const list = /** @type {Thought[]} */ (state.users[userID]?.proactiveInbox || []);
  const options = opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
  const requestedLimit = Number(options.limit);
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.min(INBOX_LIMIT, Math.max(1, requestedLimit))
    : 50;
  /** @type {Thought[]} */
  let out = list;
  if (options.status) out = out.filter((t) => t.status === options.status);
  if (options.since) {
    const cutoff = Date.parse(options.since);
    if (!Number.isNaN(cutoff)) out = out.filter((t) => Date.parse(t.createdAt) > cutoff);
  }
  return out.slice(0, limit);
}

/**
 * Update a thought's status and/or feedback. Returns the updated thought, or
 * throws 404 if not found.
 *
 * @param {string} userID
 * @param {string} thoughtID
 * @param {{ status?: Thought['status'], feedback?: Thought['feedback'] }} patch
 */
export function markThought(userID, thoughtID, patch) {
  const list = /** @type {Thought[]} */ (state.users[userID]?.proactiveInbox || []);
  const thought = list.find((t) => t.id === thoughtID);
  if (!thought) throw httpError(404, "thought not found");
  const safePatch = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  if (safePatch.status && ["new", "seen", "dismissed", "acted_on"].includes(safePatch.status)) {
    thought.status = safePatch.status;
  }
  if (safePatch.feedback !== undefined) {
    if (safePatch.feedback === null) {
      thought.feedback = null;
      thought.feedbackAt = null;
    } else if (["helpful", "not_now", "never_again"].includes(safePatch.feedback)) {
      thought.feedback = safePatch.feedback;
      thought.feedbackAt = new Date().toISOString();
    }
  }
  return thought;
}

/**
 * The decision function. Pure: same inputs → same output. No I/O.
 *
 * Returns { allow, reason } so callers can log why a push was suppressed —
 * essential for debugging "why didn't I get notified?" support questions.
 *
 * @param {Object} args
 * @param {ProactivePrefs} args.prefs
 * @param {{ category: ProactiveCategory, urgency: Urgency }} args.thought
 * @param {string[]} args.recentPushTimestamps   ISO strings of pushes already sent today
 * @param {Date} args.now
 * @param {string} args.timezone               IANA tz name, e.g. "Africa/Douala"
 * @param {boolean} args.hasPushTokens
 * @returns {{ allow: boolean, reason: string }}
 */
export function shouldPush({ prefs, thought, recentPushTimestamps, now, timezone, hasPushTokens }) {
  if (!hasPushTokens) return { allow: false, reason: "no_push_tokens" };
  if (!prefs.enabled) return { allow: false, reason: "proactive_disabled" };

  const cat = prefs.categories[thought.category];
  if (!cat) return { allow: false, reason: `unknown_category:${thought.category}` };
  if (!cat.enabled) return { allow: false, reason: "category_disabled" };
  if (cat.deliveryMode === "silent") return { allow: false, reason: "category_silent" };

  if (URGENCY_RANK[thought.urgency] < URGENCY_RANK[cat.threshold]) {
    return { allow: false, reason: "below_threshold" };
  }

  const isCritical = thought.urgency === "critical";
  const override = isAvailableNowActive(prefs.availableNow, thought.category, now);

  if (!isCritical && !override) {
    if (inQuietHours(prefs.quietHoursStart, prefs.quietHoursEnd, now, timezone)) {
      return { allow: false, reason: "quiet_hours" };
    }
  }

  if (!isCritical) {
    const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
    const hourAgo = now.getTime() - 60 * 60 * 1000;
    let dayCount = 0;
    let hourCount = 0;
    for (const ts of recentPushTimestamps) {
      const t = Date.parse(ts);
      if (Number.isNaN(t)) continue;
      if (t > dayAgo) dayCount += 1;
      if (t > hourAgo) hourCount += 1;
    }
    if (dayCount >= prefs.maxPushesPerDay) return { allow: false, reason: "daily_cap" };
    if (hourCount >= prefs.maxPushesPerHour && !override) {
      return { allow: false, reason: "hourly_cap" };
    }
  }

  return { allow: true, reason: "ok" };
}

/**
 * Compose append + decide + push. The thought is always written to the
 * inbox; the push is only attempted if `shouldPush` allows. Returns the
 * stored thought plus the decision so callers can log it.
 *
 * @param {string} userID
 * @param {{ category: ProactiveCategory, urgency?: Urgency, title: string, body: string, data?: Record<string, unknown> }} input
 * @param {{ now?: Date }} [opts]
 */
export async function dispatchProactive(userID, input, opts = {}) {
  const user = state.users[userID];
  if (!user) throw httpError(404, "user not found");

  const now = opts.now || new Date();
  const thought = appendThought(userID, input);

  const prefs = getProactivePrefs(userID);
  const hasPushTokens = Array.isArray(user.pushTokens) && user.pushTokens.length > 0;
  const timezone = user.preferences?.timezone || "UTC";
  const recent = collectRecentPushes(user.proactiveInbox || [], now);

  const decision =
    user.preferences?.pushEnabled === false
      ? { allow: false, reason: "push_disabled" }
      : shouldPush({
          prefs,
          thought: { category: thought.category, urgency: thought.urgency },
          recentPushTimestamps: recent,
          now,
          timezone,
          hasPushTokens,
        });

  if (!decision.allow) {
    thought.pushSuppressedReason = decision.reason;
    await save();
    log.info({ userID, category: thought.category, reason: decision.reason }, "proactive suppressed");
    return { thought, decision };
  }

  const pushResult = await sendPushToUser(userID, {
    title: thought.title,
    body: thought.body,
    data: { ...thought.data, thoughtId: thought.id, category: thought.category },
  });

  thought.pushed = pushResult.sent > 0;
  thought.pushedAt = thought.pushed ? new Date().toISOString() : null;
  if (!thought.pushed) thought.pushSuppressedReason = "push_transport_failed";
  await save();
  log.info(
    { userID, category: thought.category, sent: pushResult.sent },
    thought.pushed ? "proactive pushed" : "proactive push transport returned 0",
  );
  return { thought, decision };
}

/**
 * Activate the "interrupt me" override for a bounded window. Categories
 * default to all known ones if omitted — we let the user say "anything" by
 * default, since this is the explicit-invitation path.
 *
 * @param {string} userID
 * @param {{ minutes?: number, categories?: ProactiveCategory[], reason?: string }} input
 */
export function setAvailableNow(userID, input) {
  const user = state.users[userID];
  if (!user) throw httpError(404, "user not found");
  const minutes = clampInt(input?.minutes, 5, 12 * 60, 120);
  const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  const categories = Array.isArray(input?.categories)
    ? input.categories.filter(isCategory)
    : [...PROACTIVE_CATEGORIES];
  const reason = sanitizePlainText(input?.reason, 120) || "user_invited";

  user.preferences ||= {};
  /** @type {ProactivePrefs} */
  const prefs = normalizeProactivePrefs(user.preferences.proactive, defaultProactivePrefs());
  prefs.availableNow = { until, categories, reason };
  user.preferences.proactive = prefs;
  return prefs.availableNow;
}

/**
 * @param {string} userID
 */
export function clearAvailableNow(userID) {
  const user = state.users[userID];
  if (!user?.preferences?.proactive) return;
  user.preferences.proactive.availableNow = null;
}

/**
 * @param {AvailableNow | null | undefined} window
 * @param {ProactiveCategory} category
 * @param {Date} now
 */
export function isAvailableNowActive(window, category, now) {
  if (!window) return false;
  const until = Date.parse(window.until);
  if (Number.isNaN(until) || until <= now.getTime()) return false;
  if (Array.isArray(window.categories) && window.categories.length && !window.categories.includes(category))
    return false;
  return true;
}

/**
 * Pull push timestamps from recent inbox entries so we can enforce daily /
 * hourly caps without a separate ledger.
 *
 * @param {Thought[]} inbox
 * @param {Date} now
 * @returns {string[]}
 */
function collectRecentPushes(inbox, now) {
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  /** @type {string[]} */
  const out = [];
  for (const t of Array.isArray(inbox) ? inbox : []) {
    if (!t.pushedAt) continue;
    const ts = Date.parse(t.pushedAt);
    if (Number.isNaN(ts) || ts < cutoff) continue;
    out.push(t.pushedAt);
  }
  return out;
}

/**
 * Check whether `now`, interpreted in the user's timezone, falls inside the
 * configured quiet window. Windows that cross midnight (e.g. 22:00 → 08:00)
 * are handled.
 *
 * @param {string} startHHMM
 * @param {string} endHHMM
 * @param {Date} now
 * @param {string} timezone
 */
export function inQuietHours(startHHMM, endHHMM, now, timezone) {
  if (!validHHMM(startHHMM) || !validHHMM(endHHMM)) return false;
  if (startHHMM === endHHMM) return false; // empty window
  const current = currentMinutesInZone(now, timezone);
  const start = hhmmToMinutes(startHHMM);
  const end = hhmmToMinutes(endHHMM);
  if (start < end) return current >= start && current < end;
  // wraps midnight
  return current >= start || current < end;
}

/**
 * @param {Date} now
 * @param {string} timezone
 * @returns {number} minutes since midnight in that zone
 */
function currentMinutesInZone(now, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value || 0);
    const m = Number(parts.find((p) => p.type === "minute")?.value || 0);
    // Intl returns "24" for midnight in some locales; normalize.
    const hour = h === 24 ? 0 : h;
    return hour * 60 + m;
  } catch {
    // Bad timezone string — fall back to server local time. Don't crash the
    // push pipeline on bad config.
    return now.getHours() * 60 + now.getMinutes();
  }
}

/** @param {string} hhmm */
function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function validHHMM(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampInt(value, min, max, fallback) {
  const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Normalize one category against a known-good fallback. Persisted preference
 * objects can predate the current schema or be partially corrupted.
 *
 * @param {unknown} value
 * @param {CategoryPrefs} fallback
 * @returns {CategoryPrefs}
 */
function normalizeCategoryPrefs(value, fallback) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const candidate = /** @type {Record<string, unknown>} */ (value);
  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : fallback.enabled,
    threshold: isUrgency(candidate.threshold) ? candidate.threshold : fallback.threshold,
    deliveryMode: isDeliveryMode(candidate.deliveryMode) ? candidate.deliveryMode : fallback.deliveryMode,
  };
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function normalizeThoughtData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const bounded = boundedJSONValue(value, MAX_THOUGHT_DATA_CHARS);
  // Reparse the bounded representation so getters, prototypes, and cyclic
  // references cannot survive into persistence or the push payload.
  try {
    const parsed = JSON.parse(JSON.stringify(bounded));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {unknown} value
 * @returns {value is ProactiveCategory}
 */
export function isCategory(value) {
  return typeof value === "string" && /** @type {readonly string[]} */ (PROACTIVE_CATEGORIES).includes(value);
}

/**
 * @param {unknown} value
 * @returns {value is Urgency}
 */
function isUrgency(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(URGENCY_RANK, value);
}

/**
 * @param {unknown} value
 * @returns {value is DeliveryMode}
 */
function isDeliveryMode(value) {
  return typeof value === "string" && /** @type {readonly string[]} */ (DELIVERY_MODES).includes(value);
}
