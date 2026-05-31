import { NativeEventEmitter, NativeModules, Platform } from "react-native";

export type DeviceNotificationEvent = {
  id?: string;
  packageName?: string;
  appName?: string;
  title?: string;
  body?: string;
  postedAt?: number;
};

type PermissionEvent = {
  enabled?: boolean;
};

type EveNotificationListenerModule = {
  isPermissionGranted: () => Promise<boolean>;
  openSettings: () => void;
  configure: (apiUrl: string, authToken: string) => void;
};

const nativeModule = NativeModules.EveNotificationListener as EveNotificationListenerModule | undefined;
const emitter = nativeModule ? new NativeEventEmitter(nativeModule as never) : null;

export const notificationAccessSupported = Platform.OS === "android" && Boolean(nativeModule);

export async function isNotificationAccessGranted() {
  if (!notificationAccessSupported || !nativeModule) return false;
  return nativeModule.isPermissionGranted();
}

export function openNotificationAccessSettings() {
  if (notificationAccessSupported && nativeModule) {
    nativeModule.openSettings();
  }
}

export function configureNotificationSync(apiUrl: string, authToken: string) {
  if (notificationAccessSupported && nativeModule) {
    nativeModule.configure(apiUrl, authToken);
  }
}

export function subscribeToDeviceNotifications(listener: (event: DeviceNotificationEvent) => void) {
  if (!emitter) return () => undefined;
  const subscription = emitter.addListener("EveDeviceNotification", listener);
  return () => subscription.remove();
}

export function subscribeToNotificationPermission(listener: (event: PermissionEvent) => void) {
  if (!emitter) return () => undefined;
  const subscription = emitter.addListener("EveNotificationPermissionChanged", listener);
  return () => subscription.remove();
}
