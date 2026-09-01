/**
 * Activity — the receipt log, and the place EVE's promise is checkable.
 *
 * The promise is that she never sends mail you didn't approve. Checking it takes
 * more than a list of subjects, so each row now states three things the old one
 * flattened into "Approved reply": what you decided, whether the mail actually
 * left, and what EVE had written. A send that failed says so — previously it
 * looked identical to a delivered one, which is the one lie this screen must
 * not tell.
 *
 * Rows expand rather than navigate. The draft body is the evidence, and it
 * belongs under the entry it explains, not on a page behind it.
 */
import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { AuditEntry } from "../types";
import { formatTime } from "../utils/formatters";
import { CardShell, EmptyState, Section } from "../ui/components";
import { withAlpha } from "../ui/gradient";
import { PressableScale } from "../ui/motion";
import { Chip } from "../ui/primitives";
import { radius, spacing, type Tone } from "../ui/theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";

type Filter = "all" | "sent" | "rejected" | "failed";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "sent", label: "Sent" },
  { value: "rejected", label: "Rejected" },
  { value: "failed", label: "Needs a look" },
];

type Props = { audit: AuditEntry[] };

export function AuditTab({ audit }: Props) {
  const styles = useThemedStyles(makeStyles);
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(() => tally(audit), [audit]);
  const shown = useMemo(
    () => (filter === "all" ? audit : audit.filter((entry) => bucket(entry) === filter)),
    [audit, filter],
  );
  const groups = useMemo(() => groupByDay(shown), [shown]);

  if (audit.length === 0) {
    return (
      <Section title="Activity" icon="receipt-outline">
        <EmptyState
          icon="receipt-outline"
          title="Nothing to show yet"
          body="Every reply you approve or reject is recorded here, so you can always check what EVE sent on your behalf."
        />
      </Section>
    );
  }

  return (
    <View>
      <View style={styles.summary}>
        <Tally label="Sent" value={counts.sent} tone="success" />
        <Tally label="Rejected" value={counts.rejected} tone="neutral" />
        {/* Only shown when there is one. A permanent zero would read as a
            warning light that never goes off. */}
        {counts.failed > 0 ? <Tally label="Failed" value={counts.failed} tone="danger" /> : null}
      </View>

      {/* Filters only earn their space once the log is long enough to scroll. */}
      {audit.length > 4 ? (
        <View style={styles.filters} accessibilityRole="tablist">
          {FILTERS.map((option) => {
            const active = filter === option.value;
            return (
              <PressableScale
                key={option.value}
                onPress={() => setFilter(option.value)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${option.label} entries`}
              >
                <Chip label={option.label} tone={active ? "ambient" : "neutral"} compact />
              </PressableScale>
            );
          })}
        </View>
      ) : null}

      {groups.length === 0 ? (
        <EmptyState
          icon="funnel-outline"
          title="Nothing under that filter"
          body="Try All to see the whole log."
          action={{ label: "Show all", onPress: () => setFilter("all") }}
        />
      ) : (
        groups.map((group) => (
          <Section key={group.label} title={group.label} count={group.entries.length}>
            {group.entries.map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))}
          </Section>
        ))
      )}
    </View>
  );
}

function Tally({ label, value, tone }: { label: string; value: number; tone: Tone }) {
  const { toneInk } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.tally} accessibilityLabel={`${value} ${label}`}>
      <Text style={[styles.tallyValue, { color: toneInk(tone) }]}>{value}</Text>
      <Text style={styles.tallyLabel}>{label}</Text>
    </View>
  );
}

/**
 * One receipt. Collapsed it answers "what happened"; expanded it shows the text
 * that was actually on offer, which is the part worth auditing.
 */
function AuditRow({ entry }: { entry: AuditEntry }) {
  const { palette, toneInk } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);

  const state = describe(entry);
  const ink = toneInk(state.tone);
  const body = (entry.after ?? entry.before ?? "").trim();
  const expandable = body.length > 0;

  return (
    <CardShell
      // The stripe carries the outcome, so a failed send is visible while
      // scrolling rather than only on the line that names it.
      accent={state.tone === "neutral" ? undefined : ink}
      onPress={expandable ? () => setOpen((current) => !current) : undefined}
      accessibilityLabel={`${state.title}. ${entry.subject}. ${formatTime(entry.createdAt)}`}
      accessibilityHint={expandable ? (open ? "Hides the draft" : "Shows the draft") : undefined}
      style={styles.card}
    >
      <View style={styles.head}>
        <View style={[styles.icon, { backgroundColor: withAlpha(ink, 0.13) }]}>
          <Ionicons name={state.icon} size={16} color={ink} />
        </View>

        <View style={styles.body}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, { color: ink }]}>{state.title}</Text>
            <Text style={styles.time}>{formatTime(entry.createdAt)}</Text>
          </View>
          <Text style={styles.subject} numberOfLines={2}>
            {entry.subject}
          </Text>
          <Text style={styles.note}>{state.note}</Text>
        </View>

        {expandable ? (
          <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={palette.textMuted} />
        ) : null}
      </View>

      {open && expandable ? (
        <View style={styles.draft}>
          <Text style={styles.draftLabel}>
            {entry.action === "approve" ? "What EVE sent" : "What EVE had drafted"}
          </Text>
          <Text style={styles.draftBody}>{body}</Text>
        </View>
      ) : null}
    </CardShell>
  );
}

/**
 * What a row says about itself.
 *
 * `deliveryStatus` is the field that matters and the one the old screen dropped:
 * an approval whose Gmail send threw is not a sent mail, and "audit-only" means
 * the account has no Google connection so nothing was ever going to leave.
 */
function describe(entry: AuditEntry): {
  title: string;
  note: string;
  tone: Tone;
  icon: keyof typeof Ionicons.glyphMap;
} {
  if (entry.action === "reject") {
    return {
      title: "Rejected",
      note: "Nothing was sent.",
      tone: "neutral",
      icon: "close-outline",
    };
  }

  switch (entry.deliveryStatus) {
    case "sent":
      return {
        title: "Sent",
        note: "You approved it and Gmail delivered it.",
        tone: "success",
        icon: "checkmark-outline",
      };
    case "send-failed":
      return {
        title: "Send failed",
        note: "You approved it, but Gmail refused it. It never left.",
        tone: "danger",
        icon: "alert-outline",
      };
    case "audit-only":
      return {
        title: "Approved, not sent",
        note: "Recorded only — no Gmail connection to send through.",
        tone: "warning",
        icon: "archive-outline",
      };
    default:
      return {
        title: "Approved",
        note: "Recorded here.",
        tone: "success",
        icon: "checkmark-outline",
      };
  }
}

/** Which filter an entry belongs under. Never "all" — that one matches everything. */
function bucket(entry: AuditEntry): Exclude<Filter, "all"> {
  if (entry.action === "reject") return "rejected";
  if (entry.deliveryStatus === "send-failed") return "failed";
  return "sent";
}

function tally(entries: AuditEntry[]): { sent: number; rejected: number; failed: number } {
  const counts = { sent: 0, rejected: 0, failed: 0 };
  for (const entry of entries) counts[bucket(entry)] += 1;
  return counts;
}

/**
 * Buckets entries into Today / Yesterday / a date. The list arrives newest
 * first and stays that way — the ordering is the point of a log.
 */
function groupByDay(entries: AuditEntry[]): { label: string; entries: AuditEntry[] }[] {
  const groups: { label: string; entries: AuditEntry[] }[] = [];

  for (const entry of entries) {
    const label = dayLabel(entry.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }

  return groups;
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Earlier";

  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOf(new Date());
  const dayMs = 86_400_000;
  const delta = today - startOf(date);

  if (delta === 0) return "Today";
  if (delta === dayMs) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    summary: {
      flexDirection: "row",
      gap: spacing.sm,
      marginBottom: spacing.lg,
    },
    tally: {
      flex: 1,
      alignItems: "center",
      gap: 2,
      paddingVertical: spacing.md,
      borderRadius: radius.lg,
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.border,
    },
    tallyValue: { ...type.title, fontSize: 22, fontVariant: ["tabular-nums"] },
    tallyLabel: { ...type.caption, fontSize: 12 },
    filters: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing.xs,
      marginBottom: spacing.md,
    },
    card: { gap: spacing.sm },
    head: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
    icon: {
      width: 32,
      height: 32,
      borderRadius: radius.pill,
      alignItems: "center",
      justifyContent: "center",
    },
    body: { flex: 1, gap: 2 },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.sm,
    },
    title: { ...type.label },
    subject: { ...type.body },
    note: { ...type.caption, fontSize: 12 },
    time: { ...type.caption, fontVariant: ["tabular-nums"] },
    draft: {
      gap: spacing.xs,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: palette.surfaceMuted,
      borderWidth: 1,
      borderColor: palette.border,
    },
    draftLabel: { ...type.caption, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 },
    draftBody: { ...type.body, color: palette.text },
  });
}
