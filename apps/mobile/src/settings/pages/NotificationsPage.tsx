/**
 * When EVE speaks — the scheduled kind, as opposed to the proactive kind.
 *
 * Push and briefing time are one decision each and stay inline. "Interrupt me"
 * is a button rather than a switch because it opens a window with a duration
 * and a scope; it isn't a setting you leave on.
 */
import { StyleSheet, Text, View } from "react-native";

import type { Preferences, ProactiveAvailableNow } from "../../types";
import { InlineButton } from "../../ui/primitives";
import { spacing } from "../../ui/theme";
import { useThemedStyles, type ThemeValue } from "../../ui/ThemeContext";
import { TimeField } from "../fields";
import { SettingsPage } from "../PageShell";
import { SettingsGroup, SettingsRowItem, SettingsSwitch } from "../rows";

export function NotificationsPage({
  preferences,
  availableNow,
  onBack,
  onUpdatePreferences,
  onStartInterrupt,
  onStopInterrupt,
}: {
  preferences: Preferences;
  availableNow: ProactiveAvailableNow | null;
  onBack: () => void;
  onUpdatePreferences: (next: Preferences) => void;
  onStartInterrupt: () => void;
  onStopInterrupt: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const open = availableNow ? describeWindow(availableNow.until) : null;

  return (
    <SettingsPage
      title="Notifications"
      onBack={onBack}
      intro="The scheduled kind. Anything EVE raises unprompted is governed by the proactive rules instead."
    >
      <SettingsGroup footer="Push covers the morning briefing and receipts for actions EVE took for you. The briefing lands at the time set here.">
        <SettingsRowItem
          icon="notifications-outline"
          tone="ambient"
          title="Push notifications"
          control={
            <SettingsSwitch
              value={preferences.pushEnabled}
              onChange={(pushEnabled) => onUpdatePreferences({ ...preferences, pushEnabled })}
              label="Push notifications"
            />
          }
        />
        <SettingsRowItem
          icon="sunny-outline"
          tone="warning"
          title="Briefing time"
          control={
            <TimeField
              value={preferences.briefingTime}
              onChange={(briefingTime) => onUpdatePreferences({ ...preferences, briefingTime })}
              label="Briefing time"
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="Interrupt me"
        footer="Opens a window where EVE may bypass quiet hours and the frequency caps. It closes on its own."
      >
        <SettingsRowItem
          icon="flash-outline"
          tone="ambient"
          title={open ? "Open now" : "Not open"}
          subtitle={open ? `Until ${open}` : "Following your usual rules"}
          control={
            open ? (
              <InlineButton label="Close" onPress={onStopInterrupt} />
            ) : (
              <InlineButton label="Open" tone="ambient" onPress={onStartInterrupt} />
            )
          }
        />
      </SettingsGroup>

      <View style={styles.spacer}>
        <Text style={styles.note}>
          Turning push off silences your phone, not EVE — everything still lands on Today.
        </Text>
      </View>
    </SettingsPage>
  );
}

/** "18:40" — the end of the window, in the phone's own clock format. */
function describeWindow(until: string): string | null {
  const date = new Date(until);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) return null;
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function makeStyles({ type }: ThemeValue) {
  return StyleSheet.create({
    spacer: { marginTop: spacing.xl, paddingHorizontal: spacing.xs },
    note: { ...type.caption, lineHeight: 18 },
  });
}
