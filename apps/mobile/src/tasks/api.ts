/**
 * Typed client for /v1/tasks.
 *
 * The endpoint isn't live yet — the backend has no tasks route, so every call
 * here currently rejects with an `ApiError` carrying status 404. That's
 * deliberate rather than a gap to work around: `ErrorState` in the component
 * system reads a 404 as "not switched on yet" and says so, which keeps the
 * screen honest instead of inventing rows. When the route lands, the UI fills
 * in with no change to this file.
 */
import { apiFetch } from "../api/client";
import type { Task, TaskPriority, TaskStatus } from "../types";

export async function fetchTasks(
  opts: { status?: TaskStatus; limit?: number } = {},
): Promise<{ tasks: Task[] }> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.limit) params.set("limit", String(opts.limit));
  const query = params.toString();
  return apiFetch<{ tasks: Task[] }>(`/v1/tasks${query ? `?${query}` : ""}`);
}

export async function createTask(input: {
  title: string;
  notes?: string;
  priority?: TaskPriority;
  dueAt?: string | null;
}): Promise<Task> {
  return apiFetch<Task>("/v1/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateTask(
  id: string,
  patch: Partial<Pick<Task, "title" | "notes" | "status" | "priority" | "dueAt">>,
): Promise<Task> {
  return apiFetch<Task>(`/v1/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** Convenience over `updateTask` — the only status change the UI ever makes. */
export async function setTaskDone(id: string, done: boolean): Promise<Task> {
  return updateTask(id, { status: done ? "done" : "open" });
}

export async function deleteTask(id: string): Promise<{ deleted: boolean }> {
  return apiFetch<{ deleted: boolean }>(`/v1/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
