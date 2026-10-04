/**
 * Convex Client Setup for EVE Mobile App
 *
 * @convex-dev/auth 0.0.95 ships react + nextjs entries only; React Native
 * works off the react entry. The provider needs a token storage adapter on
 * RN — its default is `localStorage`, which does not exist off the web.
 */
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider, useAuthActions } from "@convex-dev/auth/react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React from "react";
import { Platform } from "react-native";
import type { TokenStorage } from "@convex-dev/auth/react";
import { registerConvexAuthSignIn } from "./authSignInRegistry";

/**
 * The Convex deployment the app talks to. Defaults to the PROD deployment that
 * serves real traffic; set EXPO_PUBLIC_CONVEX_URL to the dev deployment to
 * override for local testing.
 */
export const CONVEX_URL =
  process.env.EXPO_PUBLIC_CONVEX_URL || "https://veracious-panther-496.convex.cloud";

export const convex = new ConvexReactClient(CONVEX_URL);

const tokenStorage: TokenStorage = {
  getItem: (key) => {
    if (Platform.OS === "web") {
      return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    }
    return AsyncStorage.getItem(key);
  },
  setItem: (key, value) => {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
      return;
    }
    return AsyncStorage.setItem(key, value);
  },
  removeItem: (key) => {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") localStorage.removeItem(key);
      return;
    }
    return AsyncStorage.removeItem(key);
  },
};

/**
 * Bridges the provider's signIn action to the imperative apiFetch shim.
 * App.tsx still calls apiFetch("/v1/auth/login"); this lets that path reach
 * Convex Auth without rewriting every auth call site.
 */
function ConvexAuthBridge() {
  const { signIn } = useAuthActions();
  const registered = React.useRef(false);
  React.useEffect(() => {
    if (registered.current) return;
    registered.current = true;
    registerConvexAuthSignIn(async (provider: string, args?: Record<string, any>) => {
      // Provider ids match the ones declared in convex/auth.ts: "password"
      // and "google" (the ConvexCredentials provider is pinned to "google").
      return signIn(provider, args ?? {});
    });
  }, [signIn]);
  return null;
}

export function ConvexProvider({ children }: { children: React.ReactNode }) {
  return (
    <ConvexAuthProvider client={convex} storage={tokenStorage}>
      <ConvexAuthBridge />
      {children}
    </ConvexAuthProvider>
  );
}
