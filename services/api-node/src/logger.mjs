import { pino } from "pino";
import { config } from "./config.mjs";

const transport = config.isProduction
  ? undefined
  : {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
    };

export const logger = pino({
  level: config.logLevel,
  base: { service: "eve-api", env: config.nodeEnv },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.token",
      "*.access_token",
      "*.refresh_token",
      "*.client_secret",
    ],
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
