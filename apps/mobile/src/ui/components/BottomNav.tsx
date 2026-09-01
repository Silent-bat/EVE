/**
 * The bottom navigation.
 *
 * A full-width bar anchored to the bottom edge — not a floating pill. It spans
 * the screen, sits flush against the safe-area inset, and separates from the
 * page with a hairline and light rather than a gap. EVE's button is raised
 * through the middle: not a fifth tab, because voice is a mode you enter rather
 * than a place you go, and it looks different because it behaves differently.
 *
 * The bar is chrome for the four top-level destinations only. Sub-pages (a
 * settings leaf, an open email, the sidebar) hide it — see `navVisible` in
 * App.tsx — because there the back affordance is the navigation and a tab bar
 * would offer to leave a page you're in the middle of.
 *
 * Screens must reserve `BOTTOM_NAV_CLEARANCE` at the foot of their scroll
 * content or their last row hides underneath.
 */
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SoftGradient, SoftRadial, withAlpha } from "../gradient";
import { PressableScale } from "../motion";
import { elevation, HIT_SLOP, MIN_TOUCH, radius, spacing } from "../theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ThemeContext";

const EVE_BUTTON = 60;
/** How far the EVE button rises above the bar. Half its height. */
const EVE_OVERHANG = EVE_BUTTON / 2;
/** The bloom behind the EVE button. Wider than the button it sits under. */
const EVE_HALO = 104;

/** Height of the bar, plus room for the raised button above it. */
export const BOTTOM_NAV_CLEARANCE = 104;

export type NavTab = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconActive: keyof typeof Ionicons.glyphMap;
  /** Small dot on the icon — unread mail, pending approvals. */
  badge?: boolean;
};

export function BottomNav({
  tabs,
  active,
  onSelect,
  onPressEve,
  eveLabel = "Talk to EVE",
}: {
  tabs: NavTab[];
  active: string;
  onSelect: (key: string) => void;
  onPressEve: () => void;
  eveLabel?: string;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  // Split the tabs around the centre button. An odd count puts the extra item
  // on the left, which is the right call for a 4-tab bar and harmless otherwise.
  const midpoint = Math.ceil(tabs.length / 2);
  const groups = [tabs.slice(0, midpoint), tabs.slice(midpoint)];

  return (
    <View
      // Sits above content but must not swallow taps in the gap above the bar
      // where the EVE button's overhang lives.
      pointerEvents="box-none"
      style={styles.wrapper}
    >
      <View
        style={[
          styles.bar,
          // Gesture-nav devices report a bottom inset; button-nav devices report
          // 0, where the bar would otherwise sit flush on the screen edge.
          { paddingBottom: Math.max(insets.bottom, spacing.sm) },
        ]}
        accessibilityRole="tablist"
      >
        {groups.map((group, groupIndex) => (
          <View key={groupIndex} style={styles.group}>
            {group.map((tab) => (
              <NavItem
                key={tab.key}
                tab={tab}
                active={tab.key === active}
                onPress={() => onSelect(tab.key)}
              />
            ))}
          </View>
        ))}
      </View>

      {/* The bloom under the button. Decorative and non-interactive, so it goes
          behind the button in paint order and never intercepts the press. */}
      <View style={styles.eveHalo} pointerEvents="none">
        <SoftRadial
          colors={["transparent", withAlpha(palette.ambient, 0.05), withAlpha(palette.ambient, 0.1)]}
          rings={8}
          falloff={0.8}
        />
      </View>

      {/* Raised through the bar. Absolutely positioned rather than laid out
          between the groups, so its overhang can't stretch the bar's height. */}
      <PressableScale
        onPress={onPressEve}
        scaleTo={0.92}
        accessibilityRole="button"
        accessibilityLabel={eveLabel}
        style={[styles.eveButton, { backgroundColor: palette.ambient }]}
      >
        <SoftGradient
          colors={[palette.ambient, palette.ambientDeep]}
          direction="diagonal"
          bands={10}
          radius={radius.pill}
        />
        <Ionicons name="sparkles" size={24} color={palette.textInverse} />
      </PressableScale>
    </View>
  );
}

function NavItem({ tab, active, onPress }: { tab: NavTab; active: boolean; onPress: () => void }) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <PressableScale
      onPress={onPress}
      hitSlop={HIT_SLOP}
      accessibilityRole="tab"
      accessibilityLabel={tab.label}
      accessibilityState={{ selected: active }}
      style={styles.item}
    >
      <View style={styles.iconWrap}>
        <Ionicons
          name={active ? tab.iconActive : tab.icon}
          size={22}
          color={active ? palette.ambient : palette.textMuted}
        />
        {tab.badge ? <View style={styles.badge} /> : null}
      </View>
      {/* Labels are back. A full-width bar has room for them, and four
          icon-only glyphs asked the user to remember what a newspaper means. */}
      <Text numberOfLines={1} style={[styles.label, active ? { color: palette.ambient } : null]}>
        {tab.label}
      </Text>
    </PressableScale>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    wrapper: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      // Reserves the EVE button's overhang. Without it the raised half of the
      // button falls outside this view's bounds, and Android does not deliver
      // touches to a child drawn outside its parent — the top half of the
      // button would look pressable and quietly not be.
      paddingTop: EVE_OVERHANG,
      alignItems: "center",
    },
    bar: {
      flexDirection: "row",
      alignSelf: "stretch",
      backgroundColor: palette.surface,
      paddingTop: spacing.sm,
      paddingHorizontal: spacing.sm,
      // A hairline instead of a shadow: the bar is now part of the screen's
      // frame rather than an object floating over it.
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
      ...elevation.none,
    },
    group: { flex: 1, flexDirection: "row", justifyContent: "space-around" },
    item: {
      flex: 1,
      minHeight: MIN_TOUCH,
      alignItems: "center",
      justifyContent: "center",
      gap: 3,
      paddingHorizontal: spacing.xs,
    },
    iconWrap: { alignItems: "center", justifyContent: "center" },
    label: { ...type.caption, fontSize: 11, lineHeight: 13, color: palette.textMuted },
    badge: {
      position: "absolute",
      top: -2,
      right: -5,
      width: 8,
      height: 8,
      borderRadius: radius.pill,
      backgroundColor: palette.danger,
      borderWidth: 1.5,
      borderColor: palette.surface,
    },
    eveHalo: {
      position: "absolute",
      width: EVE_HALO,
      height: EVE_HALO,
      alignSelf: "center",
      // Centred on the button, which sits at top 0 of the reserved overhang.
      top: EVE_OVERHANG - (EVE_HALO - EVE_BUTTON) / 2,
    },
    eveButton: {
      position: "absolute",
      // Sits at the top of the reserved overhang, so half the button breaks
      // above the bar's edge and half overlaps it.
      top: 0,
      alignSelf: "center",
      width: EVE_BUTTON,
      height: EVE_BUTTON,
      borderRadius: radius.pill,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      // Ring in the page colour, separating the button from the bar beneath it
      // without drawing a visible outline.
      borderWidth: 3,
      borderColor: palette.background,
      ...elevation.float,
    },
  });
}
