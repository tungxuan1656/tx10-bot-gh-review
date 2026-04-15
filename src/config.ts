import os from 'node:os'
import path from 'node:path'

import { z } from 'zod'

const logLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
])

const logPrettySchema = z.enum(['auto', 'true', 'false'])
const boolStringSchema = z.enum(['true', 'false'])
const defaultDiscussionCacheDirectory = path.join(
  os.tmpdir(),
  'tx10-review-discussions',
)

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(43191),
  GITHUB_TOKEN: z.string().min(1, 'GITHUB_TOKEN is required'),
  GITHUB_BOT_LOGIN: z.string().min(1, 'GITHUB_BOT_LOGIN is required'),
  GITHUB_WEBHOOK_SECRET: z.string().min(1, 'GITHUB_WEBHOOK_SECRET is required'),
  CODEX_BIN: z.string().min(1).default('codex'),
  CODEX_MODEL: z.string().min(1).default('gpt-5.3-codex'),
  CODEX_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  REVIEW_APPROVED_LOCK_ENABLED: boolStringSchema.default('true'),
  REVIEW_DISCUSSION_CACHE_DIR: z
    .string()
    .min(1)
    .default(defaultDiscussionCacheDirectory),
  REVIEW_DISCUSSION_CACHE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(604_800_000),
  LOG_LEVEL: logLevelSchema.default('info'),
  LOG_PRETTY: logPrettySchema.default('auto'),
})

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production'
  port: number
  githubToken: string
  githubBotLogin: string
  githubWebhookSecret: string
  codexBin: string
  codexModel: string
  codexTimeoutMs: number
  reviewApprovedLockEnabled: boolean
  reviewDiscussionCacheDir: string
  reviewDiscussionCacheTtlMs: number
  logLevel: z.infer<typeof logLevelSchema>
  logPretty: z.infer<typeof logPrettySchema>
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(source)

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    githubToken: parsed.GITHUB_TOKEN,
    githubBotLogin: parsed.GITHUB_BOT_LOGIN,
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
    codexBin: parsed.CODEX_BIN,
    codexModel: parsed.CODEX_MODEL,
    codexTimeoutMs: parsed.CODEX_TIMEOUT_MS,
    reviewApprovedLockEnabled: parsed.REVIEW_APPROVED_LOCK_ENABLED === 'true',
    reviewDiscussionCacheDir: parsed.REVIEW_DISCUSSION_CACHE_DIR,
    reviewDiscussionCacheTtlMs: parsed.REVIEW_DISCUSSION_CACHE_TTL_MS,
    logLevel: parsed.LOG_LEVEL,
    logPretty: parsed.LOG_PRETTY,
  }
}
