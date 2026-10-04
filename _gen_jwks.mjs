import { exportJWK } from "jose";
import { createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "fs";
const pem = readFileSync("/tmp/jwt_private.pem", "utf8");
// Extract ONLY the public key so we never serve private params.
const publicKey = createPublicKey(pem);
const publicJWK = await exportJWK(publicKey);
const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicJWK }] });
const bad = ["d","p","q","dp","dq","qi"].some((k) => k in publicJWK);
console.log("private params present?", bad);
console.log("JWKS:", jwks.slice(0, 70), "...");
writeFileSync("/tmp/convex_jwks_env.txt", `JWKS=${jwks}\n`);
console.log("wrote /tmp/convex_jwks_env.txt");
