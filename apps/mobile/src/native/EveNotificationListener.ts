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
  clearConfiguration: () => void;
  setAllowedPackages: (packages: string[]) => void;
  getAllowedPackages: () => Promise<string[] | null>;
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

/** Stop background capture and remove the native credential binding. */
export function clearNotificationSync() {
  if (notificationAccessSupported && nativeModule) {
    nativeModule.clearConfiguration();
  }
}

/**
 * Limit background capture to explicitly selected Android package names. A
 * missing selection preserves the listener's existing opt-in behavior; an
 * empty array intentionally disables capture until apps are selected.
 */
export function setNotificationPackageAllowlist(packages: string[]) {
  if (notificationAccessSupported && nativeModule) {
    nativeModule.setAllowedPackages(packages);
  }
}

export async function getNotificationPackageAllowlist(): Promise<string[] | null> {
  if (!notificationAccessSupported || !nativeModule) return null;
  const packages = await nativeModule.getAllowedPackages();
  return Array.isArray(packages) ? packages : null;
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
