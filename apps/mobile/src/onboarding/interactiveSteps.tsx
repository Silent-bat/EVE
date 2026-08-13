/**
 * The three steps that actually do something: connect Google, set the two
 * preferences that shape the daily brief, and confirm.
 */
import { Ionicons } from "@expo/vector-icons";
import { Pressable, Switch, Text, View } from "react-native";

import { ErrorBanner } from "../ui/primitives";
import { FadeSlideIn } from "../ui/motion";
import { HIT_SLOP } from "../ui/theme";
import { useTheme } from "../ui/ThemeContext";
import { Eyebrow, FeatureRow, PrimaryAction, SecondaryAction } from "./chrome";
import { useEntryStyles } from "./styles";

// -------------------------------------------------------------- connect

/**
 * The one step that can't be skipped — without a Google connection there is no
 * mail to brief on.
 *
 * Connecting leaves the app for a browser, so this screen has to make sense in
 * three states: before, waiting for the round trip, and after. The connected
 * state names the account rather than just saying "done", because signing in
 * with the wrong Google account is an easy mistake and an annoying one to
 * discover two screens later.
 */
export function ConnectStep({
  connected,
  email,
  saving,
  apiError,
  reconnect = false,
  onConnect,
  onRetry,
  onDismissError,
}: {
  connected: boolean;
  email: string | null;
  saving: boolean;
  apiError: string | null;
  /** Copy variant for an account that was connected and has since lapsed. */
  reconnect?: boolean;
  onConnect: () => void;
  onRetry: () => void;
  onDismissError: () => void;
}) {
  const { palette, toneSurface, toneInk } = useTheme();
  const styles = useEntryStyles();

  if (connected) {
    return (
      <View style={{ gap: 18 }}>
        <FadeSlideIn>
          <View style={[styles.featureIcon, { backgroundColor: toneSurface("success") }]}>
            <Ionicons name="checkmark" size={22} color={toneInk("success")} />
          </View>
        </FadeSlideIn>
        <FadeSlideIn delay={70}>
          <Eyebrow>Connected</Eyebrow>
        </FadeSlideIn>
        <FadeSlideIn delay={130}>
          <Text style={styles.heading} accessibilityRole="header">
            Google is connected.
          </Text>
        </FadeSlideIn>
        <FadeSlideIn delay={190}>
          <Text style={styles.lead}>
            {email ? `EVE is reading mail for ${email}.` : "EVE can now read your mail and draft replies."}
          </Text>
        </FadeSlideIn>
        {apiError ? <ErrorBanner message={apiError} onDismiss={onDismissError} /> : null}
      </View>
    );
  }

  return (
    <View style={{ gap: 18 }}>
      <FadeSlideIn>
        <Eyebrow>{reconnect ? "Access expired" : "One step left"}</Eyebrow>
      </FadeSlideIn>
      <FadeSlideIn delay={70}>
        <Text style={styles.heading} accessibilityRole="header">
          {reconnect ? "EVE needs access to your mail again." : "Connect your Google account."}
        </Text>
      </FadeSlideIn>
      <FadeSlideIn delay={130}>
        <Text style={styles.lead}>
          {reconnect
            ? "Google's permission for EVE has lapsed or was revoked, so briefings have stopped. Signing in again picks up exactly where you left off — nothing was lost."
            : "This opens Google's own sign-in page. EVE never sees your password — Google hands back a token you can revoke at any time."}
        </Text>
      </FadeSlideIn>

      {apiError ? (
        <FadeSlideIn>
          <ErrorBanner message={apiError} onDismiss={onDismissError} onRetry={onRetry} />
        </FadeSlideIn>
      ) : null}

      <FadeSlideIn delay={200}>
        <PrimaryAction
          label={saving ? "Opening Google" : reconnect ? "Reconnect Google" : "Connect Google"}
          icon="logo-google"
          busy={saving}
          onPress={onConnect}
        />
      </FadeSlideIn>

      <FadeSlideIn delay={260}>
        <View style={styles.featureRow}>
          <Ionicons name="lock-closed-outline" size={15} color={palette.textMuted} />
          <Text style={[styles.bodyMuted, { flex: 1 }]}>
            You'll come back here automatically once Google is done.
          </Text>
        </View>
      </FadeSlideIn>
    </View>
  );
}

// ----------------------------------------------------------- personalize

/**
 * Times offered as one-tap choices. The Settings tab takes an arbitrary value;
 * asking a brand-new user to type "07:30" into a text field on their first run
 * is friction for no gain, so the common window is offered as chips.
 */
