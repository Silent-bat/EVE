/**
 * Email insights — the triaged inbox view from the new design.
 *
 * Filter pills (All / Important / Follow-up / Other) over a list of email
 * cards, each with sender, subject, EVE's one-line read, and quick actions
 * (Draft response / View email). Emails come from the briefing the app loads;
 * "Important" is urgency-scored, the rest split by a light heuristic.
 */
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "convex/react";

import type { BriefingEmail } from "../types";
import { convex, api } from "../api/convexApi";
import { GradientButton } from "../ui/components";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";
import { spacing, radius } from "../ui/theme";
import { initials, relativeTime } from "../utils/formatters";

type Filter = "all" | "important" | "followup" | "other";
const IMPORTANT_THRESHOLD = 70;

// Categories the mail-sort classifier treats as low-signal. The "Hide noise"
// toggle filters these out.
const NOISE = new Set(["recruiting", "promotion", "social", "newsletter", "notification"]);
const CATEGORY_LABEL: Record<string, string> = {
  action: "Action",
  work: "Work",
  personal: "Personal",
  finance: "Finance",
  recruiting: "Recruiting",
  newsletter: "Newsletter",
  promotion: "Promotion",
  social: "Social",
  notification: "Update",
  other: "Other",
};

/** Tag colours per category, drawn from the theme so both modes read well. */
function categoryColors(palette: any, cat: string): { bg: string; fg: string } {
  if (cat === "action") return { bg: palette.dangerTint, fg: palette.danger };
  if (cat === "work") return { bg: palette.primaryTint, fg: palette.primary };
  if (cat === "personal" || cat === "finance") return { bg: palette.successTint, fg: palette.success };
  return { bg: palette.surfaceMuted, fg: palette.textMuted }; // recruiting/promo/social/etc.
}

/** Pull a clean display name out of a raw "Name <email>" From header. */
function cleanName(raw: string): string {
  const s = (raw || "").trim();
  const match = s.match(/^(.*?)<[^>]+>\s*$/);
  let name = (match ? (match[1] ?? "") : s).trim().replace(/^"(.*)"$/, "$1").trim();
  if (!name && s.includes("@")) name = s.split("@")[0] ?? s;
  return name || s || "Unknown";
}

