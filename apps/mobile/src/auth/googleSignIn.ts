/**
 * Probes and lazy-loads the native Google Sign-In module. In Expo Go (or
 * on web) we don't even try — we'd just blow up on a missing native
 * dependency. The probe runs once and the result is cached.
 */
import { NativeModules, Platform } from "react-native";
import { config } from "../config";

const IS_EXPO_GO = config.isExpoGo;
const WEB_GOOGLE_RETURN_URL = config.google.webReturnUrl;
const EXPLICIT_WEB_GOOGLE_RETURN_URL = process.env.EXPO_PUBLIC_GOOGLE_WEB_RETURN_URL?.trim();

let cachedGoogleSignInModule: typeof import("@react-native-google-signin/google-signin") | null = null;
let googleSignInProbed = false;
let googleSignInAvailable = false;

function probeNativeGoogleSignIn(): boolean {
  if (googleSignInProbed) return googleSignInAvailable;
  googleSignInProbed = true;
  if (Platform.OS === "web" || IS_EXPO_GO) {
    googleSignInAvailable = false;
    return false;
  }
  const turboProxy = (globalThis as { __turboModuleProxy?: (name: string) => unknown }).__turboModuleProxy;
  const turboModule = typeof turboProxy === "function" ? turboProxy("RNGoogleSignin") : null;
  const legacyModule = (NativeModules as Record<string, unknown>).RNGoogleSignin;
  if (!turboModule && !legacyModule) {
    googleSignInAvailable = false;
    return false;
  }
  try {
    cachedGoogleSignInModule = require("@react-native-google-signin/google-signin");
    googleSignInAvailable = true;
  } catch {
    googleSignInAvailable = false;
  }
  return googleSignInAvailable;
}

export function nativeGoogleSignInSupported(): boolean {
  return probeNativeGoogleSignIn();
}

export async function loadNativeGoogleSignIn(): Promise<
  typeof import("@react-native-google-signin/google-signin")
> {
  if (!probeNativeGoogleSignIn() || !cachedGoogleSignInModule) {
    throw new Error("Gmail login requires a development build with the Google Sign-In native module.");
  }
  return cachedGoogleSignInModule;
}

export function googleErrorCode(error: unknown): string {
  if (typeof error === "object" && error && "code" in error) return String(error.code);
  return "";
}

export function googleLoginReturnURL(): string {
  if (Platform.OS === "web") {
    // React Native Web can be served as either localhost or 127.0.0.1 (and
    // Expo LAN mode can use another host). Keep the OAuth origin identical to
    // the page that started the flow; WebBrowser and the callback allowlist
    // both compare origins exactly. An explicit build-time URL still wins for
    // deployments that use a dedicated callback route.
    if (EXPLICIT_WEB_GOOGLE_RETURN_URL) return WEB_GOOGLE_RETURN_URL;
    const browserLocation = (
      globalThis as typeof globalThis & {
        location?: { origin?: string; pathname?: string };
      }
    ).location;
    if (browserLocation?.origin) {
      return `${browserLocation.origin}${browserLocation.pathname || "/"}`;
    }
    return WEB_GOOGLE_RETURN_URL;
  }
  return "eve://auth/google";
}
