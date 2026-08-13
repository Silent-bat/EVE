/**
 * Settings — an index of five rows, not a wall of twenty cards.
 *
 * The old screen put every control on one page, so a theme picker occupied the
 * same visual weight as sign-out and the proactive rules alone ran five
 * expanded cards deep. You had to read the whole thing to find anything.
 *
 * Now the page answers one question — "what can I change?" — with a row per
 * topic, each stating its current value ("On · 4 of 5", "07:30"). Anything with
 * more than one decision in it opens its own page. Only the two settings that
 * are genuinely one decision and genuinely frequent — theme, and the row you
 * came here to flip — stay inline.
 *
 * Sub-pages are local state rather than a navigator: this tab renders inside
 * the app's ScrollView, and adding a navigation library for four leaves would
 * cost more than it explains.
 */
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import { Alert, BackHandler, StyleSheet, Text, View } from "react-native";

import type {
  DeviceNotification,
  Preferences,
  ProactiveCategoryName,
  Session,
} from "../types";
import { startAvailableNow, stopAvailableNow } from "../proactive/api";
import { AvailableNowSheet } from "../proactive/AvailableNowSheet";
import { summarizeProactive, useProactivePrefs } from "../proactive/useProactivePrefs";
import { summarizeProfile, useProfile } from "../profile/useProfile";
import { UserAvatar, describeError } from "../ui/components";
import { PressableScale } from "../ui/motion";
import { HIT_SLOP, MIN_TOUCH, spacing } from "../ui/theme";
import {
  useTheme,
  useThemedStyles,
  type AppearancePreference,
  type ThemeValue,
} from "../ui/ThemeContext";
import { SettingsGroup, SettingsRowItem, SettingsSwitch } from "./rows";
import { AccountPage } from "./pages/AccountPage";
import { AppearancePage } from "./pages/AppearancePage";
import { CapturedPage } from "./pages/CapturedPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { ProactiveCategoryPage, ProactivePage } from "./pages/ProactivePage";
import { ProfilePage } from "./pages/ProfilePage";

/** What the index row shows for the current theme choice. */
const THEME_LABELS: Record<AppearancePreference, string> = {
  system: "Match my phone",
  light: "Lavender",
  dark: "Midnight",
};

type Page =
  | { name: "index" }
  | { name: "profile" }
  | { name: "proactive" }
  | { name: "proactiveCategory"; category: ProactiveCategoryName }
  | { name: "notifications" }
  | { name: "captured" }
  | { name: "appearance" }
  | { name: "account" };

/** Pages the sidebar can open directly, skipping the index. */
export type SettingsEntry = Exclude<Page["name"], "proactiveCategory">;

type Props = {
  session: Session;
  preferences: Preferences;
  deviceNotifications: DeviceNotification[];
  saving: boolean;
  notificationAccessSupported: boolean;
  notificationAccessEnabled: boolean;
  /** Whether the home screen carries the ask dock. Device-local, from App. */
  listenFromHomeEnabled: boolean;
  onChangeListenFromHome: (next: boolean) => void;
  onLogout: () => void;
  /** Token is already dead server-side; the caller returns to the auth screen. */
  onAccountDeleted: () => void;
  /**
   * Applies a session the server re-issued after an account change. App holds
   * the session, so a rename or a Google disconnect has to travel back up
   * rather than being patched locally on this page.
   */
  onSessionChange: (session: Session) => void;
  /** Starts Google OAuth. The same call the reconnect wall makes. */
  onConnectGoogle: () => void;
  onUpdatePreferences: (next: Preferences) => void;
  onChangeBriefingTime: (next: string) => void;
  onOpenNotificationAccessSettings: () => void;
  onError: (message: string) => void;
  /**
   * Which page to land on. The sidebar sends people straight to Appearance or
   * Account, so the tab has to be able to open somewhere other than its index.
   * Changing this value re-enters that page.
   */
  entry?: SettingsEntry;
  /** Leaves settings entirely. Back from the index, which has nothing under it. */
  onExit?: () => void;
  /**
   * Called on every push and pop. The settings list is taller than the screen,
   * so a row tapped near the bottom would otherwise open a page whose header
   * sits above the fold. App owns the scroller, so App resets it.
   */
  onNavigate?: () => void;
};

