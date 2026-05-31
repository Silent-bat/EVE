import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import { Component, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  AppState,
  Linking,
  NativeModules,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  configureNotificationSync,
  isNotificationAccessGranted,
  notificationAccessSupported,
  openNotificationAccessSettings,
  subscribeToDeviceNotifications,
  subscribeToNotificationPermission,
} from "./src/native/EveNotificationListener";
import type {
  AssistantAnswer,
  AuditEntry,
  Briefing,
  BriefingEmail,
  DeviceNotification,
  EmailStatus,
  Preferences,
  Session,
} from "./src/types";

type Tab = "briefing" | "approvals" | "audit" | "settings";
type Tone = "green" | "coral" | "neutral";
type AuthMode = "login" | "signup";

const API_BASE_URL = resolveAPIBaseURL();
const IS_EXPO_GO = Constants.appOwnership === "expo";
const LOCAL_USER_ID = "local-user";
const AUTH_TOKEN_KEY = "eve.authToken";
const AUTH_BOOT_TIMEOUT_MS = 3000;
const API_TIMEOUT_MS = 8000;
const WEB_GOOGLE_RETURN_URL = "http://localhost:8081";
const GOOGLE_WEB_CLIENT_ID = "458142706595-u27hbqdaa4d9icnhv1gfm3ti3pfekf9h.apps.googleusercontent.com";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
];
const DEFAULT_PREFERENCES: Preferences = {
  userId: LOCAL_USER_ID,
  briefingTime: "08:00",
  pushEnabled: true,
  timezone: "Africa/Douala",
};
const EMPTY_BRIEFING: Briefing = {
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

let currentAuthToken: string | null = null;

function resolveAPIBaseURL() {
  if (process.env.EXPO_PUBLIC_EVE_API_URL) return process.env.EXPO_PUBLIC_EVE_API_URL;

  const debuggerHost =
    Constants.expoConfig?.hostUri ||
    Constants.manifest2?.extra?.expoClient?.hostUri ||
    (Constants.manifest as { debuggerHost?: string } | null)?.debuggerHost;
  const host = typeof debuggerHost === "string" ? debuggerHost.split(":")[0] : "";
  if (host && host !== "localhost" && host !== "127.0.0.1") {
    return `http://${host}:8080`;
  }

  return "http://127.0.0.1:8080";
}

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.connectScreen}>
          <View style={styles.mark}>
            <Text style={styles.markText}>E</Text>
          </View>
          <Text style={styles.connectTitle}>EVE hit an app error.</Text>
          <Text style={styles.connectCopy}>{this.state.error.message || "Reload the app and try again."}</Text>
          <Text style={styles.debugText}>API: {API_BASE_URL}</Text>
        </View>
      </SafeAreaView>
    );
  }
}

export default function App() {
  return (
    <AppErrorBoundary>
      <EVEApp />
    </AppErrorBoundary>
  );
}

