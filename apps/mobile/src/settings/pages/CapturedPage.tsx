/**
 * Captured notifications — what EVE has read from your other apps, and the
 * Android permission that allows it.
 *
 * The permission row leads the page rather than sitting on the index: the list
 * below it is empty and inexplicable until you grant it, so the two belong on
 * the same screen.
 */
import { Platform, StyleSheet, Text, View } from "react-native";

import type { DeviceNotification } from "../../types";
import { formatTime } from "../../utils/formatters";
import { EmptyState } from "../../ui/components";
import { InlineButton } from "../../ui/primitives";
import { radius, spacing } from "../../ui/theme";
import { useThemedStyles, type ThemeValue } from "../../ui/ThemeContext";
import { SettingsPage } from "../PageShell";
import { SettingsGroup, SettingsRowItem } from "../rows";

const MAX_SHOWN = 25;

export function CapturedPage({
  notifications,
  supported,
  enabled,
  onBack,
  onOpenAccessSettings,
}: {
  notifications: DeviceNotification[];
  supported: boolean;
  enabled: boolean;
  onBack: () => void;
  onOpenAccessSettings: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const shown = notifications.slice(0, MAX_SHOWN);

  return (
    <SettingsPage
      title="From your phone"
      onBack={onBack}
      intro="EVE reads the notifications your other apps post, so a shipping update can be told apart from a client chasing you."
    >
      <SettingsGroup
        title="Permission"
        footer={
          supported
            ? "Android only. Revoke it any time from the same screen."
            : undefined
        }
      >
        <SettingsRowItem
          icon="phone-portrait-outline"
          tone={enabled ? "success" : "neutral"}
          title="Notification access"
          subtitle={accessSubtitle(supported, enabled)}
          disabled={!supported}
          control={
            supported ? (
              <InlineButton
                label={enabled ? "Manage" : "Turn on"}
                tone={enabled ? "neutral" : "ambient"}
                onPress={onOpenAccessSettings}
              />
            ) : undefined
          }
        />
      </SettingsGroup>

      <View style={styles.listHeader}>
        <Text style={styles.listTitle}>Recently captured</Text>
        {notifications.length > 0 ? (
          <Text style={styles.listCount}>
            {notifications.length > MAX_SHOWN
              ? `${MAX_SHOWN} of ${notifications.length}`
              : String(notifications.length)}
          </Text>
        ) : null}
      </View>

      {shown.length === 0 ? (
        <EmptyState
          icon="albums-outline"
          title="Nothing captured yet"
          body={
            enabled
              ? "Next time one of your apps posts a notification, it shows up here."
              : "Turn notification access on above and this fills itself in."
          }
        />
      ) : (
        <View style={styles.card}>
          {shown.map((entry, index) => (
            <View key={entry.id}>
              {index > 0 ? <View style={styles.divider} /> : null}
              <View
                style={styles.item}
                accessible
                accessibilityLabel={`${entry.appName || entry.packageName}. ${entry.title}. ${
                  entry.body
                }. ${formatTime(entry.receivedAt)}`}
              >
                <View style={styles.itemBody}>
                  <Text style={styles.app} numberOfLines={1}>
                    {entry.appName || entry.packageName}
                  </Text>
                  <Text style={styles.title} numberOfLines={1}>
                    {entry.title || "(no title)"}
                  </Text>
                  {entry.body ? (
                    <Text style={styles.text} numberOfLines={2}>
                      {entry.body}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.time}>{formatTime(entry.receivedAt)}</Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </SettingsPage>
  );
}

function accessSubtitle(supported: boolean, enabled: boolean): string {
  if (!supported) {
    return Platform.OS === "android" ? "Needs the dev build" : "Android only";
  }
  return enabled ? "On — syncing to EVE" : "Off — nothing is read";
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    listHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: spacing.xxl,
      marginBottom: spacing.md,
      paddingHorizontal: spacing.xs,
    },
    listTitle: {
      ...type.caption,
      fontSize: 12,
      fontWeight: "800",
      letterSpacing: 0.6,
      textTransform: "uppercase",
    },
    listCount: { ...type.caption, fontVariant: ["tabular-nums"] },
    card: {
      backgroundColor: palette.surface,
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: palette.border,
      overflow: "hidden",
    },
    divider: { height: 1, backgroundColor: palette.border },
    item: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: spacing.md,
      padding: spacing.lg,
    },
    itemBody: { flex: 1, gap: 2 },
    // App name first and small: it's the thing that tells you whether the
    // notification below is worth reading.
    app: {
      ...type.caption,
      fontSize: 11,
      fontWeight: "800",
      letterSpacing: 0.4,
      textTransform: "uppercase",
      color: palette.ambient,
    },
    title: { ...type.label, fontSize: 14 },
    text: { ...type.caption, lineHeight: 17 },
    time: { ...type.caption, fontVariant: ["tabular-nums"], marginTop: 1 },
  });
}
