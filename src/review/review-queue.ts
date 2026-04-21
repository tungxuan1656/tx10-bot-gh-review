import type { AppLogger } from '../logger.js'
import type { NormalizedPullRequestEvent } from './webhook-event.js'
import type { PullRequestContext } from './types.js'
import { buildPullRequestKey, toPullRequestContext } from './service-helpers.js'

export type QueueCancelReason = 'cancel_requested'

export type QueueRequest = {
  enqueuedAt: number
  completion: Promise<void>
  event: NormalizedPullRequestEvent
  resolveCompletion: () => void
}

export type ActiveRun = {
  abortController: AbortController
  cancellationLogged: boolean
  cancellationReason: QueueCancelReason | null
  context: PullRequestContext
  pullRequestKey: string
  runKey: string
}

export type ActiveRunRef = {
  current: ActiveRun | null
}

function createCompletion(): {
  completion: Promise<void>
  resolveCompletion: () => void
} {
  let resolveCompletion!: () => void

  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })

  return {
    completion,
    resolveCompletion,
  }
}

export class ReviewQueueManager {
  private readonly queue: QueueRequest[] = []
  private readonly queuedByPullRequestKey = new Map<string, QueueRequest>()
  private queueDrainInProgress = false

  constructor(
    private readonly activeRunRef: ActiveRunRef,
    private readonly reviewPullRequest: (
      event: NormalizedPullRequestEvent,
      deliveryLogger: AppLogger,
    ) => Promise<void>,
    private readonly createDeliveryLogger: (
      event: NormalizedPullRequestEvent,
    ) => AppLogger,
  ) {}

  async enqueueReview(
    event: NormalizedPullRequestEvent,
    deliveryLogger: AppLogger,
  ): Promise<void> {
    const context = toPullRequestContext(event)
    const pullRequestKey = buildPullRequestKey(context)

    const inFlightRun = this.activeRunRef.current
    if (
      inFlightRun &&
      inFlightRun.pullRequestKey === pullRequestKey &&
      inFlightRun.context.headSha === context.headSha
    ) {
      deliveryLogger.info(
        {
          event: 'review.queue_ignored',
          reason: 'duplicate_inflight',
          runKey: inFlightRun.runKey,
          status: 'ignored',
        },
        'Review queued event ignored',
      )
      return
    }

    const existingQueued = this.queuedByPullRequestKey.get(pullRequestKey)
    if (existingQueued?.event.headSha === context.headSha) {
      deliveryLogger.info(
        {
          event: 'review.queue_ignored',
          reason: 'duplicate_queued',
          status: 'ignored',
        },
        'Review queued event ignored',
      )
      return
    }

    if (existingQueued) {
      this.removeQueuedRequest(pullRequestKey)
    }

    const request: QueueRequest = {
      ...createCompletion(),
      enqueuedAt: Date.now(),
      event,
    }

    this.queue.push(request)
    this.queuedByPullRequestKey.set(pullRequestKey, request)

    deliveryLogger.info(
      {
        event: 'review.enqueued',
        queueLength: this.queue.length,
        reason: 'trigger_review',
        routedReason: event.actionKind,
        status: 'queued',
      },
      'Review enqueued',
    )

    this.drainQueue()
    await request.completion
  }

  cancelQueuedAndActivePullRequest(
    event: NormalizedPullRequestEvent,
    deliveryLogger: AppLogger,
  ): void {
    const context = toPullRequestContext(event)
    const pullRequestKey = buildPullRequestKey(context)
    const removedQueuedRequest = this.removeQueuedRequest(pullRequestKey)

    const inFlightRun = this.activeRunRef.current
    const canceledActiveRun =
      inFlightRun?.pullRequestKey === pullRequestKey
        ? this.requestRunCancellation(
            inFlightRun,
            'cancel_requested',
            deliveryLogger,
          )
        : false

    if (!removedQueuedRequest && !canceledActiveRun) {
      deliveryLogger.info(
        {
          event: 'review.cancel_missed',
          reason: 'cancel_requested',
          status: 'cancel_missed',
        },
        'Review cancel missed',
      )
      return
    }

    deliveryLogger.info(
      {
        canceledActiveRun,
        event: 'review.cancel_requested',
        queueLength: this.queue.length,
        removedQueuedRequest,
        status: 'cancel_requested',
      },
      'Review cancel requested',
    )
  }

  hasPendingReviewForPullRequest(pullRequestKey: string): boolean {
    return (
      this.activeRunRef.current?.pullRequestKey === pullRequestKey ||
      this.queuedByPullRequestKey.has(pullRequestKey)
    )
  }

  get queueLength(): number {
    return this.queue.length
  }

  shouldStopForCancellation(
    runLogger: AppLogger,
    run: ActiveRun,
    stage: string,
  ): boolean {
    if (!run.abortController.signal.aborted) {
      return false
    }

    if (!run.cancellationLogged) {
      run.cancellationLogged = true
      runLogger.info(
        {
          event: 'review.canceled',
          reason: run.cancellationReason ?? 'cancel_requested',
          runKey: run.runKey,
          stage,
          status: 'canceled',
        },
        'Review canceled',
      )
    }

    return true
  }

  private removeQueuedRequest(pullRequestKey: string): boolean {
    const request = this.queuedByPullRequestKey.get(pullRequestKey)
    if (!request) {
      return false
    }

    this.queuedByPullRequestKey.delete(pullRequestKey)
    const requestIndex = this.queue.indexOf(request)
    if (requestIndex >= 0) {
      this.queue.splice(requestIndex, 1)
    }

    request.resolveCompletion()

    return true
  }

  private requestRunCancellation(
    run: ActiveRun,
    reason: QueueCancelReason,
    deliveryLogger: AppLogger,
  ): boolean {
    if (run.abortController.signal.aborted) {
      return false
    }

    run.cancellationReason = reason
    run.abortController.abort()
    deliveryLogger.info(
      {
        event: 'review.cancel_requested',
        reason,
        runKey: run.runKey,
        status: 'cancel_requested',
      },
      'Review cancel requested',
    )
    return true
  }

  private drainQueue(): void {
    if (this.queueDrainInProgress) {
      return
    }

    this.queueDrainInProgress = true
    void this.runQueueDrain()
  }

  private async runQueueDrain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const queuedRequest = this.queue.shift()
        if (!queuedRequest) {
          continue
        }

        const context = toPullRequestContext(queuedRequest.event)
        const pullRequestKey = buildPullRequestKey(context)

        if (this.queuedByPullRequestKey.get(pullRequestKey) === queuedRequest) {
          this.queuedByPullRequestKey.delete(pullRequestKey)
        }

        await this.reviewPullRequest(
          queuedRequest.event,
          this.createDeliveryLogger(queuedRequest.event),
        )
        queuedRequest.resolveCompletion()
      }
    } finally {
      this.queueDrainInProgress = false
      if (this.queue.length > 0) {
        this.drainQueue()
      }
    }
  }
}
