import { createChildLogger } from '../logger.js'
import type { AppLogger } from '../types/app.js'
import { ReviewQueueManager, type ActiveRunRef } from './review-queue.js'
import { buildPullRequestKey, toPullRequestContext } from './service-helpers.js'
import { reviewPullRequest } from './review-execution.js'
import { setPullRequestReaction } from './review-publishing.js'
import {
  isApprovedLockedByPlatform,
  resolveRoutedEvent,
  shouldReactToIgnoredEvent,
} from './service-helpers-runtime.js'
import type {
  CodexRunner,
  NormalizedPullRequestEvent,
  PullRequestContext,
  ReviewPlatform,
  ReviewServiceOptions,
  ReviewWorkspaceManager,
} from './types.js'

export class ReviewService {
  private readonly approvedLockedPullRequests = new Set<string>()

  private readonly approvedLockEnabled: boolean
  private readonly discussionCacheOptions: ReviewServiceOptions

  private readonly activeRunRef: ActiveRunRef = { current: null }
  private readonly queueManager: ReviewQueueManager

  constructor(
    private readonly github: ReviewPlatform,
    private readonly codex: CodexRunner,
    private readonly workspaceManager: ReviewWorkspaceManager,
    private readonly logger: AppLogger,
    private readonly botLogin: string,
    options: ReviewServiceOptions = {},
  ) {
    this.approvedLockEnabled = options.approvedLockEnabled ?? true
    this.discussionCacheOptions = options
    this.queueManager = new ReviewQueueManager(
      this.activeRunRef,
      (event, deliveryLogger) =>
        reviewPullRequest({
          activeRunRef: this.activeRunRef,
          approvedLockEnabled: this.approvedLockEnabled,
          approvedLockedPullRequests: this.approvedLockedPullRequests,
          codex: this.codex,
          deliveryLogger,
          discussionCacheOptions: this.discussionCacheOptions,
          event,
          github: this.github,
          queueManager: this.queueManager,
          workspaceManager: this.workspaceManager,
        }),
      this.createDeliveryLogger.bind(this),
    )
  }

  async handlePullRequestEvent(
    event: NormalizedPullRequestEvent,
  ): Promise<void> {
    const deliveryLogger = this.createDeliveryLogger(event)
    const context = toPullRequestContext(event)
    const pullRequestKey = buildPullRequestKey(context)
    const routedEvent = await resolveRoutedEvent({
      botLogin: this.botLogin,
      context,
      deliveryLogger,
      event,
      isApprovedLocked: this.isApprovedLocked.bind(this),
    })

    deliveryLogger.info(
      {
        beforeSha: event.beforeSha,
        botStillRequested: event.botStillRequested,
        event: 'webhook.routed',
        requestedReviewerLogins: event.requestedReviewerLogins,
        status: routedEvent.status,
        ...(routedEvent.status !== 'trigger_review'
          ? { reason: routedEvent.reason }
          : {}),
      },
      'Webhook routed',
    )

    if (routedEvent.status === 'ignored') {
      if (shouldReactToIgnoredEvent({
        hasPendingReviewForPullRequest:
          this.queueManager.hasPendingReviewForPullRequest(pullRequestKey),
        routedEvent,
      })) {
        await setPullRequestReaction({
          context,
          deliveryLogger,
          github: this.github,
          reaction: 'laugh',
          reason: 'ignored_event',
        })
      }

      return
    }

    if (routedEvent.status === 'cancel_requested') {
      this.queueManager.cancelQueuedAndActivePullRequest(event, deliveryLogger)
      return
    }

    await this.queueManager.enqueueReview(event, deliveryLogger)
  }

  private async isApprovedLocked(
    context: PullRequestContext,
    pullRequestKey: string,
    deliveryLogger: AppLogger,
  ): Promise<boolean> {
    return isApprovedLockedByPlatform({
      approvedLockEnabled: this.approvedLockEnabled,
      approvedLockedPullRequests: this.approvedLockedPullRequests,
      context,
      deliveryLogger,
      github: this.github,
      pullRequestKey,
    })
  }

  private createDeliveryLogger(event: NormalizedPullRequestEvent): AppLogger {
    return createChildLogger(this.logger, {
      action: event.action,
      component: 'review',
      deliveryId: event.deliveryId,
      eventName: event.eventName,
      headSha: event.headSha,
      owner: event.owner,
      pullNumber: event.pullNumber,
      repo: event.repo,
      requestedReviewerLogin: event.requestedReviewerLogin,
      senderLogin: event.senderLogin,
    })
  }

}
