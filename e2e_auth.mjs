// End-to-end auth test against the live dev deployment.
import { ConvexClient } from "convex/browser";
import { api } from "./convex/_generated/api.js";

const baseUrl = "https://artful-meadowlark-292.convex.cloud";
const client = new ConvexClient(baseUrl);

const email = `e2e-${Date.now()}@eve-test.example`;
const password = "test-password-123";

console.log("1. signIn (password) via auth:signIn action…");
const result = await client.action("auth:signIn", {
  provider: "password",
  params: { email, password, flow: "signUp" },
});
console.log("   ->", JSON.stringify(result).slice(0, 220));

const token = result?.tokens?.token ?? result?.token;
const refreshToken = result?.tokens?.refreshToken;
if (!token) { console.log("NO TOKEN — signIn failed"); process.exit(1); }
client.setAuth(async ({ forceRefreshToken }) => {
  if (!forceRefreshToken) return token;
  const r = await client.action("auth:signIn", {
    provider: "password",
    params: { email, password, flow: "signIn" },
  });
  return r?.tokens?.token ?? token;
});
await new Promise((r) => setTimeout(r, 2000));

console.log("2. query getCurrentUser…");
const session = await client.query(api.users.getCurrentUser, {});
console.log("   ->", JSON.stringify(session));

console.log("3. query getTodayBriefing…");
console.log("   ->", JSON.stringify(await client.query(api.briefings.getTodayBriefing, {})));

console.log("4. query getAuditLog…");
console.log("   ->", JSON.stringify(await client.query(api.briefings.getAuditLog, {})));

console.log("5. mutation updateDisplayName…");
try {
  console.log("   ->", JSON.stringify(await client.mutation(api.users.updateDisplayName, { displayName: "E2E Tester" })));
} catch (e) { console.log("   -> ERROR", e.message); }

console.log("6. query isAuthenticated…");
console.log("   ->", JSON.stringify(await client.query(api.auth.isAuthenticated, {})));

console.log("7. signOut…");
try {
  console.log("   ->", JSON.stringify(await client.action("auth:signOut", {})));
} catch (e) { console.log("   -> ERROR", e.message); }

console.log("DONE");
process.exit(0);
