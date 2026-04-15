import express from 'express'
import { Webhooks } from '@octokit/webhooks'

import type { AppConfig } from '../config.js'
import { createChildLogger } from '../logger.js'
import type { AppLogger } from '../logger.js'
import { normalizePullRequestEvent } from '../review/webhook-event.js'
import type { ReviewService } from '../review/service.js'

export function createServer(input: {
  config: Pick<AppConfig, 'githubBotLogin' | 'githubWebhookSecret'>
  logger: AppLogger
  reviewService: ReviewService
}) {
  const app = express()
  const webhooks = new Webhooks({
    secret: input.config.githubWebhookSecret,
  })

  app.get('/healthz', (_request, response) => {
    response.status(200).json({ status: 'ok' })
  })

  app.post(
    '/github/webhooks',
    express.raw({
      type: 'application/json',
      limit: '2mb',
    }),
    async (request, response) => {
      const eventName = request.header('x-github-event')
      const signature = request.header('x-hub-signature-256')
      const deliveryId = request.header('x-github-delivery')
      const body = Buffer.isBuffer(request.body)
        ? request.body.toString('utf8')
        : JSON.stringify(request.body ?? {})

      if (!eventName || !signature || !deliveryId) {
        input.logger.warn(
          {
            component: 'http',
            event: 'webhook.rejected',
            hasDeliveryId: Boolean(deliveryId),
            hasEventName: Boolean(eventName),
            hasSignature: Boolean(signature),
            reason: 'missing_headers',
            status: 'rejected',
          },
          'Webhook rejected',
        )
        response.status(400).json({ error: 'Missing GitHub webhook headers.' })
        return
      }

      let payload: unknown
      try {
        payload = JSON.parse(body)
      } catch {
        payload = null
      }

      const normalizedEvent =
        eventName === 'pull_request' && payload !== null
          ? normalizePullRequestEvent({
              botLogin: input.config.githubBotLogin,
              deliveryId,
              payload,
            })
          : null
      const requestLogger = createChildLogger(input.logger, {
        component: 'http',
        deliveryId,
        ...(normalizedEvent?.success
          ? {
              action: normalizedEvent.data.action,
              headSha: normalizedEvent.data.headSha,
              owner: normalizedEvent.data.owner,
              pullNumber: normalizedEvent.data.pullNumber,
              repo: normalizedEvent.data.repo,
              requestedReviewerLogin:
                normalizedEvent.data.requestedReviewerLogin,
              senderLogin: normalizedEvent.data.senderLogin,
            }
          : {}),
      })

      requestLogger.info(
        {
          event: 'webhook.received',
          eventName,
          status: 'received',
        },
        'Webhook received',
      )

      const isValid = await webhooks.verify(body, signature)
      if (!isValid) {
        requestLogger.warn(
          {
            event: 'webhook.rejected',
            eventName,
            reason: 'invalid_signature',
            status: 'rejected',
          },
          'Webhook rejected',
        )
        response.status(401).json({ error: 'Invalid webhook signature.' })
        return
      }

      requestLogger.info(
        {
          event: 'webhook.verified',
          eventName,
          status: 'verified',
        },
        'Webhook verified',
      )

      if (payload === null) {
        requestLogger.warn(
          {
            event: 'webhook.rejected',
            eventName,
            reason: 'invalid_json',
            status: 'rejected',
          },
          'Webhook rejected',
        )
        response.status(400).json({ error: 'Invalid JSON payload.' })
        return
      }

      if (eventName === 'pull_request') {
        if (!normalizedEvent?.success) {
          requestLogger.warn(
            {
              event: 'webhook.routed',
              eventName,
              issues: normalizedEvent?.issues ?? [],
              reason: 'invalid_pull_request_payload',
              status: 'ignored',
            },
            'Webhook routed',
          )
        } else {
          void input.reviewService.handlePullRequestEvent(normalizedEvent.data)
        }
      } else {
        requestLogger.info(
          {
            event: 'webhook.routed',
            eventName,
            reason: 'unsupported_event',
            status: 'ignored',
          },
          'Webhook routed',
        )
      }

      response.status(202).json({ status: 'accepted' })
    },
  )

  return app
}
