export type AppNodeEnv = 'development' | 'test' | 'production'

export type AppLogLevel =
  | 'fatal'
  | 'error'
  | 'warn'
  | 'info'
  | 'debug'
  | 'trace'
  | 'silent'

export type AppLogPretty = 'auto' | 'true' | 'false'

export type AppConfig = {
  nodeEnv: AppNodeEnv
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
  logLevel: AppLogLevel
  logPretty: AppLogPretty
}

export type LogBindings = Record<string, unknown>

export type LogMethod = (object: object, message?: string) => void

export type AppLogger = {
  debug: LogMethod
  error: LogMethod
  info: LogMethod
  warn: LogMethod
  child?: (bindings: LogBindings) => AppLogger
}
