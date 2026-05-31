import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.mjs";
import { emptyState, ensureUserIn, LOCAL_USER_ID } from "./state.mjs";

/**
 * Load state from the JSON file (created lazily on first save). Falls back to
 * an empty seeded state if the file is missing.
 *
 * @returns {Promise<import("./state.mjs").StateShape>}
 */
export async function loadFromJSON() {
  try {
    const raw = await readFile(config.statePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      users: parsed.users || {},
      briefings: parsed.briefings || {},
      audit: parsed.audit || {},
      deviceNotifications: parsed.deviceNotifications || {},
      sessions: parsed.sessions || {},
      oauthStates: parsed.oauthStates || {},
    };
  } catch {
    const seeded = emptyState();
    ensureUserIn(seeded, LOCAL_USER_ID);
    return seeded;
  }
}

/**
 * @param {import("./state.mjs").StateShape} state
 */
export async function saveToJSON(state) {
  await mkdir(path.dirname(config.statePath), { recursive: true });
  await writeFile(config.statePath, JSON.stringify(state, null, 2));
}
