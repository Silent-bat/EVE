import { NativeModules } from "react-native";

type Storage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

function selectBackend(): Storage {
  const nativeModule =
    (NativeModules as Record<string, unknown>).RNCAsyncStorage ??
    (NativeModules as Record<string, unknown>).PlatformLocalStorage;
  if (nativeModule) {
    try {
      return require("@react-native-async-storage/async-storage").default as Storage;
    } catch {
      // fall through to memory backend
    }
  }
  const store = new Map<string, string>();
  return {
    async getItem(key) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    async setItem(key, value) {
      store.set(key, value);
    },
    async removeItem(key) {
      store.delete(key);
    },
  };
}

const storage = selectBackend();
export default storage;
