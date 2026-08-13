/**
 * The sidebar, opened by tapping your avatar in the header.
 *
 * This is where everything that isn't a daily destination lives. The nav bar
 * carries the four places you go every day; the drawer carries the ones you
 * visit occasionally — settings, your account, what EVE remembers about you.
 * That split is what let Settings leave the tab bar without becoming hard to
 * find: it is one tap from the home screen, behind the thing that already
 * means "me".
 *
 * It used to carry six rows, four of which were the settings index reprinted a
 * tap earlier — Appearance, Proactive agent, and From your phone are all rows
 * inside All settings, so the drawer was mostly a second copy of the list it
 * links to. A menu that mirrors another menu makes both harder to read. What
 * survives is what the settings list is *not*: you, what EVE knows about you,
 * and the way into everything else.
 *
 * Implemented as a Modal rather than a navigator. The app has no navigation
 * library, and a drawer that slides over the current screen doesn't need one —
 * it never changes which tab is underneath it.
 */
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef } from "react";
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { UserAvatar } from "../ui/components";
import { PressableScale } from "../ui/motion";
import { HIT_SLOP, MIN_TOUCH, radius, spacing } from "../ui/theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";

/** Wide enough for two-line rows, narrow enough to keep the page behind visible. */
const DRAWER_WIDTH = Math.min(320, Dimensions.get("window").width * 0.84);

/**
 * Where the drawer can send you. Deliberately short — anything reachable from
 * the settings index belongs there, not here as well.
 */
export type SidebarDestination = "settings" | "account" | "memory";

type Item = {
  key: SidebarDestination;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
};

const ITEMS: Item[] = [
  {
    key: "memory",
    icon: "sparkles-outline",
    title: "What EVE knows",
    subtitle: "Role, projects, key people",
  },
  {
    key: "account",
    icon: "person-circle-outline",
    title: "Account",
    subtitle: "Name, password, connections",
  },
  {
    key: "settings",
    icon: "options-outline",
    title: "All settings",
    subtitle: "Alerts, appearance, the rest",
  },
];

export function Sidebar({
  visible,
  name,
  email,
  photoURL,
  onClose,
  onNavigate,
  onSignOut,
}: {
  visible: boolean;
  name?: string | null;
  email?: string | null;
  photoURL?: string | null;
  onClose: () => void;
  onNavigate: (destination: SidebarDestination) => void;
  onSignOut: () => void;
}) {
  const { palette, reduceMotion } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) {
      slide.setValue(visible ? 1 : 0);
      return;
    }
    Animated.timing(slide, {
      toValue: visible ? 1 : 0,
      // Out is quicker than in: a drawer you're dismissing should get out of
      // the way, one you're opening should feel like it has weight.
      duration: visible ? 220 : 150,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, reduceMotion, slide]);

  const translateX = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [-DRAWER_WIDTH, 0],
  });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* The scrim dismisses on tap. Labelled as a button so a screen reader
          has a way out that isn't hunting for the close control. */}
      <Pressable
        style={styles.scrim}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close menu"
      />

      <Animated.View style={[styles.drawer, { transform: [{ translateX }] }]}>
        <SafeAreaView style={styles.inner} edges={["top", "bottom"]}>
          <View style={styles.header}>
            <UserAvatar photoURL={photoURL} name={name} email={email} size="lg" />
            <View style={styles.headerText}>
              {/* Lead with whatever actually identifies the person. Google
                  returns no display name for some accounts, and "Your account"
                  over the address read like a placeholder next to an avatar
                  already showing their initial. Same rule as the settings index. */}
              <Text style={styles.headerName} numberOfLines={1}>
                {name || email || "EVE account"}
              </Text>
              <Text style={styles.headerEmail} numberOfLines={1}>
                {name && email ? email : "Signed in on this device"}
              </Text>
            </View>
            <PressableScale
              onPress={onClose}
              hitSlop={HIT_SLOP}
              accessibilityRole="button"
              accessibilityLabel="Close menu"
              style={styles.close}
            >
              <Ionicons name="close" size={20} color={palette.textMuted} />
            </PressableScale>
          </View>

          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
          >
            {ITEMS.map((item) => (
              <PressableScale
                key={item.key}
                onPress={() => onNavigate(item.key)}
                accessibilityRole="button"
                accessibilityLabel={item.title}
                accessibilityHint={item.subtitle}
                style={styles.row}
              >
                <View style={styles.rowIcon}>
                  <Ionicons name={item.icon} size={19} color={palette.ambient} />
                </View>
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={styles.rowSubtitle} numberOfLines={1}>
                    {item.subtitle}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={palette.textMuted} />
              </PressableScale>
            ))}
          </ScrollView>

          <PressableScale
            onPress={onSignOut}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            style={styles.signOut}
          >
            <Ionicons name="log-out-outline" size={18} color={palette.danger} />
            <Text style={styles.signOutText}>Sign out</Text>
          </PressableScale>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: palette.scrim },
    drawer: {
      position: "absolute",
      top: 0,
      bottom: 0,
      left: 0,
      width: DRAWER_WIDTH,
      backgroundColor: palette.background,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: palette.border,
    },
    inner: { flex: 1 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.lg,
      paddingBottom: spacing.xl,
    },
    headerText: { flex: 1, gap: 2 },
    headerName: { ...type.title, fontSize: 16 },
    headerEmail: { ...type.caption, fontSize: 12 },
    close: {
      width: 32,
      height: 32,
      borderRadius: radius.pill,
      alignItems: "center",
      justifyContent: "center",
    },
    list: { flex: 1 },
    listContent: { paddingHorizontal: spacing.md, gap: spacing.xs },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      minHeight: MIN_TOUCH,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      borderRadius: radius.lg,
    },
    rowIcon: {
      width: 36,
      height: 36,
      borderRadius: radius.md,
      backgroundColor: palette.ambientTint,
      alignItems: "center",
      justifyContent: "center",
    },
    rowText: { flex: 1, gap: 1 },
    rowTitle: { ...type.label, fontSize: 15 },
    rowSubtitle: { ...type.caption, fontSize: 12 },
    signOut: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.sm,
      minHeight: MIN_TOUCH,
      marginHorizontal: spacing.lg,
      marginTop: spacing.md,
      marginBottom: spacing.md,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: palette.border,
    },
    signOutText: { ...type.label, fontSize: 14, color: palette.danger },
  });
}
