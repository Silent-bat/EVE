/**
 * Proactive agent — the permission ladder, one rung per group.
 *
 *   1. Master switch                — the coarse off-switch
 *   2. Quiet hours + frequency caps — global guardrails
 *   3. One row per category         — what each kind of thought may do
 *
 * The old version expanded every category inline, so five cards each carrying
 * two segmented controls stacked into a wall you had to scroll past to reach
 * anything else. Each category is now a row that states its current rule
 * ("High · Push") and opens its own page. Same three decisions per category,
 * but you only see the one you came for.
 */
import { StyleSheet, Text, View } from "react-native";

import type {
  ProactiveCategoryName,
  ProactiveDeliveryMode,
  ProactivePreferences,
  ProactiveUrgency,
} from "../../types";
import { CATEGORY_META, PROACTIVE_CATEGORY_ORDER } from "../../proactive/categories";
import type { ProactivePrefsState } from "../../proactive/useProactivePrefs";
import { LoadingState } from "../../ui/components";
import { Segmented } from "../../ui/primitives";
import { spacing } from "../../ui/theme";
import { useThemedStyles, type ThemeValue } from "../../ui/ThemeContext";
import { Stepper, TimeField } from "../fields";
import { SettingsPage } from "../PageShell";
import { SettingsGroup, SettingsRowItem, SettingsSwitch } from "../rows";

