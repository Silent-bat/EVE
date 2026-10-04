/**
 * Integrations — connect the tools that give EVE more context and reach.
 *
 * Mirrors the new design: a titled list of connectable services, each a row
 * with a branded icon chip, name, one-line description, and a toggle. Gmail +
 * Calendar reflect the real Google connection; the rest are presentational
 * connect switches persisted per-device until their backends land.
 */
import { useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Switch, Text, View } from "react-native";
import { useQuery } from "convex/react";

import { SettingsGroup, SettingsRowItem } from "../rows";
import { SettingsPage } from "../PageShell";
import { convex, api } from "../../api/convexApi";
import { useTheme, useThemedStyles, type ThemeValue } from "../../ui/ThemeContext";
import { spacing, type Tone } from "../../ui/theme";

type Integration = {
  key: string;
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  tone: Tone;
};

const INTEGRATIONS: Integration[] = [
  { key: "gmail", title: "Gmail", subtitle: "Email & calendar", icon: "mail", tone: "danger" },
  { key: "gcal", title: "Google Calendar", subtitle: "Calendar & events", icon: "calendar", tone: "info" },
  { key: "slack", title: "Slack", subtitle: "Messages & channels", icon: "chatbubbles", tone: "ambient" },
  { key: "notion", title: "Notion", subtitle: "Notes & documents", icon: "document-text", tone: "neutral" },
  { key: "gdrive", title: "Google Drive", subtitle: "Files & documents", icon: "folder", tone: "success" },
  { key: "zoom", title: "Zoom", subtitle: "Meetings & calls", icon: "videocam", tone: "info" },
  { key: "whatsapp", title: "WhatsApp", subtitle: "Messages", icon: "logo-whatsapp", tone: "success" },
];

export function IntegrationsPage({
  gmailConnected,
  integrations,
  onConnectGmail,
  onBack,
}: {
  gmailConnected: boolean;
  integrations: Record<string, boolean>;
  onConnectGmail: () => void;
  onBack: () => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  // Read the persisted state live from Convex so the toggles always reflect
  // the truth (and update reactively after a write), falling back to the
  // session snapshot passed in until the query resolves. An optimistic overlay
  // makes each switch respond instantly.
  const me = useQuery(api.users.getCurrentUser, {});
  const persisted: Record<string, boolean> =
    (me as any)?.integrations ?? integrations ?? {};
  const liveGmail =
    me != null ? (me as any).connectionMode === "google" || (me as any).googleConnected === true : gmailConnected;
  const [overlay, setOverlay] = useState<Record<string, boolean>>({});

  const toggle = (key: string, next: boolean) => {
    setOverlay((prev) => ({ ...prev, [key]: next }));
    void convex.mutation(api.users.setIntegration, { key, enabled: next }).catch(() => {
      // Drop the optimistic value on failure so the switch reflects the truth.
      setOverlay((prev) => {
        const { [key]: _, ...rest } = prev;
        return rest;
      });
    });
  };
  const valueOf = (key: string) => (key in overlay ? overlay[key] : Boolean(persisted[key]));

  return (
    <SettingsPage
      title="Integrations"
      intro="Connect your tools to give EVE more context and take action."
      onBack={onBack}
    >
      <SettingsGroup>
        {INTEGRATIONS.map((it) => {
          const isGoogle = it.key === "gmail" || it.key === "gcal";
          const value = isGoogle ? liveGmail : valueOf(it.key);
          return (
            <SettingsRowItem
              key={it.key}
              icon={it.icon}
              tone={it.tone}
              title={it.title}
              subtitle={it.subtitle}
              control={
                <Switch
                  value={value}
                  onValueChange={(next) => {
                    if (isGoogle) {
                      if (next && !liveGmail) onConnectGmail();
                    } else {
                      toggle(it.key, next);
                    }
                  }}
                  accessibilityLabel={it.title}
                  trackColor={{ true: palette.ambient, false: palette.border }}
                  thumbColor={palette.background}
                />
              }
            />
          );
        })}
      </SettingsGroup>

      <View style={styles.footer}>
        <Ionicons name="shield-checkmark-outline" size={16} color={palette.primary} />
        <Text style={styles.footerText}>Manage permissions</Text>
      </View>
    </SettingsPage>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    footer: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.xs,
      paddingVertical: spacing.lg,
    },
    footerText: { ...type.label, color: palette.primary },
  });
}
