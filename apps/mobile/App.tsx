/**
 * Top-level container. Owns state, side-effects, and handlers; renders
 * no UI directly — the screens and primitives live in src/. Keep this
 * file focused on coordination so it stays small.
 */
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Linking, Platform, ScrollView, StyleSheet, View } from "react-native";
// Android 15 / Expo SDK 54 draw the app edge to edge, and React Native's own
// SafeAreaView only insets on iOS — so on Android it silently does nothing and
// the header lands under the status bar. Everything that owns a full screen uses
// this one instead.
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { assertSecureTransport, config } from "./src/config";
import { apiFetch as apiFetchClient, ApiError, tokenStore } from "./src/api/client";
import { configureForegroundHandler, registerPushToken, unregisterPushToken } from "./src/notifications/push";
import {
  configureNotificationSync,
  clearNotificationSync,
  isNotificationAccessGranted,
  notificationAccessSupported,
  openNotificationAccessSettings,
  subscribeToDeviceNotifications,
  subscribeToNotificationPermission,
} from "./src/native/EveNotificationListener";
import type {
  AuditEntry,
  Briefing,
  BriefingEmail,
  BriefingRange,
  DeviceNotification,
  EmailStatus,
  Preferences,
  Session,
} from "./src/types";

import { AppErrorBoundary } from "./src/auth/AppErrorBoundary";
import { AuthScreen, type AuthMode } from "./src/auth/AuthScreen";
import { BootScreen } from "./src/onboarding/BootScreen";
import { OnboardingFlow } from "./src/onboarding/OnboardingFlow";
import { ReconnectScreen } from "./src/onboarding/ReconnectScreen";
import {
  clearOnboardingProgress,
  completeOnboarding,
  readOnboardingProgress,
} from "./src/onboarding/storage";
import {
  googleErrorCode,
  googleLoginReturnURL,
  loadNativeGoogleSignIn,
  nativeGoogleSignInSupported,
} from "./src/auth/googleSignIn";

import { ThemeProvider, useTheme, useThemedStyles, type ThemeValue } from "./src/ui/ThemeContext";
import { ErrorBanner } from "./src/ui/primitives";
import { FadeSlideIn } from "./src/ui/motion";
import { BottomNav, BOTTOM_NAV_CLEARANCE, type NavTab } from "./src/ui/components";
import { TodayScreen } from "./src/home/TodayScreen";
import { BriefingTab } from "./src/briefing/BriefingTab";
import { MailScreen } from "./src/briefing/MailScreen";
import { AuditTab } from "./src/audit/AuditTab";
import { useListenFromHomeEnabled } from "./src/settings/devicePrefs";
import { SettingsTab, type SettingsEntry } from "./src/settings/SettingsTab";
import { Sidebar, type SidebarDestination } from "./src/settings/Sidebar";
import { ChatScreen } from "./src/chat/ChatScreen";
import { clearAllChatHistory } from "./src/chat/history";
import { fetchInbox } from "./src/proactive/api";
import { VoiceScreen } from "./src/voice/VoiceScreen";
import { clearVoiceCache } from "./src/voice/cache";
import {
  clearAllCache,
  readCache,
  readLastUserID,
  rememberLastUserID,
  writeCache,
} from "./src/storage/localCache";

import { oauthCodeFromURL } from "./src/utils/formatters";
import {
  DEFAULT_PREFERENCES,
  EMPTY_BRIEFING,
  normalizeBriefing,
  normalizePreferences,
  normalizeSession,
} from "./src/utils/normalizers";

const API_BASE_URL = config.apiBaseURL;
const AUTH_BOOT_TIMEOUT_MS = config.auth.bootTimeoutMs;
const GOOGLE_WEB_CLIENT_ID = config.google.webClientId;
const GOOGLE_SCOPES = config.google.scopes;
// Native sign-in fails for a whole family of setup reasons that all look
// different (DEVELOPER_ERROR 10, SIGN_IN_FAILED 12500, missing Play
// Services 2) and none of which improve on retry. Rather than enumerate
// them, treat any native failure as a cue to try the browser — except the
// two that are intentional, where launching a browser would be wrong.
// The Android bridge reports codes as bare numbers, hence both spellings.
const GOOGLE_NATIVE_NO_FALLBACK_CODES = ["SIGN_IN_CANCELLED", "12501", "IN_PROGRESS", "12502"];

