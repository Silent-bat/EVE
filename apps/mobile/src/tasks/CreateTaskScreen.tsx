/**
 * Create a task — the compose screen from the new design.
 *
 * Header (Cancel / title / Create), task title, optional description, due date,
 * priority (Low/Medium/High), and where to file it (Inbox/Project/Meeting).
 * Writes through the existing tasks API (Convex).
 */
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { createTask } from "./api";
import type { TaskPriority } from "../types";
import { Segmented } from "../ui/primitives";
import { GradientButton } from "../ui/components";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";
import { spacing, radius } from "../ui/theme";

type AddTo = "inbox" | "project" | "meeting";

export function CreateTaskScreen({
  onCancel,
  onCreated,
  onError,
}: {
  onCancel: () => void;
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [addTo, setAddTo] = useState<AddTo>("inbox");
  const [saving, setSaving] = useState(false);

  const canCreate = title.trim().length > 0 && !saving;

  async function submit() {
    if (!canCreate) return;
    setSaving(true);
    try {
      await createTask({ title: title.trim(), notes: notes.trim() || undefined, priority });
      onCreated();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not create the task");
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.screen}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button">
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.headerTitle}>Create a task</Text>
          <Pressable onPress={submit} disabled={!canCreate} hitSlop={8} accessibilityRole="button">
            <Text style={[styles.create, !canCreate && styles.createDisabled]}>Create</Text>
          </Pressable>
        </View>

        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>Task title</Text>
            <TextInput
              style={styles.input}
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Send revised proposal"
              placeholderTextColor={palette.textMuted}
              autoFocus
            />

            <Text style={styles.label}>Description (optional)</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Add any details…"
              placeholderTextColor={palette.textMuted}
              multiline
            />

            <Text style={styles.label}>Priority</Text>
            <Segmented<TaskPriority>
              value={priority}
              onChange={setPriority}
              tone="ambient"
              options={[
                { value: "low", label: "Low" },
                { value: "normal", label: "Medium" },
                { value: "high", label: "High" },
              ]}
            />

            <Text style={styles.label}>Add to</Text>
            <View style={styles.addToGroup}>
              {(
                [
                  { key: "inbox", icon: "file-tray-outline", label: "Inbox" },
                  { key: "project", icon: "folder-outline", label: "Project" },
                  { key: "meeting", icon: "people-outline", label: "Meeting" },
                ] as const
              ).map((row, i) => {
                const active = addTo === row.key;
                return (
                  <Pressable
                    key={row.key}
                    onPress={() => setAddTo(row.key)}
                    style={[styles.addToRow, i > 0 && styles.addToDivider]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                  >
                    <View style={[styles.addToCheck, active && { backgroundColor: palette.ambient, borderColor: palette.ambient }]}>
                      {active ? <Ionicons name="checkmark" size={14} color={palette.textInverse} /> : null}
                    </View>
                    <Ionicons name={row.icon} size={18} color={palette.textMuted} />
                    <Text style={styles.addToLabel}>{row.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.spacer} />
            <GradientButton label="Create task" icon="checkmark" onPress={submit} loading={saving} fullWidth />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: palette.background },
    safe: { flex: 1 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    headerTitle: { ...type.title },
    cancel: { ...type.body, color: palette.textMuted },
    create: { ...type.title, color: palette.primary },
    createDisabled: { color: palette.textMuted, opacity: 0.5 },
    scroll: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxxl },
    label: { ...type.label, color: palette.textMuted, marginTop: spacing.md },
    input: {
      ...type.body,
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    multiline: { minHeight: 96, textAlignVertical: "top" },
    addToGroup: {
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.md,
      overflow: "hidden",
    },
    addToRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.lg },
    addToDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
    addToCheck: {
      width: 22,
      height: 22,
      borderRadius: radius.xs,
      borderWidth: 1.5,
      borderColor: palette.borderStrong,
      alignItems: "center",
      justifyContent: "center",
    },
    addToLabel: { ...type.body },
    spacer: { height: spacing.lg },
  });
}