const BRIEFING_TIMES = ["06:30", "07:00", "07:30", "08:00", "08:30", "09:00"];

export function PersonalizeStep({
  briefingTime,
  pushEnabled,
  onChangeBriefingTime,
  onChangePushEnabled,
}: {
  briefingTime: string;
  pushEnabled: boolean;
  onChangeBriefingTime: (next: string) => void;
  onChangePushEnabled: (next: boolean) => void;
}) {
  const { palette } = useTheme();
  const styles = useEntryStyles();

  return (
    <View style={{ gap: 18 }}>
      <FadeSlideIn>
        <Eyebrow>Personalize</Eyebrow>
      </FadeSlideIn>
      <FadeSlideIn delay={70}>
        <Text style={styles.heading} accessibilityRole="header">
          When should the brief land?
        </Text>
      </FadeSlideIn>
      <FadeSlideIn delay={130}>
        <Text style={styles.lead}>
          EVE prepares it just before this time so it's waiting when you look. Change it whenever you like in
          Settings.
        </Text>
      </FadeSlideIn>

      <FadeSlideIn delay={190}>
        <View style={styles.chipRow} accessibilityRole="radiogroup">
          {BRIEFING_TIMES.map((time) => {
            const active = time === briefingTime;
            return (
              <Pressable
                key={time}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => onChangeBriefingTime(time)}
                accessibilityRole="radio"
                accessibilityLabel={`Briefing at ${time}`}
                accessibilityState={{ selected: active, checked: active }}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{time}</Text>
              </Pressable>
            );
          })}
        </View>
      </FadeSlideIn>

      <FadeSlideIn delay={250}>
        <View style={styles.card}>
          <View style={styles.toggleRow}>
            <View style={styles.featureText}>
              <Text style={styles.featureTitle}>Morning notification</Text>
              <Text style={styles.bodyMuted}>
                A single push when the brief is ready. Nothing else — EVE doesn't ping you all day.
              </Text>
            </View>
            <Switch
              value={pushEnabled}
              onValueChange={onChangePushEnabled}
              hitSlop={HIT_SLOP}
              accessibilityLabel="Morning notification"
              trackColor={{ false: palette.surfaceMuted, true: palette.success }}
              thumbColor={palette.background}
            />
          </View>
        </View>
      </FadeSlideIn>
    </View>
  );
}

// ----------------------------------------------------------------- ready

export function ReadyStep({
  briefingTime,
  pushEnabled,
  email,
  onOpenSettings,
}: {
  briefingTime: string;
  pushEnabled: boolean;
  email: string | null;
  onOpenSettings?: () => void;
}) {
  const { toneSurface, toneInk } = useTheme();
  const styles = useEntryStyles();

  return (
    <View style={{ gap: 18 }}>
      <FadeSlideIn>
        <View style={[styles.featureIcon, { backgroundColor: toneSurface("success") }]}>
          <Ionicons name="sparkles" size={20} color={toneInk("success")} />
        </View>
      </FadeSlideIn>
      <FadeSlideIn delay={70}>
        <Eyebrow>All set</Eyebrow>
      </FadeSlideIn>
      <FadeSlideIn delay={130}>
        <Text style={styles.hero} accessibilityRole="header">
          EVE is watching your inbox.
        </Text>
      </FadeSlideIn>
      <FadeSlideIn delay={190}>
        <Text style={styles.lead}>
          Your first brief is being put together now. From here on it arrives on its own.
        </Text>
      </FadeSlideIn>

      <FadeSlideIn delay={250}>
        <View style={styles.card}>
          <FeatureRow
            icon="mail-outline"
            tone="success"
            title="Account"
            body={email ?? "Your connected Google account"}
          />
          <View style={styles.divider} />
          <FeatureRow
            icon="time-outline"
            tone="info"
            title="Daily brief"
            body={`Ready by ${briefingTime}, every morning`}
          />
          <View style={styles.divider} />
          <FeatureRow
            icon={pushEnabled ? "notifications-outline" : "notifications-off-outline"}
            tone="ambient"
            title="Notifications"
            body={pushEnabled ? "On — one push when the brief lands" : "Off — check in whenever you like"}
          />
        </View>
      </FadeSlideIn>

      {onOpenSettings ? (
        <FadeSlideIn delay={310}>
          <SecondaryAction
            label="Change these later in Settings"
            icon="options-outline"
            onPress={onOpenSettings}
          />
        </FadeSlideIn>
      ) : null}
    </View>
  );
}
