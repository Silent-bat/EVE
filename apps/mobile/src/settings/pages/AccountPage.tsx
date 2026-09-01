/**
 * Account — who you are to EVE, what she's connected to, and how to leave.
 *
 * This page used to be a status report: three rows that named the Google
 * connection, the sending mode, and the model, none of which could be changed
 * from here. Reporting is not managing, so every row that describes something
 * alterable now alters it — the name, the password, the Google grant, the
 * sessions on other devices. Rows that genuinely reflect server configuration
 * (how mail leaves, which model runs) stay read-only and say so, because
 * pretending they're settings would be worse than admitting they aren't.
 *
 * Deletion is the only irreversible thing in the app, so it keeps both gates:
 * an Alert that names what goes, then a typed confirmation. The second is not
 * ceremony — the first dialog is one mis-tap away from destroying a mailbox's
 * worth of history.
 */
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";

import { changePassword, deleteAccount, disconnectGoogle, revokeAllSessions, setDisplayName } from "../api";
import { SettingsGroup, SettingsRowItem } from "../rows";
import { SettingsPage } from "../PageShell";
import type { Session } from "../../types";
import { UserAvatar, describeError } from "../../ui/components";
import { InlineButton } from "../../ui/primitives";
import { radius, spacing } from "../../ui/theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../../ui/ThemeContext";

const CONFIRM_WORD = "DELETE";

/** Which inline editor is open, if any. Only one at a time. */
type Editor = "name" | "password" | "delete" | null;

