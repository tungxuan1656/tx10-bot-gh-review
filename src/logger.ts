import pino from "pino";

import type { AppConfig } from "./config.js";

function shouldUsePrettyLogs(config: Pick<AppConfig, "logPretty" | "nodeEnv">): boolean {
  if (config.logPretty === "true") {
    return true;
  }

  if (config.logPretty === "false") {
    return false;
  }

  return config.nodeEnv === "development" && process.stdout.isTTY;
}

export function createLogger(config: Pick<AppConfig, "logLevel" | "logPretty" | "nodeEnv">) {
  const prettyLogsEnabled = shouldUsePrettyLogs(config);

  return pino({
    level: config.logLevel,
    base: null,
    ...(prettyLogsEnabled
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              ignore: "pid,hostname",
              singleLine: true,
              translateTime: "HH:MM:ss.l",
            },
          },
        }
      : {}),
  });
}

export type AppLogger = ReturnType<typeof createLogger>;
