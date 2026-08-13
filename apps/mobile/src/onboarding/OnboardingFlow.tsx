/**
 * The guided first run.
 *
 * A six-step linear flow — welcome, what EVE does, why it needs Google access,
 * connect, personalize, ready — with progress, back, and skip. This replaces
 * the single static "Connect Google" wall that used to stand between signing in
 * and using the app.
 *
 * Two things drive the structure:
 *
 * 1. The connect step leaves the app. Google's consent screen is a browser
 *    round trip, and Android may kill the app while it's away, so every step
 *    change is written to storage and the flow resumes exactly where it left
 *    off. Arrival back is detected by watching `googleConnected` rather than by
 *    any callback, because the return path is a deep link handled in App.tsx.
 *
 * 2. Only the connect step is mandatory. The narrative steps can be skipped
 *    straight to it — someone who already knows what they installed shouldn't
 *    have to read three screens — and personalization can be skipped to its
 *    defaults.
 */
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { registerPushToken } from "../notifications/push";
import type { Preferences } from "../types";
import { useTheme } from "../ui/ThemeContext";
import { Aura, GhostAction, PrimaryAction, ProgressDots } from "./chrome";
import { ConnectStep, PersonalizeStep, ReadyStep } from "./interactiveSteps";
import { AccessStep, ValueStep, WelcomeStep } from "./steps";
import { useEntryStyles } from "./styles";
import {
  completeOnboarding,
  readOnboardingProgress,
  writeOnboardingProgress,
  type OnboardingStepId,
} from "./storage";

const STEPS: OnboardingStepId[] = ["welcome", "value", "access", "connect", "personalize", "ready"];

type Props = {
  userId: string | null;
  email: string | null;
  googleConnected: boolean;
  preferences: Preferences;
  saving: boolean;
  apiError: string | null;
  onConnectGoogle: () => void;
  onRetry: () => void;
  onDismissError: () => void;
  onSavePreferences: (next: Preferences) => void;
  onDone: () => void;
  onSignOut: () => void;
};

export function OnboardingFlow({
  userId,
  email,
  googleConnected,
  preferences,
  saving,
  apiError,
  onConnectGoogle,
  onRetry,
  onDismissError,
  onSavePreferences,
  onDone,
  onSignOut,
}: Props) {
  const { scheme } = useTheme();
  const styles = useEntryStyles();

  const [step, setStep] = useState<OnboardingStepId>("welcome");
  const [briefingTime, setBriefingTime] = useState(preferences.briefingTime || "08:00");
  const [pushEnabled, setPushEnabled] = useState(preferences.pushEnabled !== false);
  const [finishing, setFinishing] = useState(false);
  const hydrated = useRef(false);

  // Restore where this user left off. Reads through a ref so the effect can
  // depend on nothing and still see the current userId — it must run exactly
  // once, since re-running it would yank the user back to the stored step in
  // the middle of their own navigation.
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  useEffect(() => {
    let active = true;
    void (async () => {
      const stored = await readOnboardingProgress(userIdRef.current);
      if (!active) return;
      if (stored && !stored.completed) {
        setStep(stored.step);
        setBriefingTime(stored.briefingTime);
        setPushEnabled(stored.pushEnabled);
      }
      hydrated.current = true;
    })();
    return () => {
      active = false;
    };
  }, []);

  // Persist after hydration only, so the first render doesn't overwrite a saved
  // position with the initial defaults.
  useEffect(() => {
    if (!hydrated.current) return;
    void writeOnboardingProgress({
      userId,
      step,
      briefingTime,
      pushEnabled,
      completed: false,
    });
  }, [userId, step, briefingTime, pushEnabled]);

  const index = Math.max(0, STEPS.indexOf(step));

  const goTo = useCallback((next: OnboardingStepId) => {
    setStep(next);
  }, []);

  const goBack = useCallback(() => {
    const previous = STEPS[Math.max(0, index - 1)] ?? "welcome";
    goTo(previous);
  }, [goTo, index]);

  const finish = useCallback(async () => {
    setFinishing(true);
    await completeOnboarding(userId);
    onDone();
  }, [onDone, userId]);

  /**
   * Leaving personalization is where the two preferences get committed. The
   * OS notification prompt is deliberately raised here rather than at app
   * launch: asking right after the user has said yes to notifications is the
   * moment the request explains itself.
   */
  const leavePersonalize = useCallback(async () => {
    let effectivePush = pushEnabled;
    if (pushEnabled) {
      const result = await registerPushToken();
      // If they declined at the OS prompt, don't carry a promise we can't keep
      // into the summary screen or the saved preferences.
      if (!result.ok && result.reason === "permission denied") {
        effectivePush = false;
        setPushEnabled(false);
      }
    }
    onSavePreferences({ ...preferences, briefingTime, pushEnabled: effectivePush });
    goTo("ready");
  }, [briefingTime, goTo, onSavePreferences, preferences, pushEnabled]);

  // Skip on the narrative steps jumps to the one step that can't be skipped.
  const canSkip = step === "welcome" || step === "value" || step === "access";

  const primary = describePrimary({
    step,
    googleConnected,
    saving,
    finishing,
  });

  const onPrimary = () => {
    switch (step) {
      case "welcome":
        return goTo("value");
      case "value":
        return goTo("access");
      case "access":
        return goTo("connect");
      case "connect":
        return googleConnected ? goTo("personalize") : onConnectGoogle();
      case "personalize":
        return void leavePersonalize();
      case "ready":
        return void finish();
    }
  };

  return (
    <View style={styles.screen}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <Aura tone={step === "ready" ? "calm" : "eve"} />

      <SafeAreaView style={styles.safe}>
        <View style={styles.topBar}>
          {index > 0 && step !== "ready" ? (
            <GhostAction label="Back" icon="chevron-back" onPress={goBack} />
          ) : (
            <View style={{ width: 64 }} />
          )}
          <ProgressDots total={STEPS.length} index={index} />
          {canSkip ? (
            <GhostAction label="Skip" icon="chevron-forward" iconAfter onPress={() => goTo("connect")} />
          ) : (
            <View style={{ width: 64 }} />
          )}
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Keyed so each step remounts and replays its own entrance stagger. */}
          <View key={step}>
            <StepBody
              step={step}
              email={email}
              googleConnected={googleConnected}
              saving={saving}
              apiError={apiError}
              briefingTime={briefingTime}
              pushEnabled={pushEnabled}
              onConnectGoogle={onConnectGoogle}
              onRetry={onRetry}
              onDismissError={onDismissError}
              onChangeBriefingTime={setBriefingTime}
              onChangePushEnabled={setPushEnabled}
            />
          </View>
          <View style={styles.spacer} />
        </ScrollView>

        <View style={styles.footer}>
          {/* The connect step owns its own primary button so the call to action
              sits with the explanation. Everywhere else it lives down here. */}
          {step === "connect" && !googleConnected ? (
            <GhostAction label="Sign in with a different account" onPress={onSignOut} />
          ) : (
            <PrimaryAction
              label={primary.label}
              icon={primary.icon}
              busy={primary.busy}
              onPress={onPrimary}
            />
          )}
          {step === "personalize" ? <GhostAction label="Skip for now" onPress={() => goTo("ready")} /> : null}
        </View>
      </SafeAreaView>
    </View>
  );
}

