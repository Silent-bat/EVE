/**
 * Typed client for /v1/profile. The profile is the structured "who you
 * are" context — role, industry, projects, key relationships, goals,
 * tone preference — that the backend splices into the email-ranking
 * prompt so a client reply outranks a generic confirmation.
 */
import { apiFetch } from "../api/client";
import type { UserProfile } from "../types";

export async function fetchProfile(): Promise<UserProfile> {
  return apiFetch<UserProfile>("/v1/profile");
}

export async function saveProfile(patch: Partial<UserProfile>): Promise<UserProfile> {
  return apiFetch<UserProfile>("/v1/profile", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}
