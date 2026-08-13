/**
 * ChatScreen in a modal, with the chrome the tab layout doesn't provide.
 *
 * Chat is reached from the raised centre button rather than a tab, so it comes
 * in over the app instead of replacing a tab's content. That also gives it a
 * natural handoff to voice: the two are the same conversation in different
 * modalities, and switching should be one tap rather than a trip through the
 * nav bar.
 */
import { Modal, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ChatScreen } from "./ChatScreen";
import { TopNav } from "../ui/components";
import { useThemedStyles, type ThemeValue } from "../ui/ThemeContext";

export function ChatModal({
  visible,
  onClose,
  onOpenVoice,
}: {
  visible: boolean;
  onClose: () => void;
  onOpenVoice?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {/* Top edge only: the composer already carries its own bottom clearance,
          and insetting both would double it. */}
      <SafeAreaView style={styles.root} edges={["top"]}>
        <TopNav
          title="EVE"
          subtitle="Ask about anything she can see"
          onBack={onClose}
          backIcon="chevron-down"
          backLabel="Close chat"
          action={
            onOpenVoice
              ? { icon: "mic", label: "Switch to voice", onPress: onOpenVoice }
              : undefined
          }
        />
        <ChatScreen />
      </SafeAreaView>
    </Modal>
  );
}

function makeStyles({ palette }: ThemeValue) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: palette.background },
  });
}
