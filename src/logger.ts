import pino from 'pino'

import type { AppConfig, AppLogger, LogBindings, LogMethod } from './types/app.js'

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

export type { AppLogger } from './types/app.js'

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
    debug: bindLogMethod(logger.debug.bind(logger), bindings),
    error: bindLogMethod(logger.error.bind(logger), bindings),
    info: bindLogMethod(logger.info.bind(logger), bindings),
    warn: bindLogMethod(logger.warn.bind(logger), bindings),
  } as unknown as AppLogger

  ;(
    fallbackLogger as unknown as {
      child: (nextBindings: LogBindings) => AppLogger
    }
  ).child = (nextBindings: LogBindings) =>
    createChildLogger(logger, { ...bindings, ...nextBindings })

  return fallbackLogger
}
