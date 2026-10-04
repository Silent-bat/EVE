/**
 * Bridge between the imperative `apiFetch` shim and the Convex Auth provider.
 *
 * Extracted into its own module to break the `convexApi <-> convexClient`
 * require cycle. This file imports nothing from either, so it is safe for
 * `convexClient` to import without re-entering `convexApi`.
 */
export type SignInFn = (
  provider: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

let registeredSignIn: SignInFn | null = null;

/** Called by <ConvexProvider> so apiFetch can reach the provider's signIn. */
export function registerConvexAuthSignIn(fn: SignInFn): void {
  registeredSignIn = fn;
}

export function getRegisteredSignIn(): SignInFn | null {
  return registeredSignIn;
}