export function EmailInsightsScreen({
  emails,
  onBack,
  onOpenEmail,
  onDraft,
  onRefreshed,
}: {
  emails: BriefingEmail[];
  onBack: () => void;
  onOpenEmail: (email: BriefingEmail) => void;
  onDraft: (email: BriefingEmail) => void;
  /** Called after a successful on-demand poll so the parent can reload. */
  onRefreshed?: () => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [filter, setFilter] = useState<Filter>("all");
  const [hideNoise, setHideNoise] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Read the inbox reactively from Convex — the drafts the Gmail poller creates
  // (real polled mail with local urgency scores, present even without an AI
  // briefing). useQuery avoids the auth/mount race an imperative fetch hit and
  // auto-updates when a refresh writes new drafts. Falls back to the briefing
  // emails passed in until the query resolves.
  const inboxResult = useQuery(api.briefings.listInboxEmails, {}) as { emails: BriefingEmail[] } | undefined;
  const emailList = inboxResult?.emails?.length ? inboxResult.emails : emails;

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await convex.action(api.gmail.refreshNow, {});
      // useQuery updates automatically once the poll writes new drafts.
      onRefreshed?.();
    } catch {
      // surfaced by the parent's error handling on reload
    } finally {
      setRefreshing(false);
    }
  };

  const shown = useMemo(() => {
    let list = emailList;
    if (hideNoise) list = list.filter((e) => !NOISE.has(e.category ?? ""));
    if (filter === "important") return list.filter((e) => e.urgencyScore >= IMPORTANT_THRESHOLD);
    if (filter === "followup")
      return list.filter((e) => e.urgencyScore < IMPORTANT_THRESHOLD && e.urgencyScore >= 40);
    if (filter === "other") return list.filter((e) => e.urgencyScore < 40);
    return list;
  }, [emailList, filter, hideNoise]);

  // How many low-signal items the toggle would hide — shown on the toggle.
  const noiseCount = useMemo(() => emailList.filter((e) => NOISE.has(e.category ?? "")).length, [emailList]);

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={24} color={palette.text} />
        </Pressable>
        <Text style={styles.title}>Email insights</Text>
        <Pressable onPress={refresh} hitSlop={10} accessibilityRole="button" accessibilityLabel="Refresh emails">
          {refreshing ? (
            <ActivityIndicator size="small" color={palette.primary} />
          ) : (
            <Ionicons name="refresh" size={22} color={palette.text} />
          )}
        </Pressable>
      </View>

      <View style={styles.pills}>
        {(
          [
            { key: "all", label: "All" },
            { key: "important", label: "Important" },
            { key: "followup", label: "Follow-up" },
            { key: "other", label: "Other" },
          ] as const
        ).map((p) => {
          const active = filter === p.key;
          return (
            <Pressable
              key={p.key}
              onPress={() => setFilter(p.key)}
              style={[styles.pill, active && { backgroundColor: palette.primary }]}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.pillText, active && { color: palette.onPrimary }]}>{p.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {noiseCount > 0 ? (
        <Pressable
          onPress={() => setHideNoise((v) => !v)}
          style={[
            styles.noiseToggle,
            hideNoise && { backgroundColor: palette.primaryTint, borderColor: palette.primary },
          ]}
          accessibilityRole="switch"
          accessibilityState={{ checked: hideNoise }}
          accessibilityLabel="Hide low-signal mail (recruiting, promotions, social)"
        >
          <Ionicons
            name={hideNoise ? "eye-off" : "eye-outline"}
            size={15}
            color={hideNoise ? palette.primary : palette.textMuted}
          />
          <Text style={[styles.noiseToggleText, hideNoise && { color: palette.primary }]}>
            {hideNoise ? `Hiding ${noiseCount} low-signal` : `Hide noise (${noiseCount})`}
          </Text>
        </Pressable>
      ) : null}

      <ScrollView contentContainerStyle={styles.list}>
        {inboxResult === undefined && emailList.length === 0 ? (
          <ActivityIndicator style={{ marginTop: spacing.xxl }} color={palette.primary} />
        ) : shown.length === 0 ? (
          <Text style={styles.empty}>Nothing here right now.</Text>
        ) : (
          shown.map((e) => {
            const important = e.urgencyScore >= IMPORTANT_THRESHOLD;
            const name = cleanName(e.senderName || e.senderEmail);
            const preview = e.summary || e.draftReply || "";
            const catCol = e.category ? categoryColors(palette, e.category) : null;
            const catLabel = e.category ? CATEGORY_LABEL[e.category] ?? e.category : "";
            return (
              <Pressable
                key={e.id}
                style={styles.card}
                onPress={() => onOpenEmail(e)}
                accessibilityRole="button"
                accessibilityLabel={`${name}: ${e.subject}`}
              >
                <View style={styles.cardTop}>
                  <View style={[styles.avatar, { backgroundColor: palette.primaryTint }]}>
                    <Text style={[styles.avatarText, { color: palette.primary }]}>{initials(name)}</Text>
                  </View>
                  <View style={styles.headText}>
                    <View style={styles.senderRow}>
                      <Text style={styles.sender} numberOfLines={1}>{name}</Text>
                      {e.receivedAt ? <Text style={styles.time}>{relativeTime(e.receivedAt)}</Text> : null}
                    </View>
                    <Text style={styles.subject} numberOfLines={1}>{e.subject}</Text>
                  </View>
                </View>

                {preview ? <Text style={styles.preview} numberOfLines={2}>{preview}</Text> : null}

                {catCol ? (
                  <View style={[styles.tag, { backgroundColor: catCol.bg }]}>
                    <Text style={[styles.tagText, { color: catCol.fg }]}>{catLabel}</Text>
                  </View>
                ) : important ? (
                  <View style={[styles.tag, { backgroundColor: palette.dangerTint }]}>
                    <Text style={[styles.tagText, { color: palette.danger }]}>Action needed</Text>
                  </View>
                ) : null}
                <View style={styles.footerActions}>
                  <GradientButton label="Draft response" onPress={() => onDraft(e)} fullWidth />
                  <Pressable
                    style={styles.viewBtn}
                    onPress={() => onOpenEmail(e)}
                    accessibilityRole="button"
                    accessibilityLabel="View email"
                  >
                    <Text style={styles.viewBtnText}>View email</Text>
                  </Pressable>
                </View>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: palette.background },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    title: { ...type.title },
    pills: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.md,
    },
    pill: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: palette.surfaceMuted,
    },
    pillText: { ...type.label, color: palette.textMuted },
    noiseToggle: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 6,
      marginHorizontal: spacing.lg,
      marginBottom: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface,
    },
    noiseToggleText: { ...type.label, fontSize: 12, color: palette.textMuted },
    list: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxxl },
    empty: { ...type.bodyMuted, textAlign: "center", marginTop: spacing.xxl },
    card: {
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.lg,
      padding: spacing.md,
      gap: spacing.sm,
    },
    cardTop: { flexDirection: "row", alignItems: "center", gap: spacing.md },
    avatar: { width: 38, height: 38, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
    avatarText: { ...type.label, fontSize: 13 },
    headText: { flex: 1, gap: 1 },
    senderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
    sender: { ...type.title, fontSize: 15, flexShrink: 1 },
    time: { ...type.caption, fontSize: 11, color: palette.textMuted },
    subject: { ...type.body, fontSize: 14, color: palette.text },
    preview: { ...type.caption, color: palette.textMuted, lineHeight: 18 },
    tag: { paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.sm, alignSelf: "flex-start" },
    tagText: { ...type.caption, fontSize: 10, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.3 },
    footerActions: { gap: spacing.sm, marginTop: spacing.xs },
    viewBtn: {
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: palette.border,
    },
    viewBtnText: { ...type.label, fontSize: 13, color: palette.text },
  });
}
