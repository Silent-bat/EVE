import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { apiFetch } from "../api/client";
import { palette } from "../ui/theme";

/**
 * Ask the user for permission, fetch the Expo push token, and POST it to the
 * backend so the Gmail poller can notify this device. Resilient: silently
 * no-ops when permission is denied, the dev client lacks Notifications, or
 * the network request fails.
 *
 * Safe to call multiple times — backend dedupes by token.
 *
 * @param projectId Expo EAS project id from app.json `expo.extra.eas.projectId`
 */
export async function registerPushToken(): Promise<{ ok: boolean; reason?: string }> {
  try {
    if (Platform.OS === "web") return { ok: false, reason: "web platform skipped" };

    const settings = await Notifications.getPermissionsAsync();
    let granted =
      settings.granted || settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    if (!granted) {
      const request = await Notifications.requestPermissionsAsync();
      granted = request.granted || request.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    }
    if (!granted) return { ok: false, reason: "permission denied" };

    if (Platform.OS === "android") {
      // Default channel for our system notifications. The accent colour is
      // EVE's purple, read from the static light-mode alias — this module runs
      // outside React and so cannot reach the theme through the hook.
      await Notifications.setNotificationChannelAsync("default", {
        name: "EVE",
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: palette.ambient,
      });
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ||
      (Constants.manifest as { extra?: { eas?: { projectId?: string } } } | null)?.extra?.eas?.projectId;
    if (!projectId) return { ok: false, reason: "no Expo project id configured" };

    const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenResponse?.data;
    if (!token) return { ok: false, reason: "no token returned" };

    await apiFetch<{ tokens: number }>("/v1/notifications/push-token", {
      method: "POST",
      body: JSON.stringify({ token, platform: Platform.OS }),
    });
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "register failed";
    return { ok: false, reason };
  }
}

/**
 * Configure how an incoming notification is presented while the app is in
 * the foreground. Call once at app boot.
 */
export function configureForegroundHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}
