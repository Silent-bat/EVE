/**
 * Typed client for the /v1/proactive/* endpoints.
 *
 * Thin wrappers around apiFetch so callers don't have to remember the URL
 * shape or hand-construct query strings. Each function takes plain inputs
 * and returns the typed response — error handling stays at the call site.
 */
import { apiFetch } from "../api/client";
import type {
  ProactiveAvailableNow,
  ProactiveCategoryName,
  ProactivePreferences,
  ProactiveThought,
  ProactiveThoughtFeedback,
  ProactiveThoughtStatus,
} from "../types";

export async function fetchProactivePrefs(): Promise<ProactivePreferences> {
  return apiFetch<ProactivePreferences>("/v1/proactive/preferences");
}

export async function updateProactivePrefs(
  patch: Partial<ProactivePreferences>,
): Promise<ProactivePreferences> {
  return apiFetch<ProactivePreferences>("/v1/proactive/preferences", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function fetchInbox(
  opts: { status?: ProactiveThoughtStatus; limit?: number; since?: string } = {},
): Promise<{ thoughts: ProactiveThought[] }> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.since) params.set("since", opts.since);
  const query = params.toString();
  return apiFetch<{ thoughts: ProactiveThought[] }>(`/v1/proactive/inbox${query ? `?${query}` : ""}`);
}

export async function markThought(
  id: string,
  patch: { status?: ProactiveThoughtStatus; feedback?: ProactiveThoughtFeedback },
): Promise<ProactiveThought> {
  return apiFetch<ProactiveThought>(`/v1/proactive/inbox/${encodeURIComponent(id)}/mark`, {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

export async function startAvailableNow(input: {
  minutes?: number;
  categories?: ProactiveCategoryName[];
  reason?: string;
}): Promise<ProactiveAvailableNow> {
  return apiFetch<ProactiveAvailableNow>("/v1/proactive/available-now", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function stopAvailableNow(): Promise<{ cleared: boolean }> {
  return apiFetch<{ cleared: boolean }>("/v1/proactive/available-now", {
    method: "DELETE",
  });
}
