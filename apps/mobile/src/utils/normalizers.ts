/**
 * Defensive normalizers that coerce server payloads into the shapes the UI
 * expects. Keeps screen components free of optional-chain noise.
 */
import { config } from "../config";
import type { Briefing, Preferences, Session } from "../types";

const LOCAL_USER_ID = config.localUserId;

export const DEFAULT_PREFERENCES: Preferences = {
  userId: LOCAL_USER_ID,
  briefingTime: config.preferences.defaultBriefingTime,
  pushEnabled: true,
  timezone: config.preferences.defaultTimezone,
};

export const EMPTY_BRIEFING: Briefing = {
  id: "briefing-empty",
  userId: LOCAL_USER_ID,
  generatedAt: new Date(0).toISOString(),
  stats: {
    priorityEmails: 0,
    meetingsToday: 0,
    approvedReplies: 0,
  },
  emails: [],
  calendar: [],
};

export function normalizePreferences(input: Partial<Preferences> | null | undefined): Preferences {
  return {
    ...DEFAULT_PREFERENCES,
    ...(input || {}),
    userId: input?.userId || DEFAULT_PREFERENCES.userId,
    briefingTime: input?.briefingTime || DEFAULT_PREFERENCES.briefingTime,
    pushEnabled:
      typeof input?.pushEnabled === "boolean" ? input.pushEnabled : DEFAULT_PREFERENCES.pushEnabled,
    timezone: input?.timezone || DEFAULT_PREFERENCES.timezone,
  };
}

export function normalizeSession(input: Session): Session {
  return {
    ...input,
    email: input.email || null,
    displayName: input.displayName || null,
    photoURL: input.photoURL || null,
    googleConnected: Boolean(input.googleConnected),
    connectionMode: input.connectionMode === "google" ? "google" : "none",
    integrationMode: input.integrationMode || {
      google: "not-configured",
      llm: "local",
      emailSending: "audit-only",
    },
    preferences: normalizePreferences(input.preferences),
  };
}

export function normalizeBriefing(input: Briefing): Briefing {
  return {
    ...EMPTY_BRIEFING,
    ...input,
    stats: {
      ...EMPTY_BRIEFING.stats,
      ...(input.stats || {}),
    },
    emails: Array.isArray(input.emails) ? input.emails : [],
    calendar: Array.isArray(input.calendar) ? input.calendar : [],
  };
}