export function SettingsTab({
  session,
  preferences,
  deviceNotifications,
  saving,
  notificationAccessSupported,
  notificationAccessEnabled,
  listenFromHomeEnabled,
  onChangeListenFromHome,
  onLogout,
  onAccountDeleted,
  onSessionChange,
  onConnectGoogle,
  onUpdatePreferences,
  onChangeBriefingTime,
  onOpenNotificationAccessSettings,
  onError,
  entry,
  onExit,
  onNavigate,
}: Props) {
  const styles = useThemedStyles(makeStyles);
  const { palette, preference } = useTheme();

  // A stack rather than a single value: the proactive category page is two
  // levels deep, and back from it must land on the proactive page.
  const [stack, setStack] = useState<Page[]>(() => stackFor(entry));
  const [interruptOpen, setInterruptOpen] = useState(false);

  const proactive = useProactivePrefs(onError);
  const profile = useProfile(onError);

  const push = useCallback(
    (page: Page) => {
      setStack((current) => [...current, page]);
      onNavigate?.();
    },
    [onNavigate],
  );

  const pop = useCallback(() => {
    setStack((current) => {
      // Back from the index leaves settings altogether — there is no tab
      // underneath it any more, so staying put would strand the user on a page
      // whose only exit is the system back gesture.
      if (current.length <= 1) {
        onExit?.();
        return current;
      }
      return current.slice(0, -1);
    });
    onNavigate?.();
  }, [onExit, onNavigate]);

  // The sidebar can ask for a page while this tab is already mounted — tapping
  // Appearance from the drawer after having been in Settings has to move, not
  // silently land on whatever page was left open. Resets the stack rather than
  // pushing, so Back from a deep-linked page returns to the index.
  useEffect(() => {
    if (!entry) return;
    setStack(stackFor(entry));
    onNavigate?.();
  }, [entry, onNavigate]);

  // Android's back gesture walks out of settings a page at a time rather than
  // leaving the app. Subscribed even on the index, because the index is itself
  // a layer over a tab now and back from it should return there.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      pop();
      return true;
    });
    return () => sub.remove();
  }, [pop]);

  async function beginAvailableNow(input: Parameters<typeof startAvailableNow>[0]) {
    setInterruptOpen(false);
    try {
      await startAvailableNow(input);
      await proactive.reload();
    } catch (error) {
      onError(describeError(error));
    }
  }

  async function endAvailableNow() {
    try {
      await stopAvailableNow();
      await proactive.reload();
    } catch (error) {
      onError(describeError(error));
    }
  }

  // Sign-out revokes the Google grant, so the way back in is full consent
  // again, not a silent re-login. That's more than a mis-tap should cost.
  const confirmLogout = useCallback(() => {
    Alert.alert(
      "Sign out of EVE?",
      "You'll need to sign in with Google again, including the permission screen.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: onLogout },
      ],
    );
  }, [onLogout]);

  // The stack is never empty, but the index signature doesn't know that.
  const page: Page = stack[stack.length - 1] ?? { name: "index" };

  if (page.name === "profile") {
    return <ProfilePage state={profile} onBack={pop} />;
  }

  if (page.name === "proactive") {
    return (
      <ProactivePage
        state={proactive}
        onBack={pop}
        onOpenCategory={(category) => push({ name: "proactiveCategory", category })}
      />
    );
  }

  if (page.name === "proactiveCategory") {
    return <ProactiveCategoryPage name={page.category} state={proactive} onBack={pop} />;
  }

  if (page.name === "notifications") {
    return (
      <>
        <NotificationsPage
          preferences={preferences}
          availableNow={proactive.prefs?.availableNow ?? null}
          onBack={pop}
          onUpdatePreferences={(next) => {
            // Keep the local mirror in step before the save so the field
            // doesn't snap back to the old time while the request is in flight.
            if (next.briefingTime !== preferences.briefingTime) {
              onChangeBriefingTime(next.briefingTime);
            }
            onUpdatePreferences(next);
          }}
          onStartInterrupt={() => setInterruptOpen(true)}
          onStopInterrupt={() => void endAvailableNow()}
        />
        <AvailableNowSheet
          visible={interruptOpen}
          onClose={() => setInterruptOpen(false)}
          onConfirm={(input) => void beginAvailableNow(input)}
        />
      </>
    );
  }

  if (page.name === "captured") {
    return (
      <CapturedPage
        notifications={deviceNotifications}
        supported={notificationAccessSupported}
        enabled={notificationAccessEnabled}
        onBack={pop}
        onOpenAccessSettings={onOpenNotificationAccessSettings}
      />
    );
  }

  if (page.name === "appearance") {
    return <AppearancePage onBack={pop} />;
  }

  if (page.name === "account") {
    return (
      <AccountPage
        session={session}
        saving={saving}
        onBack={pop}
        onSignOut={confirmLogout}
        onSessionChange={onSessionChange}
        onConnectGoogle={onConnectGoogle}
        onDeleted={onAccountDeleted}
        onError={onError}
      />
    );
  }

  return (
    <View>
      {/* The index is a layer over whichever tab you came from, so it needs its
          own way out. Sub-pages get this from SettingsPage; the index doesn't
          use that shell because its header is the account row below. */}
      {onExit ? (
        <PressableScale
          onPress={onExit}
          hitSlop={HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel="Close settings"
          style={styles.exit}
        >
          <Ionicons name="chevron-back" size={20} color={palette.text} />
          <Text style={styles.exitLabel}>Settings</Text>
        </PressableScale>
      ) : null}

      <PressableScale
        onPress={() => push({ name: "account" })}
        accessibilityRole="button"
        accessibilityLabel="Account"
        accessibilityHint="Sign-in, connections, and deleting your data"
        style={styles.identity}
      >
        <UserAvatar
          photoURL={session.photoURL}
          name={session.displayName}
          email={session.email}
          size="lg"
        />
        <View style={styles.identityText}>
          <Text style={styles.identityName} numberOfLines={1}>
            {session.displayName || session.email || "EVE account"}
          </Text>
          <Text style={styles.identityNote} numberOfLines={1}>
            {session.displayName && session.email ? session.email : "Signed in on this device"}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={palette.textMuted} />
      </PressableScale>

      <SettingsGroup title="EVE" footer="Everything EVE does about you comes from these two.">
        <SettingsRowItem
          icon="sparkles-outline"
          tone="ambient"
          title="What EVE knows"
          subtitle="Role, projects, key people"
          value={summarizeProfile(profile.profile)}
          onPress={() => push({ name: "profile" })}
        />
        <SettingsRowItem
          icon="planet-outline"
          tone="ambient"
          title="Proactive agent"
          subtitle="When EVE may interrupt"
          value={summarizeProactive(proactive.prefs)}
          onPress={() => push({ name: "proactive" })}
        />
      </SettingsGroup>

      <SettingsGroup title="Alerts">
        <SettingsRowItem
          icon="notifications-outline"
          tone="info"
          title="Notifications"
          subtitle="Push, and briefing time"
          value={preferences.pushEnabled ? preferences.briefingTime : "Off"}
          onPress={() => push({ name: "notifications" })}
        />
        <SettingsRowItem
          icon="albums-outline"
          tone="info"
          title="From your phone"
          subtitle="What EVE reads from other apps"
          value={
            notificationAccessEnabled
              ? String(deviceNotifications.length)
              : notificationAccessSupported
                ? "Off"
                : undefined
          }
          onPress={() => push({ name: "captured" })}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Home"
        footer="With this on, the microphone is open whenever the home screen is. EVE hears you, answers aloud, and starts listening again — no button to hold. She stops listening while she is speaking, and the pause control closes both the mic and the session."
      >
        <SettingsRowItem
          icon="mic-outline"
          tone="ambient"
          title="Listen from home"
          subtitle="Talk to EVE without opening anything"
          control={
            <SettingsSwitch
              label="Listen from home"
              hint="Keeps the microphone open on the home screen"
              value={listenFromHomeEnabled}
              onChange={onChangeListenFromHome}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Appearance">
        <SettingsRowItem
          icon="color-palette-outline"
          tone="ambient"
          title="Theme"
          subtitle="Light, dark, or follow the system"
          value={THEME_LABELS[preference]}
          onPress={() => push({ name: "appearance" })}
        />
      </SettingsGroup>

      {/* Alone in its group and pushed down the page: nothing here should sit
          a thumb's width from a row you tap every day. */}
      <SettingsGroup>
        <SettingsRowItem
          icon="log-out-outline"
          title="Sign out"
          destructive
          disabled={saving}
          onPress={confirmLogout}
        />
      </SettingsGroup>

      <Text style={styles.footer} accessibilityRole="text">
        EVE only sends mail you approved.
      </Text>

      {/* Mounted from the index too, so a stray open request can't leave the
          sheet orphaned on a page that has since been popped. */}
      <AvailableNowSheet
        visible={interruptOpen}
        onClose={() => setInterruptOpen(false)}
        onConfirm={(input) => void beginAvailableNow(input)}
      />
    </View>
  );
}

/**
 * The stack a deep link should produce. The index stays underneath, so Back
 * from a page the sidebar opened lands on the settings list rather than on
 * nothing — the drawer is closed by then and a dead Back button would trap you.
 */
function stackFor(entry?: SettingsEntry): Page[] {
  if (!entry || entry === "index") return [{ name: "index" }];
  return [{ name: "index" }, { name: entry }];
}

function makeStyles({ type }: ThemeValue) {
  return StyleSheet.create({
    // Not a card. The account isn't a setting you change, it's the answer to
    // "whose settings am I looking at" — so it reads as a page header. It
    // opens the account page, which is why the chevron is there.
    identity: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing.xs,
      paddingVertical: spacing.sm,
    },
    exit: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
      alignSelf: "flex-start",
      minHeight: MIN_TOUCH,
      paddingRight: spacing.md,
    },
    exitLabel: { ...type.label, fontSize: 15 },
    identityText: { flex: 1, gap: 2 },    // 16 rather than the title's 17: a full email address is the longest string
    // on the page and this is the size at which the common ones stop truncating.
    identityName: { ...type.title, fontSize: 16 },
    identityNote: { ...type.caption },
    footer: {
      ...type.caption,
      fontSize: 12,
      textAlign: "center",
      marginTop: spacing.xxl,
    },
  });
}
