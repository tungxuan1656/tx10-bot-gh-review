import { describe, expect, it, vi } from 'vitest'

import type { AppLogger } from '../src/logger.js'
import { ReviewQueueManager, type ActiveRun, type ActiveRunRef } from '../src/review/review-queue.js'
import type { NormalizedPullRequestEvent } from '../src/review/webhook-event.js'
import type { PullRequestContext } from '../src/review/types.js'

function createLoggerStub(): AppLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as AppLogger
}

function createPullRequestEvent(
  overrides: Partial<NormalizedPullRequestEvent> = {},
): NormalizedPullRequestEvent {
  return {
    action: 'review_requested',
    actionKind: 'review_requested',
    afterSha: null,
    baseSha: 'def456',
    beforeSha: null,
    botStillRequested: null,
    deliveryId: 'delivery-123',
    eventName: 'pull_request',
    headSha: 'abc123',
    htmlUrl: 'https://github.com/acme/repo/pull/42',
    owner: 'acme',
    pullNumber: 42,
    repo: 'repo',
    requestedReviewerLogin: 'review-bot',
    requestedReviewerLogins: ['review-bot'],
    senderLogin: 'octocat',
    title: 'Add a review flow',
    headRef: 'feature/review-flow',
    headCloneUrl: 'https://github.com/acme/repo.git',
    baseRef: 'main',
    baseCloneUrl: 'https://github.com/acme/repo.git',
    ...overrides,
  }
}

function createPullRequestContext(): PullRequestContext {
  return {
    action: 'review_requested',
    installationId: 0,
    owner: 'acme',
    repo: 'repo',
    pullNumber: 42,
    title: 'Add a review flow',
    htmlUrl: 'https://github.com/acme/repo/pull/42',
    headSha: 'abc123',
    headRef: 'feature/review-flow',
    headCloneUrl: 'https://github.com/acme/repo.git',
    baseSha: 'def456',
    baseRef: 'main',
    baseCloneUrl: 'https://github.com/acme/repo.git',
  }
}

function createActiveRun(
  context: PullRequestContext,
  pullRequestKey = 'acme/repo#42',
  runKey = 'acme/repo#42@abc123',
): ActiveRun {
  return {
    abortController: new AbortController(),
    cancellationLogged: false,
    cancellationReason: null,
    context,
    pullRequestKey,
    runKey,
  }
}

function createQueueManager(
  activeRunRef: ActiveRunRef = { current: null },
  reviewPullRequest: (
    event: NormalizedPullRequestEvent,
    deliveryLogger: AppLogger,
  ) => Promise<void> = vi.fn(() => Promise.resolve()),
) {
  const createDeliveryLogger = vi.fn(() => createLoggerStub())

  return {
    activeRunRef,
    createDeliveryLogger,
    manager: new ReviewQueueManager(
      activeRunRef,
      reviewPullRequest,
      createDeliveryLogger,
    ),
    reviewPullRequest,
  }
}

describe('ReviewQueueManager', () => {
  it('enqueues and drains a review', async () => {
    const reviewPullRequest = vi.fn(() => Promise.resolve())
    const { manager } = createQueueManager({ current: null }, reviewPullRequest)
    const event = createPullRequestEvent()

    await expect(manager.enqueueReview(event, createLoggerStub())).resolves.toBeUndefined()
    expect(reviewPullRequest).toHaveBeenCalledTimes(1)
    expect(manager.queueLength).toBe(0)
  })

  it('ignores duplicate in-flight reviews', async () => {
    const activeRunRef: ActiveRunRef = {
      current: createActiveRun(
        createPullRequestContext(),
        'acme/repo#42',
        'acme/repo#42@abc123',
      ),
    }
    const { manager, reviewPullRequest } = createQueueManager(activeRunRef)

    await expect(
      manager.enqueueReview(createPullRequestEvent(), createLoggerStub()),
    ).resolves.toBeUndefined()

    expect(reviewPullRequest).not.toHaveBeenCalled()
  })

  it('reports pending reviews from either active or queued state', () => {
    const activeRunRef: ActiveRunRef = {
      current: createActiveRun(createPullRequestContext()),
    }
    const { manager } = createQueueManager(activeRunRef)

    expect(manager.hasPendingReviewForPullRequest('acme/repo#42')).toBe(true)
    expect(manager.hasPendingReviewForPullRequest('acme/repo#99')).toBe(false)
  })

  it('cancels an active request and logs once', () => {
    const activeRun = createActiveRun(createPullRequestContext())
    const activeRunRef: ActiveRunRef = { current: activeRun }
    const { manager } = createQueueManager(activeRunRef)
    const logger = createLoggerStub()

    manager.cancelQueuedAndActivePullRequest(createPullRequestEvent(), logger)

    expect(activeRun.abortController.signal.aborted).toBe(true)
    expect(activeRun.cancellationReason).toBe('cancel_requested')
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'review.cancel_requested',
        reason: 'cancel_requested',
        status: 'cancel_requested',
      }),
      'Review cancel requested',
    )
  })

  it('logs cancellation state only once', () => {
    const activeRun = createActiveRun(createPullRequestContext())
    activeRun.abortController.abort()
    const logger = createLoggerStub()
    const { manager } = createQueueManager({ current: activeRun })

    expect(
      manager.shouldStopForCancellation(logger, activeRun, 'after_idempotency'),
    ).toBe(true)
    expect(
      manager.shouldStopForCancellation(logger, activeRun, 'after_pr_info'),
    ).toBe(true)
    expect(logger.info).toHaveBeenCalledTimes(1)
  })
})
