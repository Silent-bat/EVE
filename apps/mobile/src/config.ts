import Constants from "expo-constants";

const DEFAULT_LAN_API_PORT = 8080;
const DEFAULT_GOOGLE_WEB_CLIENT_ID =
  "458142706595-u27hbqdaa4d9icnhv1gfm3ti3pfekf9h.apps.googleusercontent.com";
const DEFAULT_WEB_GOOGLE_RETURN_URL = "http://localhost:8081";

/**
 * Resolve the API base URL the app should talk to. Order of precedence:
 *
 *  1. `EXPO_PUBLIC_EVE_API_URL` (set at build time)
 *  2. Metro's debugger host (working dev server LAN IP)
 *  3. `http://127.0.0.1:8080` as a last resort (loopback/web)
 */
export function resolveAPIBaseURL(): string {
  if (process.env.EXPO_PUBLIC_EVE_API_URL) return process.env.EXPO_PUBLIC_EVE_API_URL;

  const manifestHostUri =
    Constants.expoConfig?.hostUri ||
    Constants.manifest2?.extra?.expoClient?.hostUri ||
    (Constants.manifest as { debuggerHost?: string } | null)?.debuggerHost;
  const host = typeof manifestHostUri === "string" ? manifestHostUri.split(":")[0] : "";
  if (host && host !== "localhost" && host !== "127.0.0.1") {
    return `http://${host}:${DEFAULT_LAN_API_PORT}`;
  }
  return `http://127.0.0.1:${DEFAULT_LAN_API_PORT}`;
}

export const config = Object.freeze({
  apiBaseURL: resolveAPIBaseURL(),
  isExpoGo: Constants.appOwnership === "expo",
  auth: {
    storageKey: "eve.authToken",
    bootTimeoutMs: 3000,
    apiTimeoutMs: 25000,
  },
  google: {
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || DEFAULT_GOOGLE_WEB_CLIENT_ID,
    webReturnUrl: process.env.EXPO_PUBLIC_GOOGLE_WEB_RETURN_URL || DEFAULT_WEB_GOOGLE_RETURN_URL,
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.readonly",
    ],
  },
  localUserId: "local-user",
  preferences: {
    defaultBriefingTime: "08:00",
    defaultTimezone: "Africa/Douala",
  },
});

export type EveConfig = typeof config;
