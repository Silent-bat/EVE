/**
 * Pure formatting helpers used across screens. No React, no state.
 */

export function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function describeAction(name: string): string {
  switch (name) {
    case "generate_briefing":
      return "Briefing refreshed";
    case "approve_draft":
      return "Draft approved";
    case "reject_draft":
      return "Draft rejected";
    case "update_preferences":
      return "Preferences updated";
    case "refresh_gmail":
      return "Gmail pulled";
    case "remember":
      return "Memory saved";
    case "forget":
      return "Memory removed";
    default:
      return name.replace(/_/g, " ");
  }
}

export function initials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Compact age of a timestamp: "now", "12m", "3h", "2d", then a date.
 *
 * Cards show this beside a subject line where there's room for a few characters
 * at most, so it stays short rather than reading as prose. Past two weeks the
 * exact age stops mattering and a date is more useful.
 */
export function relativeTime(value: string, now: number = Date.now()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const seconds = Math.round((now - date.getTime()) / 1000);
  // Clock skew between device and server can put a timestamp slightly ahead.
  // "in 4s" would be noise, so anything near-future reads as "now".
  if (seconds < 60) return "now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days <= 14) return `${days}d`;

  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Full date and time, for the one screen that shows a single item rather than a
 * list of them. `relativeTime` is right on a card, where "3h" is all that fits
 * and all that matters; on an open message the exact moment it arrived is part
 * of reading it.
 */
export function longDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Seconds as `m:ss`. For voice-message lengths. */export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Time range for a calendar event, collapsing the end time when it's on the
 * same day: "09:00 – 09:30".
 */
export function formatTimeRange(startsAt: string, endsAt: string): string {
  const start = formatTime(startsAt);
  const end = formatTime(endsAt);
  if (!start) return "";
  return end ? `${start} – ${end}` : start;
}

export function tokenFromURL(value: string): string {
  try {
    const url = new URL(value);
    return url.searchParams.get("eve_token") || "";
  } catch {
    const match = value.match(/[?&]eve_token=([^&]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  }
}
