/**
 * Auth provider registry.
 *
 * Convex verifies client-held JWTs by matching their `iss`/`aud` claims
 * against a provider listed here, then fetching `<domain>/.well-known/jwks.json`
 * for the signing keys. EVE's tokens are issued by Convex Auth itself
 * (`auth.ts` -> `CONVEX_SITE_URL` issuer, `"convex"` audience), so this
 * entry points back at this deployment's own HTTP endpoint, which serves
 * the JWKS via `auth.addHttpRoutes` in `http.ts`.
 */
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
