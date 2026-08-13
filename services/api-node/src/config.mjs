import path from "node:path";
import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    API_HOST: z.string().default("127.0.0.1"),
    API_PORT: z.coerce.number().int().positive().default(8080),
    EVE_DATA_DIR: z.string().default(".eve-data"),
    AUTH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),

    DATABASE_URL: z.string().url().optional(),
    // pg defaults connectionTimeoutMillis to 0, meaning acquires wait forever.
    // One dropped TLS handshake to a serverless database then wedges every
    // later request behind dead clients, so keep these bounded.
    DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

    GOOGLE_CLIENT_ID: z
      .string()
      .optional()
      .transform((v) => v || undefined),
    GOOGLE_CLIENT_SECRET: z
      .string()
      .optional()
      .transform((v) => v || undefined),
    GOOGLE_ANDROID_CLIENT_ID: z
      .string()
      .optional()
      .transform((v) => v || undefined),
    GOOGLE_REDIRECT_URI: z.string().url().optional(),

    GEMINI_API_KEY: z
      .string()
      .optional()
      .transform((v) => v || undefined),
    ANTHROPIC_API_KEY: z
      .string()
      .optional()
      .transform((v) => v || undefined),

    // Node's fetch has no default timeout, so a stalled Google connection
    // would hang a login request forever. The mobile client gives up at 25s.
    OUTBOUND_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

    AUTH_RATELIMIT_IP_PER_MIN: z.coerce.number().int().positive().default(5),
    AUTH_RATELIMIT_EMAIL_PER_15MIN: z.coerce.number().int().positive().default(20),

    // Bodies are buffered in memory before parsing, so without a ceiling one
    // large unauthenticated POST can grow the heap until the process dies.
    MAX_BODY_BYTES: z.coerce.number().int().positive().default(1024 * 1024),

    // Whether X-Forwarded-For may be believed when bucketing rate limits. Off by
    // default: the header is caller-supplied, so trusting it unconditionally
    // lets an attacker rotate it and walk straight through the login limiter.
    // Turn on only behind a proxy that overwrites the header rather than
    // appending to it.
    TRUST_PROXY: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  })
  .refine((v) => !v.GOOGLE_CLIENT_ID || (v.GOOGLE_CLIENT_SECRET && v.GOOGLE_REDIRECT_URI), {
    message: "GOOGLE_CLIENT_ID is set but GOOGLE_CLIENT_SECRET or GOOGLE_REDIRECT_URI is missing",
    path: ["GOOGLE_CLIENT_SECRET"],
  });

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  process.stderr.write(`Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

const env = parsed.data;
const projectRoot = path.resolve(import.meta.dirname, "..");

export const config = Object.freeze({
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === "production",
  isTest: env.NODE_ENV === "test",
  trustProxy: env.TRUST_PROXY,
  maxBodyBytes: env.MAX_BODY_BYTES,
  host: env.API_HOST,
  port: env.API_PORT,
  dataDir: path.isAbsolute(env.EVE_DATA_DIR) ? env.EVE_DATA_DIR : path.join(projectRoot, env.EVE_DATA_DIR),
  statePath: path.isAbsolute(env.EVE_DATA_DIR)
    ? path.join(env.EVE_DATA_DIR, "state.json")
    : path.join(projectRoot, env.EVE_DATA_DIR, "state.json"),
  authTokenTTLMs: env.AUTH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  logLevel: env.LOG_LEVEL,
  databaseUrl: env.DATABASE_URL,
  outboundTimeoutMs: env.OUTBOUND_TIMEOUT_MS,
  databaseConnectTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
  databaseStatementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
  google: env.GOOGLE_CLIENT_ID
    ? {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: /** @type {string} */ (env.GOOGLE_CLIENT_SECRET),
        androidClientId: env.GOOGLE_ANDROID_CLIENT_ID,
        redirectUri: /** @type {string} */ (env.GOOGLE_REDIRECT_URI),
      }
    : null,
  gemini: env.GEMINI_API_KEY ? { apiKey: env.GEMINI_API_KEY } : null,
  anthropic: env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : null,
  rateLimit: {
    authIpPerMin: env.AUTH_RATELIMIT_IP_PER_MIN,
    authEmailPer15Min: env.AUTH_RATELIMIT_EMAIL_PER_15MIN,
  },
});
