/**
 * Sign in / create account.
 *
 * Rebuilt on the entry-flow chrome so boot, sign-in, and the guided first run
 * read as one continuous experience rather than three screens that happen to
 * share a colour.
 *
 * Two behavioural changes from the screen this replaces. Google is now the
 * lead action instead of an afterthought below the form — it is the path that
 * actually works for this app, since an email account with no Google
 * connection can't brief on anything. And the email form is collapsed behind a
 * disclosure, so the default screen is one decision instead of six controls.
 */
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { FadeSlideIn } from "../ui/motion";
import { ErrorBanner } from "../ui/primitives";
import { useTheme } from "../ui/ThemeContext";
import { Aura, EveMark, Eyebrow, GhostAction, PrimaryAction, SecondaryAction } from "../onboarding/chrome";
import { useEntryStyles } from "../onboarding/styles";

export type AuthMode = "login" | "signup";

type Props = {
  onSubmit: (input: { email: string; password: string; mode: AuthMode }) => void;
  onGoogle: () => void;
  saving: boolean;
  apiError: string | null;
  onDismissError: () => void;
};

export function AuthScreen({ onSubmit, onGoogle, saving, apiError, onDismissError }: Props) {
  const [mode, setMode] = useState<AuthMode>("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [focused, setFocused] = useState<"email" | "password" | null>(null);
  const { palette, scheme } = useTheme();
  const styles = useEntryStyles();

  const canSubmit = email.trim().length > 0 && password.length > 0 && !saving;

  return (
    <View style={styles.screen}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <Aura />

      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={{ gap: 14, paddingTop: 8 }}>
              <FadeSlideIn>
                <EveMark />
              </FadeSlideIn>
              <FadeSlideIn delay={70}>
                <Eyebrow>{mode === "signup" ? "Create your account" : "Welcome back"}</Eyebrow>
              </FadeSlideIn>
              <FadeSlideIn delay={130}>
                <Text style={styles.hero} accessibilityRole="header">
                  {mode === "signup" ? "Let's get your inbox under control." : "Good to see you."}
                </Text>
              </FadeSlideIn>
              <FadeSlideIn delay={190}>
                <Text style={styles.lead}>
                  {mode === "signup"
                    ? "EVE reads what arrived, drafts the replies, and waits for your approval."
                    : "Your briefings, drafts, and audit trail are where you left them."}
                </Text>
              </FadeSlideIn>
            </View>

            {apiError ? (
              <FadeSlideIn>
                <ErrorBanner message={apiError} onDismiss={onDismissError} />
              </FadeSlideIn>
            ) : null}

            <View style={styles.spacer} />

            <FadeSlideIn delay={250}>
              <View style={{ gap: 10 }}>
                <PrimaryAction
                  label={saving ? "Please wait" : "Continue with Google"}
                  icon="logo-google"
                  busy={saving}
                  onPress={onGoogle}
                />

                {showEmailForm ? null : (
                  <SecondaryAction
                    label="Use email instead"
                    icon="mail-outline"
                    disabled={saving}
                    onPress={() => setShowEmailForm(true)}
                  />
                )}
              </View>
            </FadeSlideIn>

            {showEmailForm ? (
              <FadeSlideIn>
                <View style={{ gap: 10 }}>
                  <View style={styles.orRow}>
                    <View style={styles.orLine} />
                    <Text style={styles.orText}>
                      {mode === "signup" ? "Sign up with email" : "Log in with email"}
                    </Text>
                    <View style={styles.orLine} />
                  </View>

                  <TextInput
                    value={email}
                    onChangeText={setEmail}
                    onFocus={() => setFocused("email")}
                    onBlur={() => setFocused(null)}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="email"
                    keyboardType="email-address"
                    returnKeyType="next"
                    placeholder="you@work.com"
                    placeholderTextColor={palette.textMuted}
                    accessibilityLabel="Email address"
                    style={[styles.input, focused === "email" && styles.inputFocused]}
                  />
                  <TextInput
                    value={password}
                    onChangeText={setPassword}
                    onFocus={() => setFocused("password")}
                    onBlur={() => setFocused(null)}
                    secureTextEntry
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    returnKeyType="go"
                    onSubmitEditing={() => canSubmit && onSubmit({ email, password, mode })}
                    placeholder="Password"
                    placeholderTextColor={palette.textMuted}
                    accessibilityLabel="Password"
                    style={[styles.input, focused === "password" && styles.inputFocused]}
                  />

                  <SecondaryAction
                    label={mode === "signup" ? "Create account" : "Log in"}
                    icon="arrow-forward"
                    disabled={!canSubmit}
                    busy={saving}
                    onPress={() => onSubmit({ email, password, mode })}
                  />
                </View>
              </FadeSlideIn>
            ) : null}

            <FadeSlideIn delay={310}>
              <View style={authLayout.footer}>
                <Text style={styles.bodyMuted}>
                  {mode === "signup" ? "Already have an account?" : "New to EVE?"}
                </Text>
                <Pressable
                  onPress={() => setMode(mode === "signup" ? "login" : "signup")}
                  accessibilityRole="button"
                  accessibilityLabel={mode === "signup" ? "Log in instead" : "Create an account"}
                >
                  <Text style={authLayout.link(palette.text)}>
                    {mode === "signup" ? "Log in" : "Create one"}
                  </Text>
                </Pressable>
              </View>
            </FadeSlideIn>

            {showEmailForm ? (
              <GhostAction label="Hide email sign-in" onPress={() => setShowEmailForm(false)} />
            ) : null}

            <FadeSlideIn delay={370}>
              <View style={styles.featureRow}>
                <Ionicons name="lock-closed-outline" size={14} color={palette.textMuted} />
                <Text style={[styles.bodyMuted, { flex: 1 }]}>
                  EVE only ever sends mail you've approved, and every action is logged.
                </Text>
              </View>
            </FadeSlideIn>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const authLayout = {
  footer: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 6,
    minHeight: 44,
  },
  link: (color: string) => ({
    color,
    fontSize: 13,
    fontWeight: "800" as const,
    textDecorationLine: "underline" as const,
  }),
};
