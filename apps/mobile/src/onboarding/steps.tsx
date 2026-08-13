/**
 * The three narrative steps of the first run: who EVE is, what it does, and
 * what it needs from you. No side effects — they render copy and nothing else,
 * so the flow machine owns all the state.
 *
 * The access step is deliberately specific about scopes. This app asks to read
 * somebody's mail; a vague "we need permissions" screen is where trust gets
 * lost, so each grant is named alongside what it buys the user.
 */
import { Text, View } from "react-native";

import { FadeSlideIn } from "../ui/motion";
import { EveMark, Eyebrow, FeatureRow } from "./chrome";
import { useEntryStyles } from "./styles";

export function WelcomeStep() {
  const styles = useEntryStyles();
  return (
    <View style={{ gap: 14 }}>
      <FadeSlideIn>
        <EveMark />
      </FadeSlideIn>
      <FadeSlideIn delay={70}>
        <Eyebrow>Welcome to EVE</Eyebrow>
      </FadeSlideIn>
      <FadeSlideIn delay={130}>
        <Text style={styles.hero} accessibilityRole="header">
          Your inbox, handled before you open it.
        </Text>
      </FadeSlideIn>
      <FadeSlideIn delay={200}>
        <Text style={styles.lead}>
          Each morning EVE reads what arrived, tells you what actually matters, and writes the replies. You
          approve — it sends. Nothing goes out on its own.
        </Text>
      </FadeSlideIn>
      <FadeSlideIn delay={260}>
        <Text style={styles.bodyMuted}>Setting up takes about a minute.</Text>
      </FadeSlideIn>
    </View>
  );
}

export function ValueStep() {
  const styles = useEntryStyles();
  return (
    <View style={{ gap: 18 }}>
      <FadeSlideIn>
        <Eyebrow>What you get</Eyebrow>
      </FadeSlideIn>
      <FadeSlideIn delay={70}>
        <Text style={styles.heading} accessibilityRole="header">
          Three things, every morning.
        </Text>
      </FadeSlideIn>
      <View style={{ gap: 4 }}>
        <FeatureRow
          delay={140}
          icon="sunny-outline"
          tone="success"
          title="A brief, not a backlog"
          body="One page: what came in overnight, what it means, and the few things that need you."
        />
        <FeatureRow
          delay={210}
          icon="create-outline"
          tone="info"
          title="Replies already drafted"
          body="EVE writes in your voice. Edit any draft, or send it as it stands."
        />
        <FeatureRow
          delay={280}
          icon="shield-checkmark-outline"
          tone="ambient"
          title="Nothing happens without you"
          body="Every send waits for your approval and is recorded in an audit trail you can read back."
        />
      </View>
    </View>
  );
}

export function AccessStep() {
  const styles = useEntryStyles();
  return (
    <View style={{ gap: 18 }}>
      <FadeSlideIn>
        <Eyebrow>Permissions</Eyebrow>
      </FadeSlideIn>
      <FadeSlideIn delay={70}>
        <Text style={styles.heading} accessibilityRole="header">
          Why EVE needs your Google account.
        </Text>
      </FadeSlideIn>
      <FadeSlideIn delay={130}>
        <Text style={styles.lead}>
          Three grants, each one doing a specific job. Google will show you the same list before you agree to
          anything.
        </Text>
      </FadeSlideIn>

      <FadeSlideIn delay={200}>
        <View style={styles.card}>
          <FeatureRow
            icon="mail-outline"
            tone="success"
            title="Read your mail"
            body="How the morning brief gets written. Read-only — EVE cannot delete or archive anything."
          />
          <View style={styles.divider} />
          <FeatureRow
            icon="send-outline"
            tone="info"
            title="Send the replies you approve"
            body="Used only for messages you have explicitly approved, one at a time."
          />
          <View style={styles.divider} />
          <FeatureRow
            icon="calendar-outline"
            tone="ambient"
            title="See your calendar"
            body="Read-only, so the brief knows what your day already looks like."
          />
        </View>
      </FadeSlideIn>

      <FadeSlideIn delay={270}>
        <Text style={styles.bodyMuted}>
          Your mail is never used to train anything and is never shared. Removing EVE from your Google account
          permissions cuts off access immediately.
        </Text>
      </FadeSlideIn>
    </View>
  );
}
