import { z } from "zod";

const logLevelSchema = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

const logPrettySchema = z.enum(["auto", "true", "false"]);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(43191),
  GITHUB_TOKEN: z.string().min(1, "GITHUB_TOKEN is required"),
  GITHUB_BOT_LOGIN: z.string().min(1, "GITHUB_BOT_LOGIN is required"),
  GITHUB_WEBHOOK_SECRET: z.string().min(1, "GITHUB_WEBHOOK_SECRET is required"),
  CODEX_BIN: z.string().min(1).default("codex"),
  LOG_LEVEL: logLevelSchema.default("info"),
  LOG_PRETTY: logPrettySchema.default("auto"),
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  githubToken: string;
  githubBotLogin: string;
  githubWebhookSecret: string;
  codexBin: string;
  logLevel: z.infer<typeof logLevelSchema>;
  logPretty: z.infer<typeof logPrettySchema>;
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(source);

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    githubToken: parsed.GITHUB_TOKEN,
    githubBotLogin: parsed.GITHUB_BOT_LOGIN,
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
    codexBin: parsed.CODEX_BIN,
    logLevel: parsed.LOG_LEVEL,
    logPretty: parsed.LOG_PRETTY,
  };
}