function StepBody({
  step,
  email,
  googleConnected,
  saving,
  apiError,
  briefingTime,
  pushEnabled,
  onConnectGoogle,
  onRetry,
  onDismissError,
  onChangeBriefingTime,
  onChangePushEnabled,
}: {
  step: OnboardingStepId;
  email: string | null;
  googleConnected: boolean;
  saving: boolean;
  apiError: string | null;
  briefingTime: string;
  pushEnabled: boolean;
  onConnectGoogle: () => void;
  onRetry: () => void;
  onDismissError: () => void;
  onChangeBriefingTime: (next: string) => void;
  onChangePushEnabled: (next: boolean) => void;
}) {
  switch (step) {
    case "welcome":
      return <WelcomeStep />;
    case "value":
      return <ValueStep />;
    case "access":
      return <AccessStep />;
    case "connect":
      return (
        <ConnectStep
          connected={googleConnected}
          email={email}
          saving={saving}
          apiError={apiError}
          onConnect={onConnectGoogle}
          onRetry={onRetry}
          onDismissError={onDismissError}
        />
      );
    case "personalize":
      return (
        <PersonalizeStep
          briefingTime={briefingTime}
          pushEnabled={pushEnabled}
          onChangeBriefingTime={onChangeBriefingTime}
          onChangePushEnabled={onChangePushEnabled}
        />
      );
    case "ready":
      return <ReadyStep briefingTime={briefingTime} pushEnabled={pushEnabled} email={email} />;
  }
}

function describePrimary({
  step,
  googleConnected,
  saving,
  finishing,
}: {
  step: OnboardingStepId;
  googleConnected: boolean;
  saving: boolean;
  finishing: boolean;
}): { label: string; icon?: "arrow-forward" | "checkmark"; busy?: boolean } {
  switch (step) {
    case "welcome":
      return { label: "Get started", icon: "arrow-forward" };
    case "value":
    case "access":
      return { label: "Continue", icon: "arrow-forward" };
    case "connect":
      return googleConnected
        ? { label: "Continue", icon: "arrow-forward" }
        : { label: "Connect Google", busy: saving };
    case "personalize":
      return { label: "Continue", icon: "arrow-forward" };
    case "ready":
      return { label: "Open EVE", icon: "checkmark", busy: finishing };
  }
}
