// E2E test via ConvexHttpClient (no WebSocket).
import { ConvexHttpClient } from "convex/browser";
import { api } from "./convex/_generated/api.js";

const baseUrl = "https://artful-meadowlark-292.convex.cloud";
const client = new ConvexHttpClient(baseUrl);

const email = `e2e-${Date.now()}@eve-test.example`;
const password = "test-password-123";
const TIMEOUT = 20000;

const withTimeout = (p, label) =>
  Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), TIMEOUT)),
  ]);

console.log("1. signIn (password, signUp flow)…");
const result = await withTimeout(
  client.action("auth:signIn", { provider: "password", params: { email, password, flow: "signUp" } }),
  "signIn",
);
const token = result?.tokens?.token;
if (!token) { console.log("   NO TOKEN"); process.exit(1); }
console.log("   -> token OK (len " + token.length + ")");

client.setAuth(token);
console.log("2. getCurrentUser…");
const session = await withTimeout(client.query(api.users.getCurrentUser, {}), "getCurrentUser");
console.log("   ->", JSON.stringify(session));

console.log("3. getTodayBriefing…");
console.log("   ->", JSON.stringify(await withTimeout(client.query(api.briefings.getTodayBriefing, {}), "briefing")));

console.log("4. getAuditLog…");
console.log("   ->", JSON.stringify(await withTimeout(client.query(api.briefings.getAuditLog, {}), "audit")));

console.log("5. updateDisplayName…");
try {
  console.log("   ->", JSON.stringify(await withTimeout(client.mutation(api.users.updateDisplayName, { displayName: "E2E Tester" }), "rename")));
} catch (e) { console.log("   -> ERROR", e.message); }

console.log("6. recordDeviceNotification + read back…");
try {
  await withTimeout(client.mutation(api.notifications.recordDeviceNotification, { notification: { id: "n1", title: "hi" } }), "record");
  console.log("   ->", JSON.stringify((await withTimeout(client.query(api.notifications.getDeviceNotifications, {}), "getNotifs")).entries?.length, "notifs"));
} catch (e) { console.log("   -> ERROR", e.message); }

console.log("7. isAuthenticated…");
console.log("   ->", JSON.stringify(await withTimeout(client.query(api.auth.isAuthenticated, {}), "isAuth")));

console.log("8. signOut…");
try {
  console.log("   ->", JSON.stringify(await withTimeout(client.action("auth:signOut", {}), "signOut")));
} catch (e) { console.log("   -> ERROR", e.message); }

console.log("ALL DONE");
process.exit(0);
