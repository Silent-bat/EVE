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

    // Treat an empty value from a copied .env file as unset. An empty string
    // is not a usable URL and should not make a development boot fail before
    // the optional JSON fallback can be selected.
    DATABASE_URL: z.preprocess(
      (value) => (typeof value === "string" && !value.trim() ? undefined : value),
      z.string().url().optional(),
    ),
    // Comma-separated browser origins. Native clients do not send an Origin
    // header; in production an empty list therefore means no browser CORS
    // access, while development keeps the convenient wildcard fallback.
    CORS_ORIGINS: z
      .string()
      .default("")
      .transform((value, ctx) => {
        const entries = value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        const origins = [];
        for (const entry of entries) {
          try {
            const parsed = new URL(entry);
            if (
              !["http:", "https:"].includes(parsed.protocol) ||
              parsed.username ||
              parsed.password ||
              parsed.pathname !== "/" ||
              parsed.search ||
              parsed.hash
            ) {
              throw new Error("origin must be an http(s) origin without a path");
            }
            origins.push(parsed.origin);
          } catch {
            ctx.addIssue({ code: "custom", message: `invalid CORS origin: ${entry}` });
          }
        }
        return [...new Set(origins)];
      }),
    // pg defaults connectionTimeoutMillis to 0, meaning acquires wait forever.
    // One dropped TLS handshake to a serverless database then wedges every
    // later request behind dead clients, so keep these bounded.
    DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
    DATABASE_SSL_REJECT_UNAUTHORIZED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),

    // Used to encrypt OAuth credentials before they cross the storage boundary.
    // A production process must receive this from a secret manager; it is never
    // generated or persisted by the application.
    STATE_ENCRYPTION_KEY: z
      .string()
      .optional()
      .transform((v) => v || undefined),

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
    MAX_BODY_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(1024 * 1024),

    // Whether X-Forwarded-For may be believed when bucketing rate limits. Off by
    // default: the header is caller-supplied, so trusting it unconditionally
    // lets an attacker rotate it and walk straight through the login limiter.
    // Turn on only behind a proxy that overwrites the header rather than
    // appending to it.
    TRUST_PROXY: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),

    // Per-user budgets for expensive AI/audio endpoints.
    USER_RATELIMIT_PER_MIN: z.coerce.number().int().positive().default(30),
    VOICE_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().positive().max(8).default(2),
    VOICE_MAX_AUDIO_BYTES: z.coerce.number().int().positive().max(20_000_000).default(2_000_000),
    VOICE_MAX_SESSION_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(60 * 60 * 1000)
      .default(15 * 60 * 1000),
    VOICE_IDLE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(60 * 60 * 1000)
      .default(10 * 60 * 1000),

    // Bound provider responses and model context so one unusually large email
    // or upstream error cannot consume unbounded heap or Gemini tokens.
    GOOGLE_RESPONSE_MAX_BYTES: z.coerce.number().int().positive().max(20_000_000).default(2_000_000),
    GMAIL_MAX_BODY_CHARS: z.coerce.number().int().positive().max(200_000).default(20_000),
    GMAIL_FETCH_CONCURRENCY: z.coerce.number().int().positive().max(20).default(6),
    GEMINI_PROMPT_MAX_CHARS: z.coerce.number().int().positive().max(500_000).default(120_000),
    // Captured device notifications can contain private message previews. Keep
    // their lifetime bounded even when an account remains active indefinitely.
    DEVICE_NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().positive().max(3650).default(30),
  })
  .refine((v) => !v.GOOGLE_CLIENT_ID || (v.GOOGLE_CLIENT_SECRET && v.GOOGLE_REDIRECT_URI), {
    message: "GOOGLE_CLIENT_ID is set but GOOGLE_CLIENT_SECRET or GOOGLE_REDIRECT_URI is missing",
    path: ["GOOGLE_CLIENT_SECRET"],
  })
  .refine((v) => v.NODE_ENV !== "production" || Boolean(v.STATE_ENCRYPTION_KEY), {
    message: "STATE_ENCRYPTION_KEY is required in production",
    path: ["STATE_ENCRYPTION_KEY"],
  })
  .refine((v) => v.NODE_ENV !== "production" || Boolean(v.DATABASE_URL), {
    message: "DATABASE_URL is required in production; JSON storage is development-only",
    path: ["DATABASE_URL"],
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
  corsOrigins: env.CORS_ORIGINS,
  outboundTimeoutMs: env.OUTBOUND_TIMEOUT_MS,
  databaseConnectTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
  databaseStatementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
  databaseSSLRejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED,
  stateEncryptionKey: env.STATE_ENCRYPTION_KEY,
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
    userPerMin: env.USER_RATELIMIT_PER_MIN,
  },
  voice: {
    maxConnectionsPerUser: env.VOICE_MAX_CONNECTIONS_PER_USER,
    maxAudioBytes: env.VOICE_MAX_AUDIO_BYTES,
    maxSessionMs: env.VOICE_MAX_SESSION_MS,
    idleTimeoutMs: env.VOICE_IDLE_TIMEOUT_MS,
  },
  googleResponseMaxBytes: env.GOOGLE_RESPONSE_MAX_BYTES,
  gmailMaxBodyChars: env.GMAIL_MAX_BODY_CHARS,
  gmailFetchConcurrency: env.GMAIL_FETCH_CONCURRENCY,
  geminiPromptMaxChars: env.GEMINI_PROMPT_MAX_CHARS,
  deviceNotificationRetentionDays: env.DEVICE_NOTIFICATION_RETENTION_DAYS,
});