/**
 * The four destinations on the nav bar: Home, Briefing, Messages, Activity.
 * The raised centre button is voice, which is a mode rather than a place — you
 * enter it, say something, and come back out to wherever you were.
 *
 * Settings is deliberately not here. It left the bar for the avatar menu: it's
 * a place you visit occasionally, and giving it a permanent quarter of the
 * bar's width crowded out Messages, which you use every day.
 *
 * "Approve" is absent for the same class of reason. Draft approval happens in
 * the Needs Attention section of Home, where the decision sits next to the mail
 * that prompted it instead of in a queue you have to remember to visit.
 */
type Tab = "today" | "briefing" | "messages" | "audit";

const NAV_TABS: NavTab[] = [
  { key: "today", label: "Home", icon: "home-outline", iconActive: "home" },
  { key: "briefing", label: "Briefing", icon: "newspaper-outline", iconActive: "newspaper" },
  { key: "messages", label: "Messages", icon: "chatbubble-outline", iconActive: "chatbubble" },
  // Receipt rather than clock: Ionicons' filled `time` is a solid disc with the
  // hands knocked out, so the active Activity tab read as a badge next to three
  // line glyphs. `receipt` stays a glyph in both states, and it already labels
  // this screen's empty state.
  { key: "audit", label: "Activity", icon: "receipt-outline", iconActive: "receipt" },
];

/**
 * Where each sidebar row lands in settings. The drawer names things the way a
 * person would ("What EVE knows"); settings organises them by page. This is the
 * one place that mapping lives.
 */
const SIDEBAR_TO_SETTINGS: Record<SidebarDestination, SettingsEntry> = {
  settings: "index",
  account: "account",
  memory: "profile",
};

export default function App() {
  return (
    // Outermost, above the error boundary: the crash screen insets too, and it
    // would throw for want of a provider if this sat inside the boundary.
    <SafeAreaProvider>
      <AppErrorBoundary>
        <ThemeProvider>
          <EVEApp />
        </ThemeProvider>
      </AppErrorBoundary>
    </SafeAreaProvider>
  );
}

