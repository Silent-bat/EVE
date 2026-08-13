/**
 * The frame every settings sub-page sits in: a back button, a title, and an
 * optional line of explanation before the first group.
 *
 * Settings renders inside the app's ScrollView, so a page is just a View — it
 * scrolls with everything else and doesn't nest a second scroller.
 */
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { TopNav } from "../ui/components";
import { spacing } from "../ui/theme";
import { useThemedStyles, type ThemeValue } from "../ui/ThemeContext";

export function SettingsPage({
  title,
  intro,
  onBack,
  children,
}: {
  title: string;
  /**
   * One or two sentences on what this page is for. Pages that need no
   * explanation should omit it rather than pad.
   */
  intro?: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <TopNav title={title} onBack={onBack} backLabel="Back to settings" />
      {intro ? <Text style={styles.intro}>{intro}</Text> : null}
      <View style={styles.body}>{children}</View>
    </View>
  );
}

function makeStyles({ type }: ThemeValue) {
  return StyleSheet.create({
    intro: {
      ...type.caption,
      lineHeight: 19,
      paddingHorizontal: spacing.xs,
      marginTop: spacing.xs,
    },
    // The first group supplies its own top margin, so nothing here.
    body: {},
  });
}
