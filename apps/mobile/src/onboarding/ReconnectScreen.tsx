/**
 * Reconnect wall.
 *
 * Distinct from the first run: this is for an account that finished onboarding
 * and later lost its Google grant — the token expired without a refresh token,
 * or the user revoked EVE from their Google security settings. The server
 * reports that as `googleConnected: false`, and without a route like this the
 * app would sit in its main UI silently briefing on nothing.
 *
 * It is deliberately not the onboarding flow with a pinned step. Someone who
 * has used EVE for a month doesn't need progress dots, and re-entering a tour
 * they completed would read as a bug.
 */
import { StatusBar } from "expo-status-bar";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "../ui/ThemeContext";
import { Aura, GhostAction } from "./chrome";
import { ConnectStep } from "./interactiveSteps";
import { useEntryStyles } from "./styles";

type Props = {
  email: string | null;
  saving: boolean;
  apiError: string | null;
  onConnect: () => void;
  onRetry: () => void;
  onDismissError: () => void;
  onSignOut: () => void;
};

/**
 * There is no "connected" state to render here: the moment the session reports
 * the grant is live, App.tsx routes past this screen into the app. So the step
 * is always shown in its disconnected form.
 */
export function ReconnectScreen({
  email,
  saving,
  apiError,
  onConnect,
  onRetry,
  onDismissError,
  onSignOut,
}: Props) {
  const { scheme } = useTheme();
  const styles = useEntryStyles();

  return (
    <View style={styles.screen}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <Aura />

      <SafeAreaView style={styles.safe}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={{ paddingTop: 12 }}>
            <ConnectStep
              reconnect
              connected={false}
              email={email}
              saving={saving}
              apiError={apiError}
              onConnect={onConnect}
              onRetry={onRetry}
              onDismissError={onDismissError}
            />
          </View>
          <View style={styles.spacer} />
        </ScrollView>

        <View style={styles.footer}>
          <GhostAction label="Sign in with a different account" onPress={onSignOut} />
        </View>
      </SafeAreaView>
    </View>
  );
}
