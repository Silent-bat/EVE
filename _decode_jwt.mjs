import { ConvexHttpClient } from "convex/browser";
const client = new ConvexHttpClient("https://artful-meadowlark-292.convex.cloud");
const email = `decode-${Date.now()}@eve-test.example`;
const result = await client.action("auth:signIn", { provider: "password", params: { email, password: "test-password-123", flow: "signUp" } });
const token = result.tokens.token;
const [h, p] = token.split(".");
const dec = (s) => JSON.parse(Buffer.from(s.replace(/-/g,"+").replace(/_/g,"/"), "base64").toString());
console.log("HEADER:", JSON.stringify(dec(h)));
console.log("PAYLOAD:", JSON.stringify(dec(p), null, 2));
