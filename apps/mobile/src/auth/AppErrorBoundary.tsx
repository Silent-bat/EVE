/**
 * Top-level error boundary. Anything thrown from the React tree below the
 * boundary becomes a readable screen instead of a white flash or a native
 * crash dialog.
 *
 * This is the one surface that still prints the API base URL. A crash report
 * from a device is close to useless without knowing which backend the app was
 * talking to, and by definition the user is already looking at a failure — so
 * the tradeoff that made it wrong on the boot screen makes it right here.
 */
import { StatusBar } from "expo-status-bar";
import { Component, type ReactNode } from "react";
import { Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { config } from "../config";
import { Aura, EveMark, SecondaryAction } from "../onboarding/chrome";
import { useEntryStyles } from "../onboarding/styles";
import { ThemeProvider, useTheme } from "../ui/ThemeContext";

const API_BASE_URL = config.apiBaseURL;

type Props = { children: ReactNode };
type State = { error: Error | null };

function ErrorFallbackBody({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { scheme } = useTheme();
  const styles = useEntryStyles();

  return (
    <View style={styles.screen}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <Aura />
      <SafeAreaView style={styles.safe}>
        <View style={styles.centered} accessibilityRole="alert">
          <EveMark />
          <Text style={styles.heading} accessibilityRole="header">
            EVE hit an app error.
          </Text>
          <Text style={styles.lead}>{message}</Text>
          <Text style={styles.diagnostic}>API: {API_BASE_URL}</Text>
        </View>
        <View style={styles.footer}>
          <SecondaryAction label="Try again" icon="refresh-outline" onPress={onRetry} />
        </View>
      </SafeAreaView>
    </View>
  );
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    // Own ThemeProvider: the boundary may sit above the app's provider, and the
    // throw that got us here could have come from inside it.
    return (
      <ThemeProvider>
        <ErrorFallbackBody
          message={this.state.error.message || "Reload the app and try again."}
          // Clearing the error remounts the tree. If the fault was transient
          // (a failed fetch during render) this recovers; if not, the boundary
          // simply catches again and we're back here.
          onRetry={() => this.setState({ error: null })}
        />
      </ThemeProvider>
    );
  }
}
