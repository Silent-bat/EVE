/**
 * A task row.
 *
 * The checkbox and the row body are two separate controls sitting side by side
 * rather than a card-wide press: ticking something off is the common action and
 * it must not be possible to open a detail view by accident while doing it.
 */
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";

import { CardShell } from "./CardShell";
import { withAlpha } from "../../gradient";
import { PressableScale } from "../../motion";
import { HIT_SLOP, MIN_TOUCH, radius, spacing, type Tone } from "../../theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../../ThemeContext";
import type { Task, TaskPriority } from "../../../types";

function priorityTone(priority: TaskPriority): Tone {
  switch (priority) {
    case "high":
      return "danger";
    case "low":
      return "neutral";
    default:
      return "info";
  }
}

/**
 * Due dates read in human terms. "Overdue" and "Today" are the only two states
 * that should change what someone does next, so they're the ones that get
 * colour; everything else is quiet text.
 */
function dueLabel(dueAt: string | null, now: number = Date.now()): { text: string; tone: Tone } | null {
  if (!dueAt) return null;
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return null;

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 86400000;
  const days = Math.floor((due - startOfToday.getTime()) / dayMs);

  if (days < 0) return { text: "Overdue", tone: "danger" };
  if (days === 0) return { text: "Today", tone: "warning" };
  if (days === 1) return { text: "Tomorrow", tone: "neutral" };
  if (days <= 7) return { text: `In ${days} days`, tone: "neutral" };
  return {
    text: new Date(due).toLocaleDateString([], { month: "short", day: "numeric" }),
    tone: "neutral",
  };
}

export function TaskCard({
  task,
  onToggle,
  onPress,
  busy = false,
}: {
  task: Task;
  onToggle: () => void;
  onPress?: () => void;
  busy?: boolean;
}) {
  const { palette, toneAccent } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const done = task.status === "done";
  const due = done ? null : dueLabel(task.dueAt);

  const details = (
    <>
      <Text style={[styles.title, done ? styles.titleDone : null]} numberOfLines={2}>
        {task.title}
      </Text>
      {task.notes && !done ? (
        <Text style={styles.notes} numberOfLines={2}>
          {task.notes}
        </Text>
      ) : null}
      {due || task.source === "eve" || task.priority === "high" ? (
        <View style={styles.metaRow}>
          {due ? <Text style={[styles.meta, { color: toneAccent(due.tone) }]}>{due.text}</Text> : null}
          {task.priority === "high" && !done ? (
            <View style={styles.metaGroup}>
              <Ionicons name="flag" size={10} color={toneAccent(priorityTone(task.priority))} />
              <Text style={[styles.meta, { color: toneAccent(priorityTone(task.priority)) }]}>High</Text>
            </View>
          ) : null}
          {task.source === "eve" ? (
            <View style={styles.metaGroup}>
              <Ionicons name="sparkles" size={10} color={palette.ambient} />
              <Text style={[styles.meta, { color: palette.ambient }]}>From EVE</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </>
  );

  return (
    <CardShell style={[styles.card, done ? styles.cardDone : null]}>
      <View style={styles.row}>
        <PressableScale
          onPress={onToggle}
          disabled={busy}
          hitSlop={HIT_SLOP}
          scaleTo={0.85}
          accessibilityRole="checkbox"
          accessibilityLabel={task.title}
          accessibilityState={{ checked: done, disabled: busy }}
          accessibilityHint={done ? "Marks this task as not done" : "Marks this task done"}
          style={styles.checkTarget}
        >
          <View
            style={[
              styles.check,
              done
                ? { backgroundColor: palette.success, borderColor: palette.success }
                : { borderColor: palette.borderStrong },
            ]}
          >
            {done ? <Ionicons name="checkmark" size={15} color={palette.textInverse} /> : null}
          </View>
        </PressableScale>

        {onPress ? (
          <PressableScale
            onPress={onPress}
            scaleTo={0.99}
            accessible
            accessibilityRole="button"
            accessibilityLabel={`Open task: ${task.title}`}
            style={styles.details}
          >
            {details}
          </PressableScale>
        ) : (
          <View style={styles.details}>{details}</View>
        )}
      </View>
    </CardShell>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    card: { gap: 0, paddingVertical: spacing.md },
    // Completed tasks stay visible but stop competing for attention.
    cardDone: { backgroundColor: palette.surfaceMuted, opacity: 0.75 },
    row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
    checkTarget: {
      width: MIN_TOUCH - 8,
      height: MIN_TOUCH - 8,
      alignItems: "center",
      justifyContent: "center",
      marginLeft: -6,
    },
    check: {
      width: 22,
      height: 22,
      borderRadius: radius.xs,
      borderWidth: 2,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: withAlpha(palette.surface, 0),
    },
    details: { flex: 1, gap: 3, paddingTop: 6 },
    title: { ...type.body, fontWeight: "600" },
    titleDone: { textDecorationLine: "line-through", color: palette.textMuted },
    notes: { ...type.caption, fontWeight: "500" },
    metaRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, flexWrap: "wrap" },
    metaGroup: { flexDirection: "row", alignItems: "center", gap: 3 },
    meta: { fontSize: 11, fontWeight: "700" },
  });
}
