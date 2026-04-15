import pino from 'pino'

import type { AppConfig } from './config.js'

type LogBindings = Record<string, unknown>
type LogMethod = (object: object, message?: string) => void

function shouldUsePrettyLogs(
  config: Pick<AppConfig, 'logPretty' | 'nodeEnv'>,
): boolean {
  if (config.logPretty === 'true') {
    return true
  }

  if (config.logPretty === 'false') {
    return false
  }

  return config.nodeEnv === 'development' && process.stdout.isTTY
}

export function createLogger(
  config: Pick<AppConfig, 'logLevel' | 'logPretty' | 'nodeEnv'>,
) {
  const prettyLogsEnabled = shouldUsePrettyLogs(config)

  return pino({
    level: config.logLevel,
    base: null,
    ...(prettyLogsEnabled
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              ignore: 'pid,hostname',
              messageFormat:
                '{msg} event={event} status={status} action={action} deliveryId={deliveryId} repo={owner}/{repo}#{pullNumber} headSha={headSha} reason={reason} runKey={runKey}',
              singleLine: true,
              translateTime: 'HH:MM:ss.l',
            },
          },
        }
      : {}),
  })
}

export type AppLogger = ReturnType<typeof createLogger>

function isObject(value: unknown): value is LogBindings {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bindLogMethod(method: LogMethod, bindings: LogBindings): LogMethod {
  return (object: object, message?: string) => {
    method({ ...bindings, ...(isObject(object) ? object : {}) }, message)
  }
}

export function createChildLogger(
  logger: AppLogger,
  bindings: LogBindings,
): AppLogger {
  const childFactory = (
    logger as unknown as { child?: (bindings: LogBindings) => AppLogger }
  ).child

  if (typeof childFactory === 'function') {
    return childFactory.call(logger, bindings)
  }

  const fallbackLogger = {
    ...logger,
    debug: bindLogMethod(logger.debug.bind(logger) as LogMethod, bindings),
    error: bindLogMethod(logger.error.bind(logger) as LogMethod, bindings),
    info: bindLogMethod(logger.info.bind(logger) as LogMethod, bindings),
    warn: bindLogMethod(logger.warn.bind(logger) as LogMethod, bindings),
  } as unknown as AppLogger

  ;(
    fallbackLogger as unknown as {
      child: (nextBindings: LogBindings) => AppLogger
    }
  ).child = (nextBindings: LogBindings) =>
    createChildLogger(logger, { ...bindings, ...nextBindings })

  return fallbackLogger
}
