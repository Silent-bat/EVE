/**
 * What EVE knows about you — the structured context the backend splices into
 * the ranking prompt, so a note from your lead investor outranks a receipt.
 *
 * Guidance lives in a hint line under each box rather than inside the
 * placeholder. Android renders a multiline placeholder on one line and clips
 * the rest, so anything longer than a few words was being cut mid-sentence —
 * and a hint you can still read while typing is more useful anyway.
 */
import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import type { UserProfile } from "../../types";
import type { ProfileState } from "../../profile/useProfile";
import { LoadingState } from "../../ui/components";
import { radius, spacing } from "../../ui/theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../../ui/ThemeContext";
import { SettingsPage } from "../PageShell";

type FieldSpec = {
  key: keyof UserProfile;
  label: string;
  placeholder: string;
  hint: string;
  multiline?: boolean;
};

type GroupSpec = { title: string; fields: FieldSpec[] };

const GROUPS: GroupSpec[] = [
  {
    title: "Who you are",
    fields: [
      {
        key: "role",
        label: "Role",
        placeholder: "Founder & CEO",
        hint: "Title and company. EVE uses it to judge who outranks whom in your inbox.",
      },
      {
        key: "industry",
        label: "Industry",
        placeholder: "B2B SaaS",
        hint: "Sets the vocabulary EVE reads your mail against.",
      },
    ],
  },
  {
    title: "What matters right now",
    fields: [
      {
        key: "goals",
        label: "Current goals",
        placeholder: "What you're pushing toward",
        hint: "A few, comma separated. Mail that moves one of these gets ranked up.",
        multiline: true,
      },
      {
        key: "currentProjects",
        label: "Active projects",
        placeholder: "What you're working on",
        hint: "Name them the way your colleagues do, so EVE recognises them in a subject line.",
        multiline: true,
      },
      {
        key: "keyRelationships",
        label: "Key people",
        placeholder: "Who you can't miss",
        hint: "Names, and why they matter — \"Sarah, lead investor\". Their mail jumps the queue.",
        multiline: true,
      },
    ],
  },
  {
    title: "How EVE writes",
    fields: [
      {
        key: "communicationStyle",
        label: "Tone",
        placeholder: "Warm and concise",
        hint: "Drafts EVE prepares for you are written this way.",
      },
    ],
  },
];

export function ProfilePage({ state, onBack }: { state: ProfileState; onBack: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const { profile, loading, saving, save } = state;

  if (loading || !profile) {
    return (
      <SettingsPage title="What EVE knows" onBack={onBack}>
        <LoadingState label="Loading your profile" cards={2} />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="What EVE knows"
      onBack={onBack}
      intro="The more of this you fill in, the better EVE ranks your mail. Nothing here is required, and it saves as you go."
    >
      {GROUPS.map((group) => (
        <View key={group.title} style={styles.group}>
          <Text style={styles.groupTitle}>{group.title}</Text>
          <View style={styles.card}>
            {group.fields.map((field, index) => (
              <View key={field.key}>
                {index > 0 ? <View style={styles.divider} /> : null}
                <Field
                  spec={field}
                  value={profile[field.key] ?? ""}
                  onCommit={(next) => void save({ [field.key]: next })}
                />
              </View>
            ))}
          </View>
        </View>
      ))}

      <Text style={styles.saveNote} accessibilityLiveRegion="polite">
        {saving ? "Saving…" : "Saved automatically"}
      </Text>
    </SettingsPage>
  );
}

/**
 * Commits on blur, and only when the text actually changed — tapping through
 * six fields to reach the last one shouldn't fire six writes.
 */
function Field({
  spec,
  value,
  onCommit,
}: {
  spec: FieldSpec;
  value: string;
  onCommit: (next: string) => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);

  useEffect(() => setDraft(value), [value]);

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{spec.label}</Text>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onEndEditing={() => {
          const next = draft.trim();
          if (next !== value) onCommit(next);
        }}
        placeholder={spec.placeholder}
        placeholderTextColor={palette.textMuted}
        multiline={spec.multiline}
        style={[
          styles.input,
          spec.multiline ? styles.inputMultiline : null,
          focused ? { borderColor: palette.ambient } : null,
        ]}
        accessibilityLabel={spec.label}
        accessibilityHint={spec.hint}
      />
      <Text style={styles.hint}>{spec.hint}</Text>
    </View>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    group: { marginTop: spacing.xxl },
    groupTitle: {
      ...type.caption,
      fontSize: 12,
      fontWeight: "800",
      letterSpacing: 0.6,
      textTransform: "uppercase",
      marginBottom: spacing.md,
      paddingHorizontal: spacing.xs,
    },
    card: {
      backgroundColor: palette.surface,
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: palette.border,
      overflow: "hidden",
    },
    divider: { height: 1, backgroundColor: palette.border },
    field: { padding: spacing.lg, gap: spacing.xs },
    label: { ...type.label, fontSize: 14 },
    input: {
      ...type.body,
      minHeight: 44,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.md,
      backgroundColor: palette.surfaceMuted,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      color: palette.text,
    },
    // Room for two or three items without the box growing under the finger.
    inputMultiline: { minHeight: 76, textAlignVertical: "top" },
    hint: { ...type.caption, fontSize: 12, lineHeight: 16 },
    saveNote: {
      ...type.caption,
      marginTop: spacing.lg,
      textAlign: "center",
      fontStyle: "italic",
    },
  });
}