function EVEApp() {
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<Tab>("briefing");
  const [briefing, setBriefing] = useState<Briefing>(EMPTY_BRIEFING);
  const [selectedEmailId, setSelectedEmailId] = useState<string | undefined>(undefined);
  const [editingEmailId, setEditingEmailId] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [assistantPrompt, setAssistantPrompt] = useState("");
  const [assistantAnswer, setAssistantAnswer] = useState<AssistantAnswer | null>(null);
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [deviceNotifications, setDeviceNotifications] = useState<DeviceNotification[]>([]);
  const [notificationAccessEnabled, setNotificationAccessEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const loadV1 = useCallback(async () => {
    if (!authToken) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setApiError(null);
    try {
      const [nextSession, nextBriefing, auditPayload, notificationsPayload] = await Promise.all([
        apiFetch<Session>("/v1/session"),
        apiFetch<Briefing>("/v1/briefings/today"),
        apiFetch<{ entries: AuditEntry[] }>("/v1/audit"),
        apiFetch<{ entries: DeviceNotification[] }>("/v1/device-notifications"),
      ]);

      const safeSession = normalizeSession(nextSession);
      const safeBriefing = normalizeBriefing(nextBriefing);
      setSession(safeSession);
      setPreferences(safeSession.preferences);
      setBriefing(safeBriefing);
      setSelectedEmailId(safeBriefing.emails[0]?.id);
      setAudit(Array.isArray(auditPayload.entries) ? auditPayload.entries.slice().reverse() : []);
      setDeviceNotifications(Array.isArray(notificationsPayload.entries) ? notificationsPayload.entries : []);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "API is unavailable");
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    let active = true;
    const fallback = setTimeout(() => {
      if (!active) return;
      currentAuthToken = null;
      setAuthToken(null);
      setAuthChecked(true);
      setLoading(false);
      setApiError("Could not restore the stored session. Sign in again.");
    }, AUTH_BOOT_TIMEOUT_MS);

    void AsyncStorage.getItem(AUTH_TOKEN_KEY)
      .then((token) => {
        if (!active) return;
        currentAuthToken = token;
        setAuthToken(token);
      })
      .catch(() => {
        if (!active) return;
        currentAuthToken = null;
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
    currentAuthToken = authToken;
  }, [authToken]);

  useEffect(() => {
    if (authChecked) void loadV1();
  }, [authChecked, loadV1]);

  useEffect(() => {
    if (!nativeGoogleSignInSupported()) return;
    void loadNativeGoogleSignIn().then(({ GoogleSignin }) => {
      GoogleSignin.configure({
        webClientId: GOOGLE_WEB_CLIENT_ID,
        scopes: GOOGLE_SCOPES,
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
    if (!authToken || !notificationAccessSupported) return;

    configureNotificationSync(API_BASE_URL, authToken);
    void isNotificationAccessGranted().then(setNotificationAccessEnabled);
    const unsubscribePermission = subscribeToNotificationPermission((event) => {
      setNotificationAccessEnabled(Boolean(event.enabled));
    });
    const unsubscribeNotifications = subscribeToDeviceNotifications((event) => {
      const postedAt = typeof event.postedAt === "number" ? new Date(event.postedAt).toISOString() : new Date().toISOString();
      const payload = {
        id: event.id,
        packageName: event.packageName,
        appName: event.appName,
        title: event.title,
        body: event.body,
        postedAt,
      };

      void apiFetch<DeviceNotification>("/v1/device-notifications", {
        method: "POST",
        body: JSON.stringify(payload),
      })
        .then((saved) => setDeviceNotifications((current) => [saved, ...current.filter((item) => item.id !== saved.id)].slice(0, 30)))
        .catch((error) => setApiError(error instanceof Error ? error.message : "Could not sync notification"));
    });

    return () => {
      unsubscribePermission();
      unsubscribeNotifications();
    };
  }, [authToken]);

  const pendingCount = useMemo(
    () => briefing.emails.filter((email) => email.status === "pending").length,
    [briefing.emails],
  );

  const selectedEmail =
    briefing.emails.find((email) => email.id === selectedEmailId) ?? briefing.emails[0];

  const finishGoogleLogin = useCallback(
    async (url: string) => {
      const token = tokenFromURL(url);
      if (!token) return false;

      currentAuthToken = token;
      await AsyncStorage.setItem(AUTH_TOKEN_KEY, token);
      setAuthToken(token);
      setApiError(null);
      setLoading(true);
      return true;
    },
    [],
  );

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

  async function submitAuth() {
    setSaving(true);
    setApiError(null);
    try {
      const result = await apiFetch<{ token: string; session: Session }>(
        authMode === "signup" ? "/v1/auth/signup" : "/v1/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ email, password }),
        },
        null,
      );
      currentAuthToken = result.token;
      await AsyncStorage.setItem(AUTH_TOKEN_KEY, result.token);
      setAuthToken(result.token);
      setSession(normalizeSession(result.session));
      setPreferences(normalizePreferences(result.session.preferences));
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Authentication failed");
    } finally {
      setSaving(false);
    }
  }

  async function loginWithGoogle() {
    setSaving(true);
    setApiError(null);
    try {
      if (Platform.OS !== "web") {
        if (!nativeGoogleSignInSupported()) {
          throw new Error("Gmail login requires the EVE development build. Use email/password in Expo Go.");
        }
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
              tokenType: "Bearer",
              expiresIn: 3600,
              scope: GOOGLE_SCOPES.join(" "),
            }),
          },
          null,
        );
        currentAuthToken = result.token;
        await AsyncStorage.setItem(AUTH_TOKEN_KEY, result.token);
        const safeSession = normalizeSession(result.session);
        setAuthToken(result.token);
        setSession(safeSession);
        setPreferences(safeSession.preferences);
        return;
      }

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
    } catch (error) {
      if (googleErrorCode(error) === "PLAY_SERVICES_NOT_AVAILABLE") {
        setApiError("Google Play Services is not available or needs an update.");
      } else {
        setApiError(error instanceof Error ? error.message : "Could not start Google login");
      }
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    setSaving(true);
    try {
      await apiFetch<{ ok: boolean }>("/v1/auth/logout", { method: "POST" });
    } catch {
    } finally {
      currentAuthToken = null;
      await AsyncStorage.removeItem(AUTH_TOKEN_KEY);
      setAuthToken(null);
      setSession(null);
      setApiError(null);
      setSaving(false);
      setTab("briefing");
    }
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
    setSaving(true);
    setApiError(null);
    try {
      const nextBriefing = await apiFetch<Briefing>("/v1/briefings/generate", { method: "POST" });
      setBriefing(nextBriefing);
      setSelectedEmailId(nextBriefing.emails[0]?.id);
      setTab("briefing");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not generate briefing");
    } finally {
      setSaving(false);
    }
  }

  async function askAssistant() {
    const prompt = assistantPrompt.trim();
    if (!prompt || assistantLoading) return;

    setAssistantLoading(true);
    setApiError(null);
    try {
      const answer = await apiFetch<AssistantAnswer>("/v1/assistant/ask", {
        method: "POST",
        body: JSON.stringify({ prompt }),
      });
      setAssistantAnswer(answer);
      setAssistantPrompt("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not ask EVE");
    } finally {
      setAssistantLoading(false);
    }
  }

  function beginEdit(email: BriefingEmail) {
    setSelectedEmailId(email.id);
    setEditingEmailId(email.id);
    setDraftValue(email.draftReply);
  }

  async function recordAction(emailId: string, status: EmailStatus, draft?: string) {
    if (status === "pending") return;

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

      setBriefing(result.briefing);
      setAudit((current) => [result.audit, ...current]);
      const nextPending = result.briefing.emails.find((item) => item.status === "pending");
      setSelectedEmailId(nextPending?.id ?? emailId);
      setEditingEmailId(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not update draft");
    } finally {
      setSaving(false);
    }
  }

  async function updatePreferences(nextPreferences: Preferences) {
    setPreferences(nextPreferences);
    setApiError(null);
    try {
      const saved = await apiFetch<Preferences>("/v1/preferences", {
        method: "PUT",
        body: JSON.stringify(nextPreferences),
      });
      setPreferences(saved);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not save preferences");
    }
  }

  if (!authChecked || (loading && !apiError)) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.connectScreen}>
          <View style={styles.mark}>
            <Text style={styles.markText}>E</Text>
          </View>
          <Text style={styles.connectTitle}>EVE</Text>
          <Text style={styles.connectCopy}>Loading your workspace.</Text>
          <Text style={styles.debugText}>API: {API_BASE_URL}</Text>
          {authChecked ? (
            <Pressable style={styles.quietFullButton} onPress={logout}>
              <Text style={styles.quietButtonText}>Reset session</Text>
            </Pressable>
          ) : null}
        </View>
      </SafeAreaView>
    );
  }

  if (!authToken) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={styles.connectScreen}>
          <View style={styles.mark}>
            <Text style={styles.markText}>E</Text>
          </View>
          <Text style={styles.connectTitle}>{authMode === "signup" ? "Create your EVE account." : "Welcome back to EVE."}</Text>
          <Text style={styles.connectCopy}>Sign in to sync your briefings, audit trail, and Android notification captures.</Text>

          <View style={styles.authSwitch}>
            <Pressable
              style={[styles.authSwitchButton, authMode === "signup" && styles.activeAuthSwitch]}
              onPress={() => setAuthMode("signup")}
            >
              <Text style={[styles.authSwitchText, authMode === "signup" && styles.activeAuthSwitchText]}>Sign up</Text>
            </Pressable>
            <Pressable
              style={[styles.authSwitchButton, authMode === "login" && styles.activeAuthSwitch]}
              onPress={() => setAuthMode("login")}
            >
              <Text style={[styles.authSwitchText, authMode === "login" && styles.activeAuthSwitchText]}>Log in</Text>
            </Pressable>
          </View>

          <TextInput
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            placeholder="Email"
            style={styles.authInput}
          />
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="Password"
            style={styles.authInput}
          />

          {apiError ? <Text style={styles.errorText}>{apiError}</Text> : null}

          <Pressable style={styles.primaryButton} onPress={submitAuth} disabled={saving}>
            <Ionicons name="arrow-forward" size={18} color="#fffdf8" />
            <Text style={styles.primaryButtonText}>{saving ? "Please wait" : authMode === "signup" ? "Create account" : "Log in"}</Text>
          </Pressable>

          <Pressable style={styles.googleButton} onPress={loginWithGoogle} disabled={saving}>
            <Ionicons name="logo-google" size={18} color="#20242a" />
            <Text style={styles.googleButtonText}>{saving ? "Please wait" : "Continue with Gmail"}</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (!session?.googleConnected) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.connectScreen}>
          <View style={styles.mark}>
            <Text style={styles.markText}>E</Text>
          </View>
          <Text style={styles.connectTitle}>Your morning brief, ready before work.</Text>
          <Text style={styles.connectCopy}>
            Connect Google to prepare priority emails, today's meetings, and drafted replies
            for approval.
          </Text>

          <Permission icon="mail-outline" title="Gmail" body="Read recent messages and prepare drafts." />
          <Permission
            icon="calendar-outline"
            title="Google Calendar"
            body="Rank urgent mail against today's events."
          />
          <Permission
            icon="shield-checkmark-outline"
            title="Human approval"
            body="No outgoing action happens without your tap."
          />

          {apiError ? <Text style={styles.errorText}>{apiError}</Text> : null}

          <Pressable style={styles.primaryButton} onPress={connectGoogle} disabled={saving || loading}>
            <Ionicons name="checkmark" size={18} color="#fffdf8" />
            <Text style={styles.primaryButtonText}>
              {loading ? "Loading" : saving ? "Connecting" : "Connect Google"}
            </Text>
          </Pressable>

          {apiError ? (
            <Pressable style={styles.quietFullButton} onPress={loadV1}>
              <Text style={styles.quietButtonText}>Retry API</Text>
            </Pressable>
          ) : null}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={styles.brandRow}>
            <View style={styles.smallMark}>
              <Text style={styles.smallMarkText}>E</Text>
            </View>
            <View>
              <Text style={styles.appName}>EVE</Text>
              <Text style={styles.headerMeta}>{session.email || "Account"} - briefing at {preferences.briefingTime}</Text>
            </View>
          </View>
          <View style={styles.pendingPill}>
            <View style={styles.dot} />
            <Text style={styles.pendingText}>{pendingCount} pending</Text>
          </View>
        </View>
        <View style={styles.tabs}>
          {(["briefing", "approvals", "audit", "settings"] as Tab[]).map((item) => (
            <Pressable
              key={item}
              style={[styles.tab, tab === item && styles.activeTab]}
              onPress={() => setTab(item)}
            >
              <Text style={[styles.tabText, tab === item && styles.activeTabText]}>
                {item === "approvals" ? "Approve" : titleCase(item)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {apiError ? <Text style={styles.errorText}>{apiError}</Text> : null}

        <View style={styles.promptPanel}>
          <TextInput
            value={assistantPrompt}
            onChangeText={setAssistantPrompt}
            placeholder="Ask EVE about your Gmail, meetings, or notifications"
            style={styles.promptInput}
            returnKeyType="send"
            onSubmitEditing={askAssistant}
          />
          <Pressable
            style={[styles.promptButton, (!assistantPrompt.trim() || assistantLoading) && styles.disabledButton]}
            onPress={askAssistant}
            disabled={!assistantPrompt.trim() || assistantLoading}
          >
            <Ionicons name={assistantLoading ? "hourglass-outline" : "send"} size={17} color="#fffdf8" />
          </Pressable>
        </View>

        {assistantAnswer ? (
          <View style={styles.answerPanel}>
            <View style={styles.answerHeader}>
              <Text style={styles.answerTitle}>EVE</Text>
              <Text style={styles.answerSource}>{assistantAnswer.source}</Text>
            </View>
            <Text style={styles.answerText}>{assistantAnswer.answer}</Text>
          </View>
        ) : null}

        {tab === "briefing" && (
          <>
            <View style={styles.metrics}>
              <Metric value={briefing.stats.priorityEmails} label="priority emails" />
              <Metric value={briefing.stats.meetingsToday} label="meetings today" />
              <Metric value={briefing.stats.approvedReplies} label="approved replies" />
            </View>

            <View style={styles.toolbar}>
              <SectionHeader title="Priority inbox" note={`${pendingCount} awaiting review`} />
              <Pressable style={styles.iconButton} onPress={refreshBriefing} disabled={saving}>
                <Ionicons name="refresh" size={18} color="#20242a" />
              </Pressable>
            </View>

            {briefing.emails.length === 0 ? (
              <Text style={styles.empty}>No Gmail messages found yet. Refresh after connecting Gmail.</Text>
            ) : (
              briefing.emails.map((email) => (
                <EmailCard key={email.id} email={email} selected={false} onPress={() => undefined} />
              ))
            )}

            <SectionHeader title="Calendar" note="Today" />
            {briefing.calendar.length === 0 ? (
              <Text style={styles.empty}>No calendar events found for today.</Text>
            ) : (
              briefing.calendar.map((event) => (
                <View key={event.id} style={styles.row}>
                  <Text style={styles.eventTime}>{formatTime(event.startsAt)}</Text>
                  <View style={styles.rowBody}>
                    <Text style={styles.rowTitle}>{event.title}</Text>
                    <Text style={styles.rowText}>{event.location}</Text>
                  </View>
                </View>
              ))
            )}
          </>
        )}

        {tab === "approvals" && selectedEmail && (
          <>
            <SectionHeader title="Reply approvals" note={`${pendingCount} remaining`} />
            {briefing.emails.map((email) => (
              <EmailCard
                key={email.id}
                email={email}
                selected={email.id === selectedEmail.id}
                onPress={() => {
                  setSelectedEmailId(email.id);
                  setEditingEmailId(null);
                }}
              />
            ))}

            <View style={styles.draftPanel}>
              <SectionHeader title="Draft reply" note={selectedEmail.senderName} />
              {editingEmailId === selectedEmail.id ? (
                <TextInput
                  multiline
                  value={draftValue}
                  onChangeText={setDraftValue}
                  style={styles.editor}
                />
              ) : (
                <Text style={styles.draftText}>{selectedEmail.draftReply}</Text>
              )}

              {selectedEmail.status === "pending" && editingEmailId !== selectedEmail.id && (
                <View style={styles.actionRow}>
                  <ActionButton
                    label="Approve"
                    icon="checkmark"
                    tone="green"
                    onPress={() => recordAction(selectedEmail.id, "approved")}
                  />
                  <ActionButton
                    label="Edit"
                    icon="create-outline"
                    tone="neutral"
                    onPress={() => beginEdit(selectedEmail)}
                  />
                  <ActionButton
                    label="Reject"
                    icon="close"
                    tone="coral"
                    onPress={() => recordAction(selectedEmail.id, "rejected")}
                  />
                </View>
              )}

              {selectedEmail.status === "pending" && editingEmailId === selectedEmail.id && (
                <View style={styles.actionRowTwo}>
                  <ActionButton
                    label="Save and approve"
                    icon="checkmark"
                    tone="green"
                    onPress={() => recordAction(selectedEmail.id, "approved", draftValue.trim())}
                  />
                  <ActionButton
                    label="Cancel"
                    icon="close"
                    tone="neutral"
                    onPress={() => setEditingEmailId(null)}
                  />
                </View>
              )}

              {selectedEmail.status !== "pending" ? (
                <Text style={styles.empty}>This reply is already {selectedEmail.status}.</Text>
              ) : null}
            </View>
          </>
        )}

        {tab === "approvals" && !selectedEmail ? (
          <>
            <SectionHeader title="Reply approvals" note="0 remaining" />
            <Text style={styles.empty}>No generated replies are waiting for approval.</Text>
          </>
        ) : null}

        {tab === "audit" && (
          <>
            <SectionHeader title="Audit log" note={`${audit.length} actions`} />
            {audit.length === 0 ? (
              <Text style={styles.empty}>No approved or rejected replies yet.</Text>
            ) : (
              audit.map((entry) => (
                <View key={entry.id} style={styles.row}>
                  <Text style={styles.auditTime}>{formatTime(entry.createdAt)}</Text>
                  <View style={styles.rowBody}>
                    <Text style={styles.rowTitle}>
                      {entry.action === "approve" ? "Approved reply" : "Rejected reply"}
                    </Text>
                    <Text style={styles.rowText}>{entry.subject}</Text>
                  </View>
                </View>
              ))
            )}
          </>
        )}

        {tab === "settings" && (
          <>
            <SectionHeader title="Preferences" note="Daily briefing" />
            <View style={styles.row}>
              <Ionicons name="person-circle-outline" size={22} color="#20242a" />
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>{session.email || "EVE account"}</Text>
                <Text style={styles.rowText}>Authenticated session is stored on this device.</Text>
              </View>
              <Pressable style={styles.inlineButton} onPress={logout} disabled={saving}>
                <Text style={styles.inlineButtonText}>Log out</Text>
              </Pressable>
            </View>
            <View style={styles.row}>
              <Ionicons name="time-outline" size={22} color="#20242a" />
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>Briefing time</Text>
                <TextInput
                  value={preferences.briefingTime}
                  onChangeText={(value) => setPreferences((current) => ({ ...current, briefingTime: value }))}
                  onEndEditing={() => updatePreferences(preferences)}
                  style={styles.timeInput}
                  keyboardType="numbers-and-punctuation"
                />
              </View>
            </View>
            <View style={styles.row}>
              <Ionicons name="notifications-outline" size={22} color="#20242a" />
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>Push notifications</Text>
                <Text style={styles.rowText}>Morning briefing and action receipts.</Text>
              </View>
              <Switch
                value={preferences.pushEnabled}
                onValueChange={(value) => updatePreferences({ ...preferences, pushEnabled: value })}
              />
            </View>
            <View style={styles.row}>
              <Ionicons name="phone-portrait-outline" size={22} color="#20242a" />
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>Android notification access</Text>
                <Text style={styles.rowText}>
                  {notificationAccessSupported
                    ? notificationAccessEnabled
                      ? "Enabled. New Android notifications will sync to EVE."
                      : "Open Android settings and enable EVE under Notification access."
                    : Platform.OS === "android"
                      ? "Requires a custom Android dev build, not Expo Go."
                      : "Only Android allows apps to read notifications from other apps."}
                </Text>
              </View>
              {notificationAccessSupported ? (
                <Pressable style={styles.inlineButton} onPress={openNotificationAccessSettings}>
                  <Text style={styles.inlineButtonText}>{notificationAccessEnabled ? "Settings" : "Enable"}</Text>
                </Pressable>
              ) : null}
            </View>

            <SectionHeader title="Captured notifications" note={`${deviceNotifications.length} synced`} />
            {deviceNotifications.length === 0 ? (
              <Text style={styles.empty}>No Android notifications captured yet.</Text>
            ) : (
              deviceNotifications.slice(0, 10).map((entry) => (
                <View key={entry.id} style={styles.row}>
                  <Text style={styles.auditTime}>{formatTime(entry.receivedAt)}</Text>
                  <View style={styles.rowBody}>
                    <Text style={styles.rowTitle}>{entry.title || entry.appName || entry.packageName}</Text>
                    <Text style={styles.rowText}>{entry.body || entry.packageName}</Text>
                  </View>
                </View>
              ))
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

async function apiFetch<T>(path: string, init: RequestInit = {}, token = currentAuthToken): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`API timed out at ${API_BASE_URL}. Use your computer LAN URL on a physical phone.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `API request failed: ${response.status}`);
  }
  return payload as T;
}

function Permission(props: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }) {
  return (
    <View style={styles.permission}>
      <Ionicons name={props.icon} size={22} color="#20242a" />
      <View style={styles.permissionText}>
        <Text style={styles.permissionTitle}>{props.title}</Text>
        <Text style={styles.permissionBody}>{props.body}</Text>
      </View>
    </View>
  );
}

function Metric(props: { value: number; label: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{props.value}</Text>
      <Text style={styles.metricLabel}>{props.label}</Text>
    </View>
  );
}

function SectionHeader(props: { title: string; note: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{props.title}</Text>
      <Text style={styles.sectionNote}>{props.note}</Text>
    </View>
  );
}

function EmailCard(props: { email: BriefingEmail; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.emailCard, props.selected && styles.selectedEmailCard]}
      onPress={props.onPress}
    >
      <View style={styles.emailTopline}>
        <View style={styles.senderRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(props.email.senderName)}</Text>
          </View>
          <View style={styles.senderText}>
            <Text style={styles.senderName}>{props.email.senderName}</Text>
            <Text style={styles.emailMeta}>
              {formatTime(props.email.receivedAt)} - {props.email.senderEmail}
            </Text>
          </View>
        </View>
        <View style={[styles.status, statusStyle(props.email.status)]}>
          <Text style={styles.statusText}>{props.email.status}</Text>
        </View>
      </View>
      <Text style={styles.emailSubject}>{props.email.subject}</Text>
      <Text style={styles.emailSummary}>{props.email.summary}</Text>
      <View style={styles.scoreRow}>
        <View style={styles.scoreTrack}>
          <View style={[styles.scoreFill, { width: `${props.email.urgencyScore}%` }]} />
        </View>
        <Text style={styles.scoreText}>{props.email.urgencyScore}</Text>
      </View>
      <Text style={styles.emailMeta}>{props.email.urgencyReason}</Text>
    </Pressable>
  );
}

function ActionButton(props: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  tone: Tone;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.actionButton, actionStyle(props.tone)]} onPress={props.onPress}>
      <Ionicons name={props.icon} size={17} color={actionTextColor(props.tone)} />
      <Text style={[styles.actionText, { color: actionTextColor(props.tone) }]}>{props.label}</Text>
    </Pressable>
  );
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function googleLoginReturnURL() {
  if (Platform.OS === "web") return WEB_GOOGLE_RETURN_URL;
  return "eve://auth/google";
}

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

function nativeGoogleSignInSupported() {
  return probeNativeGoogleSignIn();
}

async function loadNativeGoogleSignIn(): Promise<typeof import("@react-native-google-signin/google-signin")> {
  if (!probeNativeGoogleSignIn() || !cachedGoogleSignInModule) {
    throw new Error("Gmail login requires a development build with the Google Sign-In native module.");
  }
  return cachedGoogleSignInModule;
}

function googleErrorCode(error: unknown) {
  if (typeof error === "object" && error && "code" in error) return String(error.code);
  return "";
}

function tokenFromURL(value: string) {
  try {
    const url = new URL(value);
    return url.searchParams.get("eve_token") || "";
  } catch {
    const match = value.match(/[?&]eve_token=([^&]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  }
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function normalizePreferences(input: Partial<Preferences> | null | undefined): Preferences {
  return {
    ...DEFAULT_PREFERENCES,
    ...(input || {}),
    userId: input?.userId || DEFAULT_PREFERENCES.userId,
    briefingTime: input?.briefingTime || DEFAULT_PREFERENCES.briefingTime,
    pushEnabled: typeof input?.pushEnabled === "boolean" ? input.pushEnabled : DEFAULT_PREFERENCES.pushEnabled,
    timezone: input?.timezone || DEFAULT_PREFERENCES.timezone,
  };
}

function normalizeSession(input: Session): Session {
  return {
    ...input,
    email: input.email || null,
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

function normalizeBriefing(input: Briefing): Briefing {
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

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";

  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function statusStyle(status: EmailStatus) {
  if (status === "approved") return styles.approvedStatus;
  if (status === "rejected") return styles.rejectedStatus;
  return styles.pendingStatus;
}

function actionStyle(tone: Tone) {
  if (tone === "green") return styles.greenAction;
  if (tone === "coral") return styles.coralAction;
  return styles.neutralAction;
}

function actionTextColor(tone: Tone) {
  if (tone === "green") return "#0b6049";
  if (tone === "coral") return "#8b321f";
  return "#20242a";
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#fffdf8",
  },
  connectScreen: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    gap: 14,
  },
  mark: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#20242a",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  markText: {
    color: "#fffdf8",
    fontSize: 18,
    fontWeight: "800",
  },
  connectTitle: {
    color: "#20242a",
    fontSize: 34,
    lineHeight: 36,
    fontWeight: "800",
  },
  connectCopy: {
    color: "#676d73",
    fontSize: 15,
    lineHeight: 23,
    marginBottom: 16,
  },
  permission: {
    flexDirection: "row",
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: "#ded8ca",
  },
  permissionText: {
    flex: 1,
  },
  permissionTitle: {
    color: "#20242a",
    fontWeight: "800",
  },
  permissionBody: {
    color: "#676d73",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 2,
  },
  authSwitch: {
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: "#ebe7dc",
    flexDirection: "row",
    padding: 4,
    marginBottom: 4,
  },
  authSwitchButton: {
    flex: 1,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  activeAuthSwitch: {
    backgroundColor: "#20242a",
  },
  authSwitchText: {
    color: "#676d73",
    fontWeight: "800",
  },
  activeAuthSwitchText: {
    color: "#fffdf8",
  },
  authInput: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: "#ded8ca",
    borderRadius: 8,
    paddingHorizontal: 12,
    color: "#20242a",
    backgroundColor: "#fffdf8",
    fontWeight: "700",
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: 8,
    backgroundColor: "#20242a",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 16,
  },
  primaryButtonText: {
    color: "#fffdf8",
    fontWeight: "800",
  },
  disabledButton: {
    opacity: 0.5,
  },
  googleButton: {
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ded8ca",
    backgroundColor: "#fffdf8",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  googleButtonText: {
    color: "#20242a",
    fontWeight: "800",
  },
  quietFullButton: {
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: "#ebe7dc",
    alignItems: "center",
    justifyContent: "center",
  },
  quietButtonText: {
    color: "#20242a",
    fontWeight: "800",
  },
  errorText: {
    color: "#8b321f",
    backgroundColor: "#f7e4dd",
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
    lineHeight: 18,
  },
  debugText: {
    color: "#676d73",
    fontSize: 12,
    lineHeight: 17,
  },
  header: {
    backgroundColor: "#fffdf8",
    borderBottomWidth: 1,
    borderBottomColor: "#ded8ca",
  },
  headerRow: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  smallMark: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#20242a",
    alignItems: "center",
    justifyContent: "center",
  },
  smallMarkText: {
    color: "#fffdf8",
    fontSize: 14,
    fontWeight: "800",
  },
  appName: {
    color: "#20242a",
    fontSize: 20,
    fontWeight: "800",
  },
  headerMeta: {
    color: "#676d73",
    fontSize: 12,
  },
  pendingPill: {
    minHeight: 32,
    borderRadius: 16,
    backgroundColor: "#dff4eb",
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#1d9e75",
  },
  pendingText: {
    color: "#0b6049",
    fontSize: 12,
    fontWeight: "800",
  },
  tabs: {
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
  tab: {
    flex: 1,
    minHeight: 38,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  activeTab: {
    backgroundColor: "#20242a",
  },
  tabText: {
    color: "#676d73",
    fontSize: 12,
    fontWeight: "800",
  },
  activeTabText: {
    color: "#fffdf8",
  },
  content: {
    padding: 18,
    paddingBottom: 36,
    gap: 0,
  },
  promptPanel: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: "#ded8ca",
    borderRadius: 8,
    backgroundColor: "#fffdf8",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 8,
    marginBottom: 12,
  },
  promptInput: {
    flex: 1,
    minHeight: 38,
    color: "#20242a",
    paddingHorizontal: 8,
  },
  promptButton: {
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: "#20242a",
    alignItems: "center",
    justifyContent: "center",
  },
  answerPanel: {
    borderWidth: 1,
    borderColor: "#cfded8",
    borderRadius: 8,
    backgroundColor: "#f4fbf8",
    padding: 14,
    marginBottom: 14,
  },
  answerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  answerTitle: {
    color: "#20242a",
    fontSize: 13,
    fontWeight: "800",
  },
  answerSource: {
    color: "#0b6049",
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  answerText: {
    color: "#20242a",
    fontSize: 14,
    lineHeight: 21,
  },
  metrics: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 20,
  },
  metric: {
    flex: 1,
    minHeight: 74,
    borderWidth: 1,
    borderColor: "#ded8ca",
    borderRadius: 8,
    padding: 12,
    backgroundColor: "#fbf8f1",
  },
  metricValue: {
    color: "#20242a",
    fontSize: 24,
    fontWeight: "800",
  },
  metricLabel: {
    color: "#676d73",
    fontSize: 12,
    lineHeight: 15,
    marginTop: 5,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: "#ebe7dc",
    alignItems: "center",
    justifyContent: "center",
  },
  sectionHeader: {
    marginTop: 22,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  sectionTitle: {
    color: "#20242a",
    fontSize: 17,
    fontWeight: "800",
  },
  sectionNote: {
    color: "#676d73",
    fontSize: 12,
  },
  emailCard: {
    borderWidth: 1,
    borderColor: "#ded8ca",
    borderRadius: 8,
    padding: 14,
    marginBottom: 10,
    backgroundColor: "#fffdf8",
    gap: 9,
  },
  selectedEmailCard: {
    borderColor: "#1d9e75",
  },
  emailTopline: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  senderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#e4eef9",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#174a7f",
    fontSize: 12,
    fontWeight: "800",
  },
  senderText: {
    flex: 1,
  },
  senderName: {
    color: "#20242a",
    fontSize: 13,
    fontWeight: "800",
  },
  emailMeta: {
    color: "#676d73",
    fontSize: 12,
    lineHeight: 17,
  },
  status: {
    minWidth: 82,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 8,
    alignItems: "center",
  },
  pendingStatus: {
    backgroundColor: "#f4ead5",
  },
  approvedStatus: {
    backgroundColor: "#dff4eb",
  },
  rejectedStatus: {
    backgroundColor: "#f7e4dd",
  },
  statusText: {
    color: "#20242a",
    fontSize: 11,
    fontWeight: "800",
  },
  emailSubject: {
    color: "#20242a",
    fontWeight: "800",
  },
  emailSummary: {
    color: "#676d73",
    fontSize: 13,
    lineHeight: 19,
  },
  scoreRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  scoreTrack: {
    flex: 1,
    height: 7,
    borderRadius: 999,
    backgroundColor: "#ebe7dc",
    overflow: "hidden",
  },
  scoreFill: {
    height: 7,
    borderRadius: 999,
    backgroundColor: "#1d9e75",
  },
  scoreText: {
    width: 34,
    textAlign: "right",
    color: "#676d73",
    fontSize: 12,
    fontWeight: "800",
  },
  draftPanel: {
    borderWidth: 1,
    borderColor: "#ded8ca",
    borderRadius: 8,
    padding: 14,
    backgroundColor: "#fbf8f1",
    marginTop: 12,
  },
  draftText: {
    color: "#20242a",
    fontSize: 14,
    lineHeight: 22,
  },
  editor: {
    minHeight: 138,
    borderWidth: 1,
    borderColor: "#ded8ca",
    borderRadius: 8,
    padding: 12,
    backgroundColor: "#fffdf8",
    color: "#20242a",
    textAlignVertical: "top",
  },
  actionRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
  },
  actionRowTwo: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
  },
  actionButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 8,
  },
  greenAction: {
    backgroundColor: "#dff4eb",
  },
  coralAction: {
    backgroundColor: "#f7e4dd",
  },
  neutralAction: {
    backgroundColor: "#ebe7dc",
  },
  actionText: {
    fontSize: 12,
    fontWeight: "800",
  },
  row: {
    flexDirection: "row",
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: "#ded8ca",
    alignItems: "center",
  },
  rowBody: {
    flex: 1,
  },
  rowTitle: {
    color: "#20242a",
    fontWeight: "800",
  },
  rowText: {
    color: "#676d73",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 2,
  },
  inlineButton: {
    minHeight: 36,
    borderRadius: 8,
    backgroundColor: "#ebe7dc",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  inlineButtonText: {
    color: "#20242a",
    fontSize: 12,
    fontWeight: "800",
  },
  eventTime: {
    width: 58,
    color: "#2b74c7",
    fontWeight: "800",
  },
  auditTime: {
    width: 64,
    color: "#676d73",
    fontSize: 12,
    fontWeight: "800",
  },
  empty: {
    color: "#676d73",
    textAlign: "center",
    paddingVertical: 28,
  },
  timeInput: {
    width: 112,
    minHeight: 42,
    borderWidth: 1,
    borderColor: "#ded8ca",
    borderRadius: 8,
    paddingHorizontal: 10,
    color: "#20242a",
    marginTop: 8,
    fontWeight: "800",
  },
});