const URGENCY_OPTIONS: { value: ProactiveUrgency; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

const DELIVERY_OPTIONS: { value: ProactiveDeliveryMode; label: string }[] = [
  { value: "silent", label: "Silent" },
  { value: "soft", label: "Soft" },
  { value: "push", label: "Push" },
];

export function ProactivePage({
  state,
  onBack,
  onOpenCategory,
}: {
  state: ProactivePrefsState;
  onBack: () => void;
  onOpenCategory: (name: ProactiveCategoryName) => void;
}) {
  const { prefs, loading, patch } = state;

  if (loading || !prefs) {
    return (
      <SettingsPage title="Proactive agent" onBack={onBack}>
        <LoadingState label="Loading your rules" cards={2} />
      </SettingsPage>
    );
  }

  const set = (next: Partial<ProactivePreferences>) => void patch(next, { ...prefs, ...next });

  return (
    <SettingsPage
      title="Proactive agent"
      onBack={onBack}
      intro="EVE watches your mail and calendar and forms thoughts either way. These rules decide which of them are allowed to reach you."
    >
      <SettingsGroup footer="With this off, thoughts still collect on Today — EVE just never interrupts you with one.">
        <SettingsRowItem
          icon="planet-outline"
          tone="ambient"
          title="Let EVE reach out"
          control={
            <SettingsSwitch
              value={prefs.enabled}
              onChange={(enabled) => set({ enabled })}
              label="Let EVE reach out"
            />
          }
        />
      </SettingsGroup>

      {prefs.enabled ? (
        <>
          <SettingsGroup
            title="Guardrails"
            footer="Quiet hours hold everything except critical thoughts. Caps are a hard ceiling; critical bypasses them."
          >
            <SettingsRowItem
              icon="moon-outline"
              tone="info"
              title="Quiet hours"
              control={
                <QuietHours
                  start={prefs.quietHoursStart}
                  end={prefs.quietHoursEnd}
                  onChangeStart={(quietHoursStart) => set({ quietHoursStart })}
                  onChangeEnd={(quietHoursEnd) => set({ quietHoursEnd })}
                />
              }
            />
            <SettingsRowItem
              icon="speedometer-outline"
              tone="warning"
              title="Most per hour"
              control={
                <Stepper
                  value={prefs.maxPushesPerHour}
                  onChange={(maxPushesPerHour) => set({ maxPushesPerHour })}
                  label="Most per hour"
                  max={20}
                />
              }
            />
            <SettingsRowItem
              icon="calendar-outline"
              tone="warning"
              title="Most per day"
              control={
                <Stepper
                  value={prefs.maxPushesPerDay}
                  onChange={(maxPushesPerDay) => set({ maxPushesPerDay })}
                  label="Most per day"
                  max={50}
                />
              }
            />
          </SettingsGroup>

          <SettingsGroup title="What EVE may raise" footer="Each kind decides for itself.">
            {PROACTIVE_CATEGORY_ORDER.map((name) => {
              const meta = CATEGORY_META[name];
              const cat = prefs.categories[name];
              return (
                <SettingsRowItem
                  key={name}
                  icon={meta.icon}
                  tone={meta.tone}
                  title={meta.label}
                  value={cat.enabled ? describeRule(cat.threshold, cat.deliveryMode) : "Off"}
                  onPress={() => onOpenCategory(name)}
                />
              );
            })}
          </SettingsGroup>
        </>
      ) : null}
    </SettingsPage>
  );
}

/**
 * One category's three decisions, on their own page so each segmented control
 * gets the full width — four urgency labels split across half a card was where
 * "Critical" used to render as "Cri / t".
 */
export function ProactiveCategoryPage({
  name,
  state,
  onBack,
}: {
  name: ProactiveCategoryName;
  state: ProactivePrefsState;
  onBack: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { prefs, patch } = state;
  const meta = CATEGORY_META[name];

  if (!prefs) {
    return (
      <SettingsPage title={meta.label} onBack={onBack}>
        <LoadingState label="Loading" cards={1} />
      </SettingsPage>
    );
  }

  const cat = prefs.categories[name];
  const update = (patchCat: Partial<typeof cat>) => {
    const categories = { ...prefs.categories, [name]: { ...cat, ...patchCat } };
    void patch({ categories }, { ...prefs, categories });
  };

  return (
    <SettingsPage title={meta.label} onBack={onBack} intro={meta.description}>
      <SettingsGroup>
        <SettingsRowItem
          icon={meta.icon}
          tone={meta.tone}
          title="Raise these with me"
          control={
            <SettingsSwitch
              value={cat.enabled}
              onChange={(enabled) => update({ enabled })}
              label={`${meta.label}, raise these with me`}
            />
          }
        />
      </SettingsGroup>

      {cat.enabled ? (
        <>
          <SettingsGroup
            title="How urgent, at least"
            footer={thresholdHint(cat.threshold)}
          >
            <View style={styles.controlRow}>
              <Segmented
                tone="ambient"
                value={cat.threshold}
                onChange={(threshold) => update({ threshold })}
                options={URGENCY_OPTIONS}
                label="Urgency threshold"
              />
            </View>
          </SettingsGroup>

          <SettingsGroup title="How it arrives" footer={deliveryHint(cat.deliveryMode)}>
            <View style={styles.controlRow}>
              <Segmented
                tone="ambient"
                value={cat.deliveryMode}
                onChange={(deliveryMode) => update({ deliveryMode })}
                options={DELIVERY_OPTIONS}
                label="Delivery"
              />
            </View>
          </SettingsGroup>
        </>
      ) : (
        <Text style={styles.offNote}>
          {meta.label} thoughts still collect on Today. Turn this on to have EVE bring them
          to you.
        </Text>
      )}
    </SettingsPage>
  );
}

function QuietHours({
  start,
  end,
  onChangeStart,
  onChangeEnd,
}: {
  start: string;
  end: string;
  onChangeStart: (next: string) => void;
  onChangeEnd: (next: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.quietRow}>
      <TimeField value={start} onChange={onChangeStart} label="Quiet hours start" width={58} />
      <Text style={styles.quietArrow}>→</Text>
      <TimeField value={end} onChange={onChangeEnd} label="Quiet hours end" width={58} />
    </View>
  );
}

/** "High · Push" — the whole rule in the width an index row has for it. */
function describeRule(threshold: ProactiveUrgency, delivery: ProactiveDeliveryMode): string {
  const t = URGENCY_OPTIONS.find((o) => o.value === threshold)?.label ?? threshold;
  const d = DELIVERY_OPTIONS.find((o) => o.value === delivery)?.label ?? delivery;
  return `${t} · ${d}`;
}

// The footers say what the choice *does*, because "medium" on its own is a
// word, not a rule.
function thresholdHint(threshold: ProactiveUrgency): string {
  switch (threshold) {
    case "low":
      return "Anything at all, including passing observations.";
    case "medium":
      return "Skips small talk. Roughly a few a day.";
    case "high":
      return "Only things worth stopping for.";
    case "critical":
      return "Emergencies only. Ignores quiet hours and caps.";
  }
}

function deliveryHint(mode: ProactiveDeliveryMode): string {
  switch (mode) {
    case "silent":
      return "Waits on Today. Nothing on your lock screen.";
    case "soft":
      return "A badge, no sound.";
    case "push":
      return "A full notification, sound included.";
  }
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    // Segmented controls sit in the card without a row's icon inset, so they
    // get the whole width — the reason these moved to their own page.
    controlRow: { padding: spacing.md },
    quietRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
    quietArrow: { ...type.caption, color: palette.textMuted, fontWeight: "800" },
    offNote: {
      ...type.caption,
      lineHeight: 19,
      marginTop: spacing.xl,
      paddingHorizontal: spacing.xs,
    },
  });
}