export function AccountPage({
  session,
  saving,
  onBack,
  onSignOut,
  onSessionChange,
  onConnectGoogle,
  onDeleted,
  onError,
}: {
  session: Session;
  saving: boolean;
  onBack: () => void;
  onSignOut: () => void;
  /** Applies a session the server just re-issued, so the header updates too. */
  onSessionChange: (session: Session) => void;
  /** Starts the Google OAuth flow. Same one the reconnect wall uses. */
  onConnectGoogle: () => void;
  /** Called after the server confirms. The caller drops the token and returns to auth. */
  onDeleted: () => void;
  onError: (message: string) => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const [editor, setEditor] = useState<Editor>(null);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const [name, setName] = useState(session.displayName || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const google = session.googleConnected;
  const hasPassword = session.hasPassword !== false;
  const locked = saving || busy;

  function close() {
    setEditor(null);
    setTyped("");
    setCurrentPassword("");
    setNewPassword("");
  }

  /**
   * Every action here is the same shape: disable the page, call the server,
   * report the failure and keep the editor open so nothing typed is lost.
   */
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNote(null);
    try {
      await action();
    } catch (error) {
      onError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  function saveName() {
    void run(async () => {
      onSessionChange(await setDisplayName(name.trim()));
      close();
      setNote("Name updated.");
    });
  }

  function savePassword() {
    void run(async () => {
      await changePassword({ currentPassword, newPassword });
      close();
      setNote("Password changed. Other devices stay signed in.");
    });
  }

  function confirmDisconnect() {
    Alert.alert(
      "Disconnect Google?",
      "EVE stops reading your mail and calendar. Your account, briefings, and approval history stay.",
      [
        { text: "Keep connected", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () =>
            void run(async () => {
              onSessionChange(await disconnectGoogle());
              setNote("Google disconnected.");
            }),
        },
      ],
    );
  }

  function confirmRevokeAll() {
    Alert.alert(
      "Sign out everywhere?",
      "Every device signed in to this account is signed out, including this one.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out everywhere",
          style: "destructive",
          // The server kills this session too, so the app has to leave.
          onPress: () =>
            void run(async () => {
              await revokeAllSessions();
              onSignOut();
            }),
        },
      ],
    );
  }

  function confirmDelete() {
    Alert.alert(
      "Delete your account?",
      "This removes your briefings, approval history, captured notifications, and your Google connection. It cannot be undone.",
      [
        { text: "Keep my account", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            void run(async () => {
              await deleteAccount();
              onDeleted();
            }),
        },
      ],
    );
  }

  return (
    <SettingsPage title="Account" onBack={onBack}>
      <View style={styles.identity}>
        <UserAvatar photoURL={session.photoURL} name={session.displayName} email={session.email} size="lg" />
        <View style={styles.identityText}>
          <Text style={styles.identityName} numberOfLines={1}>
            {session.displayName || session.email || "EVE account"}
          </Text>
          <Text style={styles.identityNote} numberOfLines={1}>
            {session.displayName && session.email ? session.email : "Signed in on this device"}
          </Text>
        </View>
      </View>

      {note ? (
        <View style={styles.note}>
          <Ionicons name="checkmark-circle" size={16} color={palette.success} />
          <Text style={styles.noteText}>{note}</Text>
        </View>
      ) : null}

      <SettingsGroup title="You">
        {editor === "name" ? (
          <View style={styles.editor}>
            <Text style={styles.editorLabel}>Display name</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              editable={!busy}
              autoFocus
              placeholder={session.email || "Your name"}
              placeholderTextColor={palette.textMuted}
              accessibilityLabel="Display name"
              style={styles.input}
            />
            <Text style={styles.editorHint}>Leave it empty to show your email address instead.</Text>
            <View style={styles.actions}>
              <InlineButton
                label="Cancel"
                onPress={() => {
                  setName(session.displayName || "");
                  close();
                }}
                disabled={busy}
              />
              <InlineButton
                label={busy ? "Saving…" : "Save"}
                tone="ambient"
                onPress={saveName}
                disabled={busy}
              />
            </View>
          </View>
        ) : (
          <SettingsRowItem
            icon="person-outline"
            title="Display name"
            subtitle="What EVE calls you"
            value={session.displayName || "Not set"}
            disabled={locked}
            onPress={() => {
              setName(session.displayName || "");
              setEditor("name");
            }}
          />
        )}

        <SettingsRowItem
          icon="mail-outline"
          title="Email"
          subtitle="Your sign-in address — it can't be changed here"
          value={session.email || "Unknown"}
        />

        {/* A Google-only account has no password, so there is nothing to
            change and no control. */}
        {hasPassword ? (
          editor === "password" ? (
            <View style={styles.editor}>
              <Text style={styles.editorLabel}>Change password</Text>
              <TextInput
                value={currentPassword}
                onChangeText={setCurrentPassword}
                secureTextEntry
                editable={!busy}
                autoFocus
                placeholder="Current password"
                placeholderTextColor={palette.textMuted}
                accessibilityLabel="Current password"
                style={styles.input}
              />
              <TextInput
                value={newPassword}
                onChangeText={setNewPassword}
                secureTextEntry
                editable={!busy}
                placeholder="New password — at least 8 characters"
                placeholderTextColor={palette.textMuted}
                accessibilityLabel="New password"
                style={styles.input}
              />
              <Text style={styles.editorHint}>
                Your current password is required even though you're signed in.
              </Text>
              <View style={styles.actions}>
                <InlineButton label="Cancel" onPress={close} disabled={busy} />
                <InlineButton
                  label={busy ? "Changing…" : "Change password"}
                  tone="ambient"
                  onPress={savePassword}
                  disabled={busy || currentPassword.length === 0 || newPassword.length < 8}
                />
              </View>
            </View>
          ) : (
            <SettingsRowItem
              icon="key-outline"
              title="Password"
              subtitle="Changing it doesn't sign out your other devices"
              disabled={locked}
              onPress={() => setEditor("password")}
            />
          )
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title="Connections"
        footer="How mail leaves and which model runs are set on the server, not here."
      >
        <SettingsRowItem
          icon="logo-google"
          tone={google ? "success" : "neutral"}
          title="Google"
          subtitle={google ? "Gmail and Calendar" : "EVE has no mail to read"}
          value={google ? "Connected" : "Off"}
          destructive={google}
          disabled={locked}
          onPress={google ? confirmDisconnect : onConnectGoogle}
        />
        <SettingsRowItem
          icon="send-outline"
          tone={session.integrationMode.emailSending === "gmail-api" ? "success" : "warning"}
          title="Sending mail"
          subtitle="How approved replies leave"
          value={session.integrationMode.emailSending === "gmail-api" ? "Gmail" : "Recorded only"}
        />
        <SettingsRowItem
          icon="sparkles-outline"
          tone={session.integrationMode.llm === "configured" ? "ambient" : "neutral"}
          title="Language model"
          subtitle="Summaries and drafts"
          value={session.integrationMode.llm === "configured" ? "Gemini" : "On-device rules"}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Sessions"
        footer="Signing out revokes the Google grant, so coming back runs the permission screen again."
      >
        <SettingsRowItem
          icon="log-out-outline"
          title="Sign out"
          subtitle="This device only"
          disabled={locked}
          onPress={onSignOut}
        />
        <SettingsRowItem
          icon="phone-portrait-outline"
          title="Sign out everywhere"
          subtitle="Every device, including this one"
          destructive
          disabled={locked}
          onPress={confirmRevokeAll}
        />
      </SettingsGroup>

      <SettingsGroup title="Danger zone">
        {editor === "delete" ? (
          <View style={styles.editor}>
            <View style={styles.warnRow}>
              <Ionicons name="alert-circle" size={18} color={palette.danger} />
              <Text style={styles.warnText}>
                Type {CONFIRM_WORD} to confirm. Everything EVE holds about you is removed and cannot be
                recovered.
              </Text>
            </View>
            <TextInput
              value={typed}
              onChangeText={setTyped}
              autoCapitalize="characters"
              autoCorrect={false}
              editable={!busy}
              placeholder={CONFIRM_WORD}
              placeholderTextColor={palette.textMuted}
              accessibilityLabel={`Type ${CONFIRM_WORD} to confirm deletion`}
              style={[styles.input, styles.confirmInput]}
            />
            <View style={styles.actions}>
              <InlineButton label="Cancel" onPress={close} disabled={busy} />
              <InlineButton
                label={busy ? "Deleting…" : "Delete account"}
                tone="danger"
                onPress={confirmDelete}
                disabled={busy || typed.trim().toUpperCase() !== CONFIRM_WORD}
              />
            </View>
          </View>
        ) : (
          <SettingsRowItem
            icon="trash-outline"
            title="Delete account"
            subtitle="Removes everything, permanently"
            destructive
            disabled={locked}
            onPress={() => setEditor("delete")}
          />
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    identity: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing.xs,
      paddingBottom: spacing.lg,
    },
    identityText: { flex: 1, gap: 2 },
    identityName: { ...type.title, fontSize: 16 },
    identityNote: { ...type.caption },
    note: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: palette.successTint,
      marginBottom: spacing.md,
    },
    noteText: { ...type.caption, flex: 1, color: palette.successDeep },
    editor: { padding: spacing.md, gap: spacing.sm },
    editorLabel: { ...type.label, fontSize: 14 },
    editorHint: { ...type.caption },
    warnRow: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
    warnText: { ...type.bodyMuted, flex: 1, color: palette.text },
    input: {
      ...type.body,
      minHeight: 46,
      paddingHorizontal: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: palette.borderStrong,
      backgroundColor: palette.surfaceMuted,
    },
    // Wide tracking on the delete confirmation only: it makes typing the word
    // feel deliberate, and it would just look odd on a name field.
    confirmInput: { letterSpacing: 1.5 },
    actions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: spacing.sm,
      marginTop: spacing.xs,
    },
  });
}
