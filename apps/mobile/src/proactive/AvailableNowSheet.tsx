/**
 * The "Interrupt me" sheet. Flips the agent from default-quiet to
 * default-loud for a bounded window. Time-bound (max 12h) and
 * category-scoped, by design: the user is signing up for interruption
 * about a specific thing, not handing the agent a blank check.
 */
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";

import type { ProactiveCategoryName } from "../types";
import { HIT_SLOP, MIN_TOUCH, radius, spacing } from "../ui/theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";
import { InlineButton, Segmented } from "../ui/primitives";
import { PressableScale } from "../ui/motion";
import { CATEGORY_META, PROACTIVE_CATEGORY_ORDER } from "./categories";

type Props = {
  visible: boolean;
  onClose: () => void;
  onConfirm: (input: {
    minutes: number;
    categories: ProactiveCategoryName[];
    reason: string;
  }) => void;
};

const DURATION_OPTIONS = [
  { value: "30", label: "30 min" },
  { value: "120", label: "2 hr" },
  { value: "240", label: "4 hr" },
  { value: "720", label: "12 hr" },
] as const;

export function AvailableNowSheet({ visible, onClose, onConfirm }: Props) {
  const { palette, toneAccent } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [minutes, setMinutes] = useState<"30" | "120" | "240" | "720">("120");
  const [selected, setSelected] = useState<Set<ProactiveCategoryName>>(
    new Set(PROACTIVE_CATEGORY_ORDER),
  );

  function toggle(name: ProactiveCategoryName) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function confirm() {
    if (selected.size === 0) return;
    onConfirm({
      minutes: Number(minutes),
      categories: Array.from(selected),
      reason: "user_invited",
    });
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Interrupt me</Text>
              <Text style={styles.subtitle}>
                EVE will push proactive thoughts during this window, bypassing quiet hours
                for the selected categories.
              </Text>
            </View>
            <PressableScale
              style={styles.close}
              onPress={onClose}
              hitSlop={HIT_SLOP}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={18} color={palette.text} />
            </PressableScale>
          </View>

          <Text style={styles.sectionLabel}>Window</Text>
          <Segmented
            tone="ambient"
            value={minutes}
            onChange={(next) => setMinutes(next)}
            options={DURATION_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
          />

          <Text style={styles.sectionLabel}>Categories</Text>
          <ScrollView style={styles.categories} bounces={false}>
            {PROACTIVE_CATEGORY_ORDER.map((name) => {
              const meta = CATEGORY_META[name];
              const active = selected.has(name);
              return (
                <PressableScale
                  key={name}
                  style={[
                    styles.categoryRow,
                    active ? { borderColor: toneAccent("ambient"), backgroundColor: palette.ambientTint } : null,
                  ]}
                  onPress={() => toggle(name)}
                  accessibilityRole="checkbox"
                  accessibilityLabel={meta.label}
                  accessibilityState={{ checked: active }}
                >
                  <Ionicons
                    name={meta.icon}
                    size={18}
                    color={active ? palette.ambientDeep : palette.textMuted}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.categoryLabel}>{meta.label}</Text>
                    <Text style={styles.categoryHint}>{meta.description}</Text>
                  </View>
                  <Ionicons
                    name={active ? "checkmark-circle" : "ellipse-outline"}
                    size={18}
                    color={active ? palette.ambient : palette.border}
                  />
                </PressableScale>
              );
            })}
          </ScrollView>

          <View style={styles.footer}>
            <InlineButton label="Cancel" onPress={onClose} tone="neutral" />
            <View style={{ flex: 1 }}>
              <PressableScale
                onPress={confirm}
                disabled={selected.size === 0}
                style={[styles.primary, selected.size === 0 ? { opacity: 0.45 } : null]}
                accessibilityRole="button"
                accessibilityLabel="Start window"
                accessibilityState={{ disabled: selected.size === 0 }}
              >
                <Ionicons name="megaphone-outline" size={15} color={palette.textInverse} />
                <Text style={styles.primaryText}>Start window</Text>
              </PressableScale>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles({ palette }: ThemeValue) {
  return StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: palette.scrim,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: palette.background,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
    maxHeight: "85%",
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.border,
    marginBottom: spacing.sm,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  title: {
    color: palette.text,
    fontSize: 20,
    fontWeight: "800",
  },
  subtitle: {
    color: palette.textMuted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  close: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: MIN_TOUCH / 2,
    backgroundColor: palette.surfaceMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionLabel: {
    color: palette.text,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginTop: spacing.sm,
  },
  categories: {
    maxHeight: 300,
  },
  categoryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radius.sm,
    marginBottom: 8,
    backgroundColor: palette.surface,
  },
  categoryLabel: {
    color: palette.text,
    fontWeight: "800",
    fontSize: 13,
  },
  categoryHint: {
    color: palette.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  footer: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  primary: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.sm,
    backgroundColor: palette.ambient,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
  },
  primaryText: {
    color: palette.textInverse,
    fontWeight: "800",
    fontSize: 14,
  },
  });
}
