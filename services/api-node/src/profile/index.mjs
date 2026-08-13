/**
 * User profile module — the structured context the agent needs to score
 * email importance correctly. A client reply from a known investor
 * outranks an automated application confirmation only if the system
 * KNOWS the user is a founder fundraising.
 *
 * Stored on state.users[userID].profile as a small object. Free-form
 * text fields (role, industry, currentProjects, keyRelationships,
 * goals) keep the schema flexible — the LLM doesn't need rigid types.
 */
import { httpError } from "../http/responses.mjs";
import { state } from "../storage/index.mjs";

/**
 * @typedef {Object} UserProfile
 * @property {string} role                Job title / what they do
 * @property {string} industry
 * @property {string} currentProjects     Free-form: comma- or paragraph-separated active projects
 * @property {string} keyRelationships    Who matters: clients, investors, manager, etc.
 * @property {string} goals               What they're trying to accomplish right now
 * @property {string} communicationStyle  How they prefer to write replies (formal, terse, warm)
 */

/** @returns {UserProfile} */
export function emptyProfile() {
  return {
    role: "",
    industry: "",
    currentProjects: "",
    keyRelationships: "",
    goals: "",
    communicationStyle: "",
  };
}

/**
 * Read the user's profile, falling back to a clean empty record if
 * nothing's been set yet (so the UI always has fields to bind to).
 *
 * @param {string} userID
 * @returns {UserProfile}
 */
export function getProfile(userID) {
  const stored = state.users[userID]?.profile;
  if (!stored || typeof stored !== "object") return emptyProfile();
  return normalizeProfile(stored);
}

/**
 * Merge an incoming partial update over the current profile, clamping
 * each field to a sane length and stripping anything not in the schema.
 *
 * @param {string} userID
 * @param {Partial<UserProfile>} input
 * @returns {UserProfile}
 */
export function updateProfile(userID, input) {
  const user = state.users[userID];
  if (!user) throw httpError(404, "user not found");
  const current = getProfile(userID);
  const next = normalizeProfile({ ...current, ...(input || {}) });
  user.profile = next;
  return next;
}

/**
 * @param {Record<string, unknown>} input
 * @returns {UserProfile}
 */
export function normalizeProfile(input) {
  return {
    role: clampText(input.role, 200),
    industry: clampText(input.industry, 200),
    currentProjects: clampText(input.currentProjects, 1500),
    keyRelationships: clampText(input.keyRelationships, 1500),
    goals: clampText(input.goals, 1500),
    communicationStyle: clampText(input.communicationStyle, 500),
  };
}

/**
 * Returns true if the profile has any non-empty field. Used to decide
 * whether to include the profile block in LLM prompts (avoids feeding
 * an all-empty block that just wastes tokens).
 *
 * @param {UserProfile} profile
 */
export function hasProfile(profile) {
  return Object.values(profile).some((v) => typeof v === "string" && v.trim().length > 0);
}

/**
 * Render the profile as a compact text block to splice into an LLM
 * prompt. Only includes fields that the user has filled in.
 *
 * @param {UserProfile} profile
 */
export function profileBlock(profile) {
  const lines = [];
  if (profile.role) lines.push(`Role: ${profile.role}`);
  if (profile.industry) lines.push(`Industry: ${profile.industry}`);
  if (profile.goals) lines.push(`Goals: ${profile.goals}`);
  if (profile.currentProjects) lines.push(`Active projects: ${profile.currentProjects}`);
  if (profile.keyRelationships) lines.push(`Key relationships: ${profile.keyRelationships}`);
  if (profile.communicationStyle) lines.push(`Tone preference: ${profile.communicationStyle}`);
  return lines.join("\n");
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function clampText(value, max) {
  if (typeof value !== "string") return "";
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned.slice(0, max);
}
