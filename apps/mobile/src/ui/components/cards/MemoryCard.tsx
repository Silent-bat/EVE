/**
 * Memory cards — what EVE knows about the person she works for.
 *
 * This section is the product's trust surface. Everything EVE infers about
 * someone's role, projects, and relationships shapes how she writes on their
 * behalf, so it's shown plainly and every field is editable. A field she has no
 * value for is rendered as an invitation rather than hidden, because the gap is
 * itself information: it's why a draft came out generic.
 */
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";

import { CardShell } from "./CardShell";
import { PressableScale } from "../../motion";
import { HIT_SLOP, radius, spacing } from "../../theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../../ThemeContext";
import type { UserProfile } from "../../../types";

type IoniconName = keyof typeof Ionicons.glyphMap;

export type MemoryField = {
  key: keyof UserProfile;
  label: string;
  icon: IoniconName;
  /** Shown when the field is empty. Phrased as what EVE would gain by knowing. */
  prompt: string;
};

/**
 * Presentation for each profile field, in the order they're shown. Ordered by
 * how much each one changes EVE's output: role and industry set the register of
 * every reply, while goals mostly affect what she volunteers.
 */
export const MEMORY_FIELDS: MemoryField[] = [
  {
    key: "role",
    label: "Role",
    icon: "person-outline",
    prompt: "What you do — so replies carry the right authority",
  },
  {
    key: "industry",
    label: "Industry",
    icon: "business-outline",
    prompt: "Your field — so EVE uses the right vocabulary",
  },
  {
    key: "currentProjects",
    label: "Current projects",
    icon: "layers-outline",
    prompt: "What you're working on — so EVE spots what's relevant",
  },
  {
    key: "keyRelationships",
    label: "Key people",
    icon: "people-outline",
    prompt: "Who matters most — so their mail rises to the top",
  },
  {
    key: "goals",
    label: "Goals",
    icon: "flag-outline",
    prompt: "What you're aiming at — so suggestions point somewhere",
  },
  {
    key: "communicationStyle",
    label: "Tone",
    icon: "chatbubble-ellipses-outline",
    prompt: "How you like to sound — so drafts read as yours",
  },
];

export function MemoryCard({
  field,
  value,
  onEdit,
}: {
  field: MemoryField;
  value: string;
  onEdit?: () => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const filled = value.trim().length > 0;

  return (
    <CardShell
      onPress={onEdit}
      accessibilityLabel={filled ? `${field.label}: ${value}` : `${field.label}, not set. ${field.prompt}`}
      accessibilityHint={onEdit ? `Edits ${field.label.toLowerCase()}` : undefined}
      style={styles.card}
    >
      <View style={styles.header}>
        <View style={[styles.icon, filled ? { backgroundColor: palette.ambientTint } : null]}>
          <Ionicons name={field.icon} size={15} color={filled ? palette.ambient : palette.textMuted} />
        </View>
        <Text style={styles.label}>{field.label}</Text>
        {onEdit ? <Ionicons name="pencil-outline" size={14} color={palette.textMuted} /> : null}
      </View>

      <Text style={filled ? styles.value : styles.prompt} numberOfLines={filled ? 4 : 2}>
        {filled ? value : field.prompt}
      </Text>
    </CardShell>
  );
}

/**
 * Header for the memory section: how complete the profile is, and a way in.
 *
 * The count is the honest version of a progress bar — "4 of 6" tells someone
 * there's something left to do without pretending the profile has a score.
 */
export function MemorySummary({ profile, onManage }: { profile: UserProfile; onManage?: () => void }) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const filled = MEMORY_FIELDS.filter((f) => (profile[f.key] ?? "").trim().length > 0).length;

  return (
    <CardShell tinted style={styles.summary}>
      <View style={styles.summaryRow}>
        <View style={[styles.icon, { backgroundColor: palette.surface }]}>
          <Ionicons name="bookmark-outline" size={15} color={palette.ambient} />
        </View>
        <View style={styles.summaryText}>
          <Text style={styles.label}>What EVE knows</Text>
          <Text style={styles.prompt}>
            {filled} of {MEMORY_FIELDS.length} details filled in
          </Text>
        </View>
        {onManage ? (
          <PressableScale
            onPress={onManage}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel="Manage what EVE knows"
            style={[styles.manage, { borderColor: palette.ambient }]}
          >
            <Text style={[styles.manageText, { color: palette.ambient }]}>Manage</Text>
          </PressableScale>
        ) : null}
      </View>
    </CardShell>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    card: { gap: spacing.sm },
    header: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    icon: {
      width: 28,
      height: 28,
      borderRadius: radius.pill,
      backgroundColor: palette.surfaceMuted,
      alignItems: "center",
      justifyContent: "center",
    },
    label: { ...type.label, flex: 1 },
    value: { ...type.body },
    // Empty fields are italic and muted, so a glance separates "EVE knows this"
    // from "EVE is asking".
    prompt: { ...type.bodyMuted, fontStyle: "italic" },
    summary: { gap: 0 },
    summaryRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
    summaryText: { flex: 1, gap: 2 },
    manage: {
      borderWidth: 1,
      borderRadius: radius.pill,
      paddingVertical: 7,
      paddingHorizontal: spacing.md,
    },
    manageText: { fontSize: 12, fontWeight: "800" },
  });
}
