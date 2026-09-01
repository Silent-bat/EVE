import { pino } from "pino";
import { config } from "./config.mjs";

const transport = config.isProduction
  ? undefined
  : {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
    };

const SENSITIVE_LOG_KEYS = [
  "password",
  "passwordHash",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "clientSecret",
  "apiKey",
  "api_key",
];

// Keep credential keys in one exported list so the logger and its regression
// test cannot silently drift. Pino's wildcard is one path segment, so generate
// several bounded depths: errors often wrap provider responses under
// `err.cause.response`, and redacting only root/one-level objects leaks those.
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "authorization",
  "cookie",
  ...SENSITIVE_LOG_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`, `*.*.*.*.${key}`]),
];

export const logger = pino({
  level: config.logLevel,
  base: { service: "eve-api", env: config.nodeEnv },
  redact: {
    paths: REDACT_PATHS,
    censor: "[redacted]",
  },
  transport,
});

/**
 * @param {string} module
 * @returns {import("pino").Logger}
 */
export function moduleLogger(module) {
  return logger.child({ module });
}
