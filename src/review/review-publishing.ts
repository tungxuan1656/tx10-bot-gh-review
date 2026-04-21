import type { AppLogger } from '../logger.js'
import type { ActiveRun, ReviewQueueManager } from './review-queue.js'
import type { ReviewPlatform } from './github-platform.js'
import type { ReviewReaction } from './github-reactions.js'
import type { CodexReviewSuccess, PullRequestContext, ReviewableFile } from './types.js'
import {
  applyApprovedLock,
  buildReviewPublication,
  publishReviewWithFallback,
  resolveReviewCompletionReaction,
} from './review-publishing-helpers.js'

export async function setPullRequestReaction(input: {
  context: PullRequestContext
  deliveryLogger: AppLogger
  github: ReviewPlatform
  reaction: ReviewReaction
  reason: string
}): Promise<void> {
  try {
    await input.github.setPullRequestReaction(input.context, input.reaction)
    input.deliveryLogger.info(
      {
        event: 'review.reaction_updated',
        reaction: input.reaction,
        reason: input.reason,
        status: 'completed',
      },
      'Review reaction updated',
    )
  } catch (error) {
    input.deliveryLogger.warn(
      {
        error,
        event: 'review.reaction_failed',
        reaction: input.reaction,
        reason: input.reason,
        status: 'failed',
      },
      'Review reaction update failed',
    )
  }
}

export async function publishSuccessfulReview(input: {
  approvedLockEnabled: boolean
  approvedLockedPullRequests: Set<string>
  context: PullRequestContext
  deliveryId: string
  github: ReviewPlatform
  outcome: CodexReviewSuccess
  queueManager: ReviewQueueManager
  run: ActiveRun
  runLogger: AppLogger
  reviewableFiles: ReviewableFile[]
}): Promise<boolean> {
  const { body, comments, fallbackBody, overflowFindings, reviewEvent } =
    buildReviewPublication({
      context: input.context,
      deliveryId: input.deliveryId,
      outcome: input.outcome,
      reviewableFiles: input.reviewableFiles,
    })

  input.runLogger.info(
    {
      event: 'review.publish_started',
      inlineCommentCount: comments.length,
      overflowFindingCount: overflowFindings.length,
      reviewEvent,
      status: 'started',
    },
    'Review publish started',
  )

  if (
    input.queueManager.shouldStopForCancellation(
      input.runLogger,
      input.run,
      'before_publish',
    )
  ) {
    return false
  }

  const published = await publishReviewWithFallback({
    body,
    comments,
    context: input.context,
    fallbackBody,
    github: input.github,
    queueManager: input.queueManager,
    reviewEvent,
    run: input.run,
    runLogger: input.runLogger,
  })

  if (!published) {
    return false
  }

  await setPullRequestReaction({
    context: input.context,
    deliveryLogger: input.runLogger,
    github: input.github,
    reaction: resolveReviewCompletionReaction(reviewEvent),
    reason: 'review_published',
  })

  applyApprovedLock({
    approvedLockEnabled: input.approvedLockEnabled,
    approvedLockedPullRequests: input.approvedLockedPullRequests,
    context: input.context,
    reviewEvent,
    runLogger: input.runLogger,
  })

  return true
}
