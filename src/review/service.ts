import { createChildLogger } from '../logger.js'
import type { AppLogger } from '../logger.js'
import type { CodexRunner } from './codex.js'
import type { ReviewPlatform, ReviewReaction } from './github-platform.js'
import type { NormalizedPullRequestEvent } from './webhook-event.js'
import type { PullRequestContext } from './types.js'
import type { ReviewWorkspaceManager } from './workspace.js'
import { ReviewQueueManager, type ActiveRunRef } from './review-queue.js'
import { buildPullRequestKey, routePullRequestEvent, toPullRequestContext } from './service-helpers.js'
import { reviewPullRequest } from './review-execution.js'

type ReviewServiceOptions = {
  approvedLockEnabled?: boolean
  discussionCacheDirectory?: string
  discussionCacheTtlMs?: number
}

const approvedIgnoredReason = 'approved_before'

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
    const routedEventByAction = routePullRequestEvent({
      actionKind: event.actionKind,
      botLogin: this.botLogin,
      requestedReviewerLogin: event.requestedReviewerLogin,
    })
    const routedEvent =
      routedEventByAction.status === 'trigger_review' &&
      (await this.isApprovedLocked(context, pullRequestKey, deliveryLogger))
        ? ({
            status: 'ignored',
            reason: approvedIgnoredReason,
          } as const)
        : routedEventByAction

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
      if (
        routedEvent.reason !== approvedIgnoredReason &&
        !this.queueManager.hasPendingReviewForPullRequest(pullRequestKey)
      ) {
        await this.setPullRequestReaction(
          context,
          'laugh',
          deliveryLogger,
          'ignored_event',
        )
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
    if (!this.approvedLockEnabled) {
      return false
    }

    if (this.approvedLockedPullRequests.has(pullRequestKey)) {
      return true
    }

    try {
      const priorSuccessfulReview = await this.github.getPriorSuccessfulReview(
        context,
      )

      if (priorSuccessfulReview.latestReviewState !== 'APPROVED') {
        return false
      }

      this.approvedLockedPullRequests.add(pullRequestKey)
      return true
    } catch (error) {
      deliveryLogger.warn(
        {
          error,
          event: 'review.approved_lock_lookup_failed',
          status: 'failed',
        },
        'Approved lock lookup failed',
      )
      return false
    }
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

  private async setPullRequestReaction(
    context: PullRequestContext,
    reaction: ReviewReaction,
    deliveryLogger: AppLogger,
    reason: string,
  ): Promise<void> {
    try {
      await this.github.setPullRequestReaction(context, reaction)
      deliveryLogger.info(
        {
          event: 'review.reaction_updated',
          reaction,
          reason,
          status: 'completed',
        },
        'Review reaction updated',
      )
    } catch (error) {
      deliveryLogger.warn(
        {
          error,
          event: 'review.reaction_failed',
          reaction,
          reason,
          status: 'failed',
        },
        'Review reaction update failed',
      )
    }
  }
}
