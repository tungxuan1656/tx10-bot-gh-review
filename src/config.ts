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

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(43191),
  GITHUB_APP_ID: z.string().min(1, "GITHUB_APP_ID is required"),
  GITHUB_PRIVATE_KEY: z.string().min(1, "GITHUB_PRIVATE_KEY is required"),
  GITHUB_WEBHOOK_SECRET: z.string().min(1, "GITHUB_WEBHOOK_SECRET is required"),
  GITHUB_INSTALLATION_ID: z.coerce.number().int().positive().optional(),
  CODEX_BIN: z.string().min(1).default("codex"),
  LOG_LEVEL: logLevelSchema.default("info"),
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  githubAppId: string;
  githubPrivateKey: string;
  githubWebhookSecret: string;
  githubInstallationId?: number;
  codexBin: string;
  logLevel: z.infer<typeof logLevelSchema>;
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(source);

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    githubAppId: parsed.GITHUB_APP_ID,
    githubPrivateKey: parsed.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n"),
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
    ...(parsed.GITHUB_INSTALLATION_ID
      ? { githubInstallationId: parsed.GITHUB_INSTALLATION_ID }
      : {}),
    codexBin: parsed.CODEX_BIN,
    logLevel: parsed.LOG_LEVEL,
  };
}