function EVEApp() {
  const { scheme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<Tab>("today");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /**
   * Which settings page is open, or null for none. Settings left the nav bar
   * for the avatar menu, so it is a layer over the current tab rather than a
   * fifth destination — and while it's open the nav bar hides, because on a
   * sub-page the back button is the navigation and a tab bar there offers to
   * abandon a page you're in the middle of.
   */
  const [settingsEntry, setSettingsEntry] = useState<SettingsEntry | null>(null);
  const [briefing, setBriefing] = useState<Briefing>(EMPTY_BRIEFING);
  const [briefingRange, setBriefingRange] = useState<BriefingRange>("day");
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [deviceNotifications, setDeviceNotifications] = useState<DeviceNotification[]>([]);
  const [notificationAccessEnabled, setNotificationAccessEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  // Tracks whether the initial loadV1() has completed at least once. After
  // that, background refreshes don't kick us back to the full-screen
  // BootScreen — they update in place. This prevents the "Getting your
  // workspace ready" flash every 30s when the interval-driven refresh fires.
  const [bootCompleted, setBootCompleted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [inboxNewCount, setInboxNewCount] = useState(0);
  const [voiceVisible, setVoiceVisible] = useState(false);
  /**
   * The mail being read, if any. Held here rather than per-tab because both
   * Home and Briefing open it and the modal has to outlive a tab switch — and
   * kept as the whole row, not an id, so the header renders before the body
   * lands.
   */
  const [openEmail, setOpenEmail] = useState<BriefingEmail | null>(null);
  // Device-local, like the theme: whether Home carries the ask dock. Off until
  // AsyncStorage says otherwise, so the default home screen leads with findings
  // rather than with an input box.
  const [listenFromHomeEnabled, setListenFromHomeEnabled] = useListenFromHomeEnabled();
  // null while we're still reading the stored onboarding record. Routing waits
  // on it rather than guessing, so a returning user never sees a flash of the
  // first-run flow they already finished.
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  // Refreshes can overlap (foreground resume, the 30s poll, and a manual
  // OAuth callback). A response that belongs to an older token must never
  // repopulate the UI after logout or a newer refresh has won the race.
  const loadRequestRef = useRef(0);

  const loadV1 = useCallback(async () => {
    const requestToken = authToken;
    const requestID = ++loadRequestRef.current;
    const isCurrent = () =>
      requestID === loadRequestRef.current && Boolean(requestToken) && tokenStore.current === requestToken;

    if (!requestToken) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setApiError(null);
    try {
      const [nextSession, nextBriefing, auditPayload, notificationsPayload, inboxPayload] = await Promise.all(
        [
          apiFetch<Session>("/v1/session"),
          apiFetch<Briefing>(`/v1/briefings/today?range=${briefingRange}`),
          apiFetch<{ entries: AuditEntry[] }>("/v1/audit"),
          apiFetch<{ entries: DeviceNotification[] }>("/v1/device-notifications"),
          fetchInbox({ status: "new", limit: 50 }).catch(() => ({ thoughts: [] })),
        ],
      );

      if (!isCurrent()) return;

      const safeSession = normalizeSession(nextSession);
      const safeBriefing = normalizeBriefing(nextBriefing);
      setSession(safeSession);
      setPreferences(safeSession.preferences);
      setBriefing(safeBriefing);
      const safeAudit = Array.isArray(auditPayload.entries) ? auditPayload.entries.slice().reverse() : [];
      setAudit(safeAudit);
      const safeDevice = Array.isArray(notificationsPayload.entries) ? notificationsPayload.entries : [];
      setDeviceNotifications(safeDevice);
      setInboxNewCount(inboxPayload.thoughts.length);

      // Write-back so the next cold start renders instantly.
      const userID = safeSession.userId;
      if (userID) {
        void rememberLastUserID(userID);
        void writeCache(userID, "briefing", safeBriefing);
        void writeCache(userID, "audit", safeAudit);
        void writeCache(userID, "preferences", safeSession.preferences);
        void writeCache(userID, "deviceNotifications", safeDevice);
        void writeCache(userID, "inboxNewCount", inboxPayload.thoughts.length);
      }
    } catch (error) {
      if (!isCurrent()) return;
      setApiError(error instanceof Error ? error.message : "API is unavailable");
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setBootCompleted(true);
      }
    }
  }, [authToken, briefingRange]);

  /**
   * Invalidate any refresh already in flight before a local mutation starts.
   * The mutation response owns the newest state; an older GET must not be
   * allowed to paint over it when its network request finally resolves.
   */
  const beginStateMutation = useCallback(() => {
    const requestID = ++loadRequestRef.current;
    const requestToken = authToken;
    return () =>
      requestID === loadRequestRef.current && Boolean(requestToken) && tokenStore.current === requestToken;
  }, [authToken]);

  const clearCapturedNotifications = useCallback(async () => {
    const isCurrent = beginStateMutation();
    try {
      await apiFetchClient<{ deleted: boolean }>("/v1/device-notifications", { method: "DELETE" });
      if (!isCurrent()) return;
      setDeviceNotifications([]);
      const userID = session?.userId;
      if (userID) void writeCache(userID, "deviceNotifications", []);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not clear captured notifications");
    }
  }, [beginStateMutation, session?.userId]);

  useEffect(() => {
    let active = true;
    const fallback = setTimeout(() => {
      if (!active) return;
      void tokenStore.clear();
      setAuthToken(null);
      setAuthChecked(true);
      setLoading(false);
      setApiError("Could not restore the stored session. Sign in again.");
    }, AUTH_BOOT_TIMEOUT_MS);

    void tokenStore
      .hydrate()
      .then((token) => {
        if (!active) return;
        setAuthToken(token);
      })
      .catch(() => {
        if (!active) return;
        setAuthToken(null);
        setApiError("Could not restore the stored session. Sign in again.");
      })
      .finally(() => {
        if (!active) return;
        clearTimeout(fallback);
        setAuthChecked(true);
      });

    return () => {
      active = false;
      clearTimeout(fallback);
    };
  }, []);

  useEffect(() => {
    if (authToken) {
      const tokenBeingStored = authToken;
      void tokenStore.set(tokenBeingStored).catch(() => {
        // A secure-store write failure must not become an unhandled promise
        // rejection or leave the UI believing this session will survive a
        // restart. Only clear if this is still the active token; a newer login
        // may have won while the platform write was pending.
        if (tokenStore.current !== tokenBeingStored) return;
        setApiError("Could not securely store the session. Sign in again.");
        setAuthToken(null);
        void tokenStore.clear().catch(() => undefined);
      });
    } else if (tokenStore.current) {
      void tokenStore.clear().catch(() => undefined);
    }
  }, [authToken]);

  // apiFetch drops the stored token when the server rejects it, which can
  // happen mid-session (an expired session outlives the app's own state).
  // Without this the store would be empty while React still believed it was
  // signed in, leaving the UI stuck on an error instead of the login screen.
  const hadTokenRef = useRef(false);
  // Settings renders sub-pages inside this scroller, so pushing one has to
  // bring the new page's header back into view.
  const scrollRef = useRef<ScrollView>(null);
  useEffect(
    () =>
      tokenStore.subscribe((token) => {
        setAuthToken(token);
        // Only explain the drop when we were actually signed in. Logout and
        // the boot-timeout path clear the token too, and both already set a
        // message that fits their situation better than this one.
        if (!token && hadTokenRef.current) {
          setApiError("Your session expired. Sign in again.");
        }
        hadTokenRef.current = Boolean(token);
      }),
    [],
  );

  // Hydrate cached briefing / audit / preferences / inbox before
  // loadV1 settles. Runs as soon as we have a token (we don't yet
  // know the userID, so we use the lastUserID anchor written at
  // login). loadV1 will overwrite with fresh server data on success;
  // until then the UI shows the user's previous-session view instead
  // of an empty workspace.
  useEffect(() => {
    if (!authToken) return;
    let active = true;
    void (async () => {
      const lastUserID = await readLastUserID();
      if (!lastUserID || !active) return;
      const [cachedBriefing, cachedAudit, cachedPrefs, cachedDevice, cachedInboxCount] = await Promise.all([
        readCache(lastUserID, "briefing"),
        readCache(lastUserID, "audit"),
        readCache(lastUserID, "preferences"),
        readCache(lastUserID, "deviceNotifications"),
        readCache(lastUserID, "inboxNewCount"),
      ]);
      if (!active) return;
      if (cachedBriefing) setBriefing(cachedBriefing);
      if (cachedAudit) setAudit(cachedAudit);
      if (cachedPrefs) setPreferences(cachedPrefs);
      if (cachedDevice) setDeviceNotifications(cachedDevice);
      if (typeof cachedInboxCount === "number") setInboxNewCount(cachedInboxCount);
    })();
    return () => {
      active = false;
    };
  }, [authToken]);

  // Decide whether this account still needs the guided first run. Waits for
  // bootCompleted because the answer depends on googleConnected, which only
  // arrives with the session.
  const googleConnected = Boolean(session?.googleConnected);
  const sessionUserID = session?.userId ?? null;
  useEffect(() => {
    if (!authToken) {
      setOnboardingDone(null);
      return;
    }
    if (!bootCompleted) return;
    let active = true;
    void (async () => {
      const stored = await readOnboardingProgress(sessionUserID);
      if (!active) return;
      if (stored?.completed) {
        setOnboardingDone(true);
        return;
      }
      // An account that is already connected but has no onboarding record
      // predates this flow. It has everything the flow would ask for, so mark
      // it done rather than walking a working install through a tour.
      if (!stored && googleConnected) {
        await completeOnboarding(sessionUserID);
        if (active) setOnboardingDone(true);
        return;
      }
      setOnboardingDone(false);
    })();
    return () => {
      active = false;
    };
  }, [authToken, bootCompleted, googleConnected, sessionUserID]);

  useEffect(() => {
    configureForegroundHandler();
  }, []);

  // Deliberately waits for onboarding to finish. registerPushToken raises the
  // OS permission dialog, and firing it the instant a token exists would drop
  // a bare system prompt on top of the welcome step — before the screen that
  // explains what the notification is for. During the first run the
  // personalize step owns that request; afterwards this keeps the stored token
  // fresh on every launch, since Expo can rotate it.
  useEffect(() => {
    if (!authToken || onboardingDone !== true) return;
    void registerPushToken();
  }, [authToken, onboardingDone]);

  useEffect(() => {
    if (authChecked) void loadV1();
  }, [authChecked, loadV1]);

  useEffect(() => {
    if (!nativeGoogleSignInSupported()) return;
    void loadNativeGoogleSignIn().then(({ GoogleSignin }) => {
      GoogleSignin.configure({
        webClientId: GOOGLE_WEB_CLIENT_ID,
        scopes: GOOGLE_SCOPES,
        // offlineAccess + forceCodeForRefreshToken make Google return a
        // serverAuthCode the backend can exchange for a refresh token.
        // Without this, the access token expires after 1h and the backend
        // can never renew it on its own — Gmail / Calendar silently 401.
        offlineAccess: true,
        forceCodeForRefreshToken: true,
      });
    });
  }, []);

  useEffect(() => {
    if (!authToken) return;
    const subscription = Linking.addEventListener("url", () => {
      void loadV1();
    });
    return () => subscription.remove();
  }, [authToken, loadV1]);

  useEffect(() => {
    if (!authToken) return;
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") void loadV1();
    });
    return () => subscription.remove();
  }, [authToken, loadV1]);

  useEffect(() => {
    if (!authToken) return;
    const interval = setInterval(() => {
      if (AppState.currentState === "active") void loadV1();
    }, 30_000);
    return () => clearInterval(interval);
  }, [authToken, loadV1]);

  useEffect(() => {
    if (!authToken || !notificationAccessSupported) return;
    const configureSync = () => {
      try {
        assertSecureTransport(API_BASE_URL);
        configureNotificationSync(API_BASE_URL, authToken);
      } catch (error) {
        setApiError(error instanceof Error ? error.message : "Secure API URL required");
      }
    };
    // The Android listener service continues running while the React app is
    // backgrounded. Keep its encrypted credentials in place; clearing them on
    // every inactive transition made background capture silently stop.
    configureSync();
    void isNotificationAccessGranted().then(setNotificationAccessEnabled);
    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") configureSync();
    });
    const unsubscribePermission = subscribeToNotificationPermission((event) => {
      setNotificationAccessEnabled(Boolean(event.enabled));
    });
    const unsubscribeNotifications = subscribeToDeviceNotifications((event) => {
      const postedAt =
        typeof event.postedAt === "number"
          ? new Date(event.postedAt).toISOString()
          : new Date().toISOString();
      const payload = {
        id: event.id,
        packageName: event.packageName,
        appName: event.appName,
        title: event.title,
        body: event.body,
        postedAt,
      };
      // The native listener owns the network write (including retries and
      // idempotency) so foreground JS and the Android service cannot upload the
      // same notification twice. This event only updates the visible list; the
      // next refresh reads the server-authoritative record.
      setDeviceNotifications((current) =>
        [payload as DeviceNotification, ...current.filter((item) => item.id !== payload.id)].slice(0, 30),
      );
    });
    return () => {
      unsubscribePermission();
      unsubscribeNotifications();
      appStateSubscription.remove();
      clearNotificationSync();
    };
  }, [authToken]);

  const pendingCount = useMemo(
    () => briefing.emails.filter((email) => email.status === "pending").length,
    [briefing.emails],
  );

  const finishGoogleLogin = useCallback(async (url: string) => {
    const code = oauthCodeFromURL(url);
    if (!code) return false;
    try {
      const result = await apiFetch<{ token: string; session: Session }>(
        "/v1/auth/google-exchange",
        { method: "POST", body: JSON.stringify({ code }) },
        null,
      );
      await tokenStore.set(result.token);
      const safeSession = normalizeSession(result.session);
      setAuthToken(result.token);
      setSession(safeSession);
      setPreferences(safeSession.preferences);
      setApiError(null);
      setLoading(true);
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Google login could not be completed");
      return false;
    }
  }, []);

  useEffect(() => {
    void Linking.getInitialURL().then((url) => {
      if (url) void finishGoogleLogin(url);
    });
  }, [finishGoogleLogin]);

  useEffect(() => {
    const subscription = Linking.addEventListener("url", (event) => {
      void finishGoogleLogin(event.url);
    });
    return () => subscription.remove();
  }, [finishGoogleLogin]);

  async function submitAuth({ email, password, mode }: { email: string; password: string; mode: AuthMode }) {
    setSaving(true);
    setApiError(null);
    try {
      const result = await apiFetch<{ token: string; session: Session }>(
        mode === "signup" ? "/v1/auth/signup" : "/v1/auth/login",
        { method: "POST", body: JSON.stringify({ email, password }) },
        null,
      );
      await tokenStore.set(result.token);
      setAuthToken(result.token);
      setSession(normalizeSession(result.session));
      setPreferences(normalizePreferences(result.session.preferences));
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Authentication failed");
    } finally {
      setSaving(false);
    }
  }

  // Hands the browser the consent URL and lets the `eve://` deep link
  // carry a one-use handoff code back. The bearer session token is exchanged
  // over the API instead of travelling through the URL.
  async function startGoogleWebLogin() {
    const returnTo = googleLoginReturnURL();
    const auth = await apiFetch<{ configured: boolean; url: string | null; reason?: string }>(
      `/v1/auth/google-url?returnTo=${encodeURIComponent(returnTo)}`,
      {},
      null,
    );
    if (!auth.configured || !auth.url) {
      throw new Error(auth.reason || "Google login is not configured");
    }
    await Linking.openURL(auth.url);
  }

  async function loginWithGoogle() {
    setSaving(true);
    setApiError(null);
    try {
      if (Platform.OS !== "web" && nativeGoogleSignInSupported()) {
        try {
          const { GoogleSignin, isCancelledResponse } = await loadNativeGoogleSignIn();
          await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
          const signIn = await GoogleSignin.signIn();
          if (isCancelledResponse(signIn)) {
            setSaving(false);
            return;
          }
          const tokens = await GoogleSignin.getTokens();
          if (!tokens.accessToken) throw new Error("Google login did not return an access token.");

          const result = await apiFetch<{ token: string; session: Session }>(
            "/v1/auth/google-native",
            {
              method: "POST",
              body: JSON.stringify({
                clientId: GOOGLE_WEB_CLIENT_ID,
                accessToken: tokens.accessToken,
                idToken: tokens.idToken || signIn.data.idToken || "",
                // serverAuthCode is what offlineAccess=true gives us. The
                // backend exchanges it for a refresh token so it can renew
                // the access token after expiry — otherwise Gmail / Calendar
                // 401 after an hour and the briefing goes empty.
                serverAuthCode: signIn.data.serverAuthCode || "",
                tokenType: "Bearer",
                expiresIn: 3600,
                scope: GOOGLE_SCOPES.join(" "),
              }),
            },
            null,
          );
          await tokenStore.set(result.token);
          const safeSession = normalizeSession(result.session);
          setAuthToken(result.token);
          setSession(safeSession);
          setPreferences(safeSession.preferences);
          return;
        } catch (nativeError) {
          if (GOOGLE_NATIVE_NO_FALLBACK_CODES.includes(googleErrorCode(nativeError))) {
            throw nativeError;
          }
          // Surfaced so a native misconfiguration stays diagnosable instead
          // of being hidden by the browser flow silently taking over.
          console.warn(
            `[eve] native Google sign-in failed (code ${googleErrorCode(nativeError) || "none"}), falling back to browser:`,
            nativeError,
          );
        }
      }

      await startGoogleWebLogin();
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not start Google login");
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    setSaving(true);
    // Invalidate any refresh that is still awaiting the old account's data.
    loadRequestRef.current += 1;
    // Remove this installation from push delivery while the bearer session is
    // still valid. The server logout route revokes that session, so doing this
    // afterward would leave the old account subscribed on a shared phone.
    await unregisterPushToken();
    clearNotificationSync();
    try {
      await apiFetch<{ ok: boolean }>("/v1/auth/logout", { method: "POST" });
    } catch {
      // best-effort
    }
    // Fully revoke the native Google account (not just signOut). Revoke
    // wipes both the local cache AND the OAuth grant on Google's side, so
    // the next "Continue with Gmail" tap re-runs full consent and the
    // backend gets a fresh serverAuthCode + refresh token. signOut alone
    // can leave a silent re-login pathway.
    if (nativeGoogleSignInSupported()) {
      try {
        const { GoogleSignin } = await loadNativeGoogleSignIn();
        try {
          await GoogleSignin.revokeAccess();
        } catch {
          // revokeAccess can fail if there is no current Google session;
          // fall back to a plain signOut so the cache is at least cleared.
          try {
            await GoogleSignin.signOut();
          } catch {
            /* best-effort */
          }
        }
      } catch {
        // best-effort
      }
    }
    // Wipe any cached voice audio (WAV files written by pcmToWav) so a
    // future user on the same device can't replay them from disk.
    try {
      await clearVoiceCache();
    } catch {
      // best-effort
    }
    // Wipe the AsyncStorage cache (briefing, audit, prefs, voice turns,
    // assistantAnswer, lastUserID anchor). Without this, the next user
    // to sign in on this device sees a flash of the previous user's data
    // before loadV1 settles.
    try {
      await clearAllCache();
    } catch {
      // best-effort
    }
    await clearAllChatHistory();
    // Drop the first-run record too. It is device-scoped, so leaving it behind
    // would hand the next account either a finished flow it never did or a
    // half-finished one belonging to somebody else.
    await clearOnboardingProgress();
    await tokenStore.clear();
    setAuthToken(null);
    setSession(null);
    setApiError(null);
    setSaving(false);
    setOnboardingDone(null);
    setBootCompleted(false); // next sign-in shows the BootScreen again
    setTab("today");
    // Bug fix: previously logout left briefing/audit/preferences/etc.
    // in state, so signing into a second account briefly showed the
    // previous user's data before loadV1 settled. Reset everything
    // user-scoped here so a fresh sign-in starts from a blank slate.
    setBriefing(EMPTY_BRIEFING);
    setAudit([]);
    setPreferences(DEFAULT_PREFERENCES);
    setDeviceNotifications([]);
    setInboxNewCount(0);
    setVoiceVisible(false);
  }

  async function connectGoogle() {
    setSaving(true);
    setApiError(null);
    try {
      const auth = await apiFetch<{ configured: boolean; url: string | null }>("/v1/google/auth-url");
      if (auth.configured && auth.url) {
        await Linking.openURL(auth.url);
        return;
      }
      throw new Error("Google OAuth is not configured on the API.");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not connect Google");
    } finally {
      setSaving(false);
    }
  }

  async function refreshBriefing() {
    const isCurrent = beginStateMutation();
    setSaving(true);
    setApiError(null);
    try {
      await apiFetch("/v1/gmail/poll", { method: "POST" });
      if (!isCurrent()) return;
      await loadV1();
      setTab("briefing");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not refresh");
    } finally {
      setSaving(false);
    }
  }

  async function recordAction(emailId: string, status: EmailStatus, draft?: string) {
    if (status === "pending") return;
    const isCurrent = beginStateMutation();
    setSaving(true);
    setApiError(null);
    try {
      const result = await apiFetch<{ briefing: Briefing; audit: AuditEntry }>(
        `/v1/drafts/${encodeURIComponent(emailId)}/action`,
        {
          method: "POST",
          body: JSON.stringify({
            action: status === "approved" ? "approve" : "reject",
            draftReply: draft,
          }),
        },
      );
      if (!isCurrent()) return;
      setBriefing(result.briefing);
      setAudit((current) => {
        const next = [result.audit, ...current];
        if (session?.userId) void writeCache(session.userId, "audit", next);
        return next;
      });
      if (session?.userId) void writeCache(session.userId, "briefing", result.briefing);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not update draft");
    } finally {
      setSaving(false);
    }
  }

  async function updatePreferences(nextPreferences: Preferences) {
    const isCurrent = beginStateMutation();
    setPreferences(nextPreferences);
    setApiError(null);
    try {
      const saved = await apiFetch<Preferences>("/v1/preferences", {
        method: "PUT",
        body: JSON.stringify(nextPreferences),
      });
      if (!isCurrent()) return;
      setPreferences(saved);
      if (session?.userId) void writeCache(session.userId, "preferences", saved);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not save preferences");
    }
  }

  // --- screen routing --------------------------------------------------

  // Show the full-screen boot only on the very first start — once the initial
  // loadV1 has completed (success OR explicit error), subsequent background
  // refreshes don't fall back to this screen.
  if (!authChecked || (loading && !bootCompleted && !apiError)) {
    return <BootScreen authChecked={authChecked} onResetSession={logout} />;
  }

  if (!authToken) {
    return (
      <AuthScreen
        onSubmit={submitAuth}
        onGoogle={loginWithGoogle}
        saving={saving}
        apiError={apiError}
        onDismissError={() => setApiError(null)}
      />
    );
  }

  // Signed in, but we haven't read the first-run record yet. Holding the boot
  // screen for this beat is what keeps a returning user from seeing the
  // welcome step flash before it resolves.
  if (onboardingDone === null) {
    return <BootScreen authChecked onResetSession={logout} />;
  }

  if (!onboardingDone) {
    return (
      <OnboardingFlow
        userId={sessionUserID}
        email={session?.email ?? null}
        googleConnected={googleConnected}
        preferences={preferences}
        saving={saving}
        apiError={apiError}
        onConnectGoogle={connectGoogle}
        onRetry={loadV1}
        onDismissError={() => setApiError(null)}
        onSavePreferences={(next) => void updatePreferences(next)}
        onDone={() => setOnboardingDone(true)}
        onSignOut={logout}
      />
    );
  }

  // Onboarded, but the Google grant has since lapsed. Every mail-backed screen
  // would be empty from here, so ask for the reconnection instead of showing an
  // app that quietly does nothing. The `!session` arm is the same condition —
  // no session means nothing to be connected with — and narrows `session` to
  // non-null for the main UI below.
  if (!session || !session.googleConnected) {
    return (
      <ReconnectScreen
        email={session?.email ?? null}
        saving={saving}
        apiError={apiError}
        onConnect={connectGoogle}
        onRetry={loadV1}
        onDismissError={() => setApiError(null)}
        onSignOut={logout}
      />
    );
  }

  // The bar is chrome for the four top-level destinations. A settings page
  // replaces them, so it takes the bar away with it.
  const navVisible = settingsEntry === null;

  const errorBanner = apiError ? (
    <ErrorBanner message={apiError} onDismiss={() => setApiError(null)} onRetry={loadV1} />
  ) : null;

  if (settingsEntry !== null) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        <ScrollView ref={scrollRef} contentContainerStyle={styles.content}>
          {errorBanner}
          <SettingsTab
            session={session}
            preferences={preferences}
            deviceNotifications={deviceNotifications}
            saving={saving}
            notificationAccessSupported={notificationAccessSupported}
            notificationAccessEnabled={notificationAccessEnabled}
            listenFromHomeEnabled={listenFromHomeEnabled}
            onChangeListenFromHome={setListenFromHomeEnabled}
            entry={settingsEntry}
            onExit={() => setSettingsEntry(null)}
            onLogout={logout}
            onAccountDeleted={() => {
              // The token died with the account, so there is nothing to log out
              // of — drop straight back to the sign-in screen.
              setSettingsEntry(null);
              void logout();
            }}
            // Account changes come back as a whole session because several of
            // them (the name, the Google flags) are read elsewhere in the app.
            // Preferences ride along inside it, so they are re-seated too.
            onSessionChange={(next) => {
              const safe = normalizeSession(next);
              setSession(safe);
              setPreferences(safe.preferences);
            }}
            onConnectGoogle={() => void connectGoogle()}
            onUpdatePreferences={updatePreferences}
            onChangeBriefingTime={(briefingTime) =>
              setPreferences((current) => ({ ...current, briefingTime }))
            }
            onOpenNotificationAccessSettings={openNotificationAccessSettings}
            onClearNotifications={clearCapturedNotifications}
            onError={setApiError}
            onNavigate={() => scrollRef.current?.scrollTo({ y: 0, animated: false })}
          />
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />

      {/* Messages owns its own scroller and keyboard handling, so it sits in
          the frame directly. Everything else shares the page scroller. */}
      {tab === "messages" ? (
        <View style={styles.flex}>
          {errorBanner}
          <ChatScreen userID={session.userId} />
        </View>
      ) : (
        <ScrollView ref={scrollRef} contentContainerStyle={styles.content}>
          {errorBanner}

          <FadeSlideIn key={tab}>
            {tab === "today" && (
              <TodayScreen
                briefing={briefing}
                email={session.email}
                name={session.displayName}
                photoURL={session.photoURL}
                saving={saving}
                askEnabled={listenFromHomeEnabled}
                voiceActive={voiceVisible}
                onEmailAction={(emailId, status) => void recordAction(emailId, status)}
                onOpenEmail={setOpenEmail}
                onOpenMenu={() => setSidebarOpen(true)}
                onOpenChat={() => setTab("messages")}
                onOpenVoice={() => setVoiceVisible(true)}
                onScrollTo={(y) => scrollRef.current?.scrollTo({ y, animated: true })}
                onError={setApiError}
              />
            )}

            {tab === "briefing" && (
              <BriefingTab
                briefing={briefing}
                pendingCount={pendingCount}
                saving={saving}
                range={briefingRange}
                onChangeRange={setBriefingRange}
                onRefresh={refreshBriefing}
                onOpenPending={() => setTab("today")}
                onOpenEmail={setOpenEmail}
                onError={setApiError}
              />
            )}

            {tab === "audit" && <AuditTab audit={audit} />}
          </FadeSlideIn>
        </ScrollView>
      )}

      {navVisible ? (
        <BottomNav
          tabs={NAV_TABS.map((item) =>
            item.key === "today" && inboxNewCount > 0 ? { ...item, badge: true } : item,
          )}
          active={tab}
          onSelect={(key) => setTab(key as Tab)}
          onPressEve={() => setVoiceVisible(true)}
          eveLabel="Talk to EVE"
        />
      ) : null}

      <Sidebar
        visible={sidebarOpen}
        name={session.displayName}
        email={session.email}
        photoURL={session.photoURL}
        onClose={() => setSidebarOpen(false)}
        onNavigate={(destination) => {
          setSidebarOpen(false);
          setSettingsEntry(SIDEBAR_TO_SETTINGS[destination]);
        }}
        onSignOut={() => {
          setSidebarOpen(false);
          void logout();
        }}
      />

      {/* Read from the briefing rather than from the captured row, so approving
          from inside the message updates the message you are still looking at. */}
      <MailScreen
        email={openEmail ? (briefing.emails.find((item) => item.id === openEmail.id) ?? openEmail) : null}
        visible={openEmail !== null}
        saving={saving}
        onAction={(emailId, status) => void recordAction(emailId, status)}
        onClose={() => setOpenEmail(null)}
      />

      <VoiceScreen visible={voiceVisible} onClose={() => setVoiceVisible(false)} />
    </SafeAreaView>
  );
}

// Light wrapper around the shared apiFetch that adds a friendlier timeout
// message — physical phones using localhost are the #1 source of timeouts.
async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  token: string | null = tokenStore.current,
): Promise<T> {
  try {
    return await apiFetchClient<T>(path, init, token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 0) {
      throw new Error(`API timed out at ${API_BASE_URL}. Use your computer LAN URL on a physical phone.`);
    }
    throw error;
  }
}

function makeStyles({ palette }: ThemeValue) {
  return StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: palette.background,
    },
    content: {
      padding: 18,
      // Clears the floating nav bar, which sits above this ScrollView rather
      // than inside it — without the pad, the last card hides behind it.
      paddingBottom: BOTTOM_NAV_CLEARANCE,
    },
    // Messages fills the frame instead of scrolling with the page: it owns a
    // scroller and a keyboard-avoiding composer, neither of which survives
    // being nested inside another ScrollView.
    flex: { flex: 1 },
  });
}
